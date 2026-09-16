import { beforeEach, describe, expect, it } from "vitest";

import {
  Registry,
  StorageConflictError,
  WorkflowEngine,
  buildIdempotencyKey,
  defineWorkflow,
  hashDefinition,
} from "../../src/index.js";
import type { StepHandler, WorkflowDefinition, WorkflowStorage } from "../../src/index.js";
import {
  CONFORMANCE_START,
  createClock,
  makeEvent,
  makeRun,
  makeSignal,
  makeStepRun,
  sequentialIds,
  type StorageHarness,
} from "./storage-fixtures.js";

/**
 * 一套断言，两个适配器。
 *
 * Memory 与 Postgres 必须表现完全一致，否则「用内存跑测试、用 Postgres 上生产」就是自欺欺人。
 */
export function describeStorageConformance(title: string, harness: StorageHarness): void {
  describe(title, () => {
    let storage: WorkflowStorage;
    const clock = createClock();
    const at = (): string => clock.now().toISOString();

    function definition(version = 1): WorkflowDefinition {
      return defineWorkflow({
        id: "test-workflow",
        version,
        start: "a",
        steps: { a: { uses: "test.a", next: "b" }, b: { uses: "test.b" } },
      });
    }

    beforeEach(async () => {
      clock.reset();
      await harness.reset?.();
      storage = await harness.create();

      // run 绑定 definition 是硬约束（Postgres 上有外键），所以每个 case 先把 v1 发出来。
      // 内容每次一样，所以这个 save 是幂等的。
      const seed = definition();
      await storage.definitions.save({ definition: seed, definitionHash: hashDefinition(seed) });
    });

    describe("definitions", () => {
      it("同版本同内容重复发布是幂等的", async () => {
        const def = definition();
        await storage.definitions.save({ definition: def, definitionHash: hashDefinition(def) });
        await storage.definitions.save({ definition: def, definitionHash: hashDefinition(def) });

        expect(await storage.definitions.listVersions("test-workflow")).toEqual([1]);
        expect(await storage.definitions.get("test-workflow", 1)).toEqual(def);
      });

      it("已发布版本不可修改：同版本不同内容直接报错", async () => {
        const first = definition(1);
        await storage.definitions.save({ definition: first, definitionHash: hashDefinition(first) });

        const mutated = defineWorkflow({
          id: "test-workflow",
          version: 1,
          start: "a",
          steps: { a: { uses: "test.a", next: "b" }, b: { uses: "test.changed" } },
        });

        await expect(
          storage.definitions.save({ definition: mutated, definitionHash: hashDefinition(mutated) }),
        ).rejects.toThrow(StorageConflictError);
      });

      it("getLatest 取最高版本，老版本仍然可取", async () => {
        for (const version of [1, 2, 3]) {
          const def = definition(version);
          await storage.definitions.save({ definition: def, definitionHash: hashDefinition(def) });
        }

        expect(await storage.definitions.listVersions("test-workflow")).toEqual([1, 2, 3]);
        expect((await storage.definitions.getLatest("test-workflow"))?.version).toBe(3);
        expect((await storage.definitions.get("test-workflow", 1))?.version).toBe(1);
        expect(await storage.definitions.get("test-workflow", 9)).toBeNull();
        expect(await storage.definitions.listWorkflowIds()).toEqual(["test-workflow"]);
      });
    });

    describe("runs", () => {
      it("create / get / 局部 update 都能落地", async () => {
        await storage.runs.create(makeRun("run-1", at(), { input: { intakeId: "INT-1" } }));

        await storage.runs.update("run-1", { status: "RUNNING", currentStepId: "a", currentStepRunId: "sr-1" });

        const run = await storage.runs.get("run-1");
        expect(run?.status).toBe("RUNNING");
        expect(run?.currentStepId).toBe("a");
        expect(run?.currentStepRunId).toBe("sr-1");
        expect(run?.input).toEqual({ intakeId: "INT-1" });
        // 没被 patch 到的字段不能丢
        expect(run?.workflowId).toBe("test-workflow");
        expect(run?.createdAt).toBe(at());
      });

      it("claim 是独占的：租期内别人抢不到", async () => {
        await storage.runs.create(makeRun("run-1", at()));
        await storage.runs.create(makeRun("run-2", at()));

        const claimedByA = await storage.runs.claimDue({ owner: "A", limit: 10, leaseMs: 30_000, now: at() });
        expect(claimedByA.map((item) => item.id)).toEqual(["run-1", "run-2"]);
        expect(claimedByA.every((item) => item.leaseOwner === "A")).toBe(true);
        // claim 不碰 status —— 状态由 engine 负责，这里必须还是 CREATED
        expect(claimedByA.every((item) => item.status === "CREATED")).toBe(true);

        expect(await storage.runs.claimDue({ owner: "B", limit: 10, leaseMs: 30_000, now: at() })).toEqual([]);
      });

      it("租期过期后别的 worker 可以接手（crash recovery 的基础）", async () => {
        await storage.runs.create(makeRun("run-1", at()));
        await storage.runs.claimDue({ owner: "A", limit: 1, leaseMs: 30_000, now: at() });

        clock.advance(30_001);
        const claimedByB = await storage.runs.claimDue({ owner: "B", limit: 10, leaseMs: 30_000, now: at() });

        expect(claimedByB.map((item) => item.id)).toEqual(["run-1"]);
        expect(claimedByB[0]?.leaseOwner).toBe("B");
      });

      it("wake_at 未到点的 run 不会被抢走；到点后可以", async () => {
        const wake = new Date(CONFORMANCE_START + 60_000).toISOString();
        await storage.runs.create(makeRun("delayed", at(), { status: "WAITING", wakeAt: wake }));

        expect(await storage.runs.claimDue({ owner: "A", limit: 10, leaseMs: 30_000, now: at() })).toEqual([]);

        clock.advance(60_001);
        const claimed = await storage.runs.claimDue({ owner: "A", limit: 10, leaseMs: 30_000, now: at() });
        expect(claimed.map((item) => item.id)).toEqual(["delayed"]);
      });

      it("等信号的 WAITING：没有信号抢不到；来了匹配的信号就能抢到", async () => {
        await storage.runs.create(makeRun("waiting", at(), { status: "WAITING", wakeAt: null }));
        await storage.steps.create(
          makeStepRun(at(), {
            id: "sr-wait",
            runId: "waiting",
            stepId: "approve",
            status: "WAITING",
            waitFor: "approval",
            output: undefined,
            patch: undefined,
          }),
        );
        await storage.runs.update("waiting", { currentStepId: "approve", currentStepRunId: "sr-wait" });

        // 没信号 → 抢不到（抢了也没信号可消费，只会空转）
        clock.advance(3_600_000);
        expect(await storage.runs.claimDue({ owner: "A", limit: 10, leaseMs: 30_000, now: at() })).toEqual([]);

        // 名字对不上 → 还是不抢
        await storage.signals.append(makeSignal(at(), { id: "s-payment", runId: "waiting", name: "payment" }));
        expect(await storage.runs.claimDue({ owner: "A", limit: 10, leaseMs: 30_000, now: at() })).toEqual([]);

        // 名字对上了 → 可抢（这也是 signal 没有崩溃窗口的原因：run 不需要被叫醒，它自己变成可抢）
        await storage.signals.append(makeSignal(at(), { id: "s-approval", runId: "waiting", name: "approval" }));
        const claimed = await storage.runs.claimDue({ owner: "A", limit: 10, leaseMs: 30_000, now: at() });
        expect(claimed.map((item) => item.id)).toEqual(["waiting"]);
      });

      it("续租只能续自己的；release 之后别人立刻能接手", async () => {
        await storage.runs.create(makeRun("run-1", at()));
        await storage.runs.claimDue({ owner: "A", limit: 1, leaseMs: 1_000, now: at() });

        expect(await storage.runs.renewLease("run-1", "B", 60_000, at())).toBe(false);
        expect(await storage.runs.renewLease("run-1", "A", 60_000, at())).toBe(true);

        await storage.runs.releaseLease("run-1", "A");
        const claimedByB = await storage.runs.claimDue({ owner: "B", limit: 1, leaseMs: 30_000, now: at() });
        expect(claimedByB.map((item) => item.id)).toEqual(["run-1"]);
      });

      it("listByStatus 能按状态捞回来", async () => {
        await storage.runs.create(makeRun("run-1", at(), { status: "FAILED" }));
        await storage.runs.create(makeRun("run-2", at(), { status: "RUNNING" }));

        const failed = await storage.runs.listByStatus("FAILED");
        expect(failed.map((item) => item.id)).toEqual(["run-1"]);
      });
    });

    describe("step runs", () => {
      it("幂等键能查回同一次业务动作", async () => {
        await storage.runs.create(makeRun("run-1", at()));
        await storage.steps.create(makeStepRun(at()));

        const found = await storage.steps.getByIdempotencyKey(buildIdempotencyKey("run-1", "a", 1));
        expect(found?.id).toBe("sr-1");
        expect(await storage.steps.getByIdempotencyKey(buildIdempotencyKey("run-1", "a", 2))).toBeNull();

        // 唯一约束是真约束：同一个 key 插两次会炸
        await expect(storage.steps.create(makeStepRun(at(), { id: "sr-2" }))).rejects.toThrow();
      });

      it("findLatest 取 visit 最大的那次；listByRun 是插入顺序", async () => {
        await storage.runs.create(makeRun("run-1", at()));
        await storage.steps.create(makeStepRun(at(), { id: "sr-1", visit: 1 }));
        clock.advance(1_000);
        await storage.steps.create(
          makeStepRun(at(), { id: "sr-2", visit: 2, idempotencyKey: buildIdempotencyKey("run-1", "a", 2) }),
        );
        clock.advance(1_000);
        await storage.steps.create(
          makeStepRun(at(), {
            id: "sr-3",
            stepId: "b",
            visit: 1,
            status: "FAILED",
            idempotencyKey: buildIdempotencyKey("run-1", "b", 1),
          }),
        );

        expect((await storage.steps.findLatest("run-1", "a"))?.id).toBe("sr-2");
        expect((await storage.steps.listByRun("run-1")).map((item) => item.id)).toEqual([
          "sr-1",
          "sr-2",
          "sr-3",
        ]);
        expect((await storage.steps.listByStatus("run-1", "FAILED")).map((item) => item.id)).toEqual(["sr-3"]);
        expect(await storage.steps.countByRun("run-1")).toBe(3);
      });

      it("update 是局部更新，patch 字段能存能取", async () => {
        await storage.runs.create(makeRun("run-1", at()));
        await storage.steps.create(makeStepRun(at(), { status: "RUNNING", patch: undefined }));

        await storage.steps.update("sr-1", { status: "COMPLETED", attempt: 2, patch: { a: 2 }, output: { y: 2 } });

        const stepRun = await storage.steps.get("sr-1");
        expect(stepRun?.status).toBe("COMPLETED");
        expect(stepRun?.attempt).toBe(2);
        expect(stepRun?.patch).toEqual({ a: 2 });
        expect(stepRun?.output).toEqual({ y: 2 });
        expect(stepRun?.visit).toBe(1);
      });
    });

    describe("signals", () => {
      beforeEach(async () => {
        await storage.runs.create(makeRun("run-1", at()));
      });

      it("同一条信号只能被消费一次（重复点两次 Approve 不会推进两次）", async () => {
        await storage.signals.append(makeSignal(at(), { id: "s-1" }));
        clock.advance(1_000);
        await storage.signals.append(makeSignal(at(), { id: "s-2" }));

        expect(await storage.signals.countPending("run-1")).toBe(2);

        const first = await storage.signals.consumeNext("run-1", "approval", at());
        expect(first?.id).toBe("s-1");
        expect(first?.consumedAt).not.toBeNull();

        const second = await storage.signals.consumeNext("run-1", "approval", at());
        expect(second?.id).toBe("s-2");

        expect(await storage.signals.consumeNext("run-1", "approval", at())).toBeNull();
        expect(await storage.signals.countPending("run-1")).toBe(0);
        expect((await storage.signals.listByRun("run-1")).map((item) => item.id)).toEqual(["s-1", "s-2"]);
      });

      it("按名字消费，别的名字不掺和", async () => {
        await storage.signals.append(makeSignal(at(), { id: "s-1", name: "approval" }));
        clock.advance(1_000);
        await storage.signals.append(makeSignal(at(), { id: "s-2", name: "payment" }));

        expect((await storage.signals.consumeNext("run-1", "payment", at()))?.id).toBe("s-2");
        expect((await storage.signals.consumeNext("run-1", "approval", at()))?.id).toBe("s-1");
      });
    });

    describe("events", () => {
      beforeEach(async () => {
        await storage.runs.create(makeRun("run-1", at()));
      });

      it("只追加，顺序 = 插入顺序，支持 limit / after 翻页", async () => {
        for (const id of ["e-1", "e-2", "e-3"]) {
          await storage.events.append(makeEvent(at(), { id }));
          clock.advance(1_000);
        }

        expect((await storage.events.listByRun("run-1")).map((item) => item.id)).toEqual(["e-1", "e-2", "e-3"]);
        expect((await storage.events.listByRun("run-1", { after: "e-1" })).map((item) => item.id)).toEqual([
          "e-2",
          "e-3",
        ]);
        expect((await storage.events.listByRun("run-1", { limit: 2 })).map((item) => item.id)).toEqual([
          "e-1",
          "e-2",
        ]);
      });
    });

    describe("engine 端到端", () => {
      it("A → B → C 跑通，事件与 step run 都落在库上", async () => {
        const registry = new Registry();
        registry.register({
          "test.a": passthrough("a"),
          "test.b": passthrough("b"),
          "test.c": passthrough("c"),
        });
        const engine = new WorkflowEngine({ storage, registry, now: clock.now, newId: sequentialIds("eng") });
        const linear = defineWorkflow({
          id: "conformance-linear",
          version: 1,
          start: "a",
          steps: {
            a: { uses: "test.a", next: "b" },
            b: { uses: "test.b", next: "c" },
            c: { uses: "test.c" },
          },
        });

        const run = await engine.start(linear, { input: { intakeId: "INT-1" } });
        const result = await engine.tick(run.id);

        expect(result).toEqual({ steps: 3, status: "COMPLETED" });
        const final = await engine.get(run.id);
        expect(final.context).toEqual({ a: 1, b: 2, c: 3 });
        expect((await storage.steps.listByRun(run.id)).map((item) => item.stepId)).toEqual(["a", "b", "c"]);
        expect((await storage.events.listByRun(run.id)).map((item) => item.type)).toEqual([
          "workflow.created",
          "workflow.started",
          "step.started",
          "step.completed",
          "step.started",
          "step.completed",
          "step.started",
          "step.completed",
          "workflow.completed",
        ]);
      });

      it("崩溃恢复：重启一个全新 engine，从指针继续，不重放副作用", async () => {
        const registry = new Registry();
        const calls: string[] = [];
        registry.register({
          "test.a": tracked("a", 1, calls),
          "test.b": tracked("b", 2, calls),
          "test.c": tracked("c", 3, calls),
        });
        const linear = defineWorkflow({
          id: "conformance-resume",
          version: 1,
          start: "a",
          steps: {
            a: { uses: "test.a", next: "b" },
            b: { uses: "test.b", next: "c" },
            c: { uses: "test.c" },
          },
        });

        const first = new WorkflowEngine({ storage, registry, now: clock.now, newId: sequentialIds("eng1") });
        const run = await first.start(linear);
        await first.tick(run.id);
        expect(calls).toEqual(["a", "b", "c"]);

        // 造出真实的崩溃窗口：最后一步 C 已经落库成功，但 run 还没来得及推进
        // （这就是「副作用已发生、状态还没记」的那一瞬间）
        const stepC = await storage.steps.getByIdempotencyKey(`${run.id}:c:1`);
        expect(stepC).toBeDefined();
        await storage.runs.update(run.id, {
          status: "RUNNING",
          currentStepId: "c",
          currentStepRunId: stepC?.id ?? null,
          context: {},
          completedAt: null,
        });

        // 「重启」：一个全新的 engine 实例，只靠数据库里的指针继续
        const second = new WorkflowEngine({ storage, registry, now: clock.now, newId: sequentialIds("eng2") });
        const recovered = await second.tick(run.id);

        expect(recovered.status).toBe("COMPLETED");
        expect(calls).toEqual(["a", "b", "c"]); // 副作用没有重放（C 没有被再调一次）
        // 状态被重放：C 的 patch 从 step run 里恢复回 context
        expect((await second.get(run.id)).context).toEqual({ c: 3 });
      });

      it("两个 worker 抢同一个 run：只有一个拿到 lease", async () => {
        const registry = new Registry();
        registry.register({ "test.a": passthrough("a"), "test.b": passthrough("b"), "test.c": passthrough("c") });
        const engine = new WorkflowEngine({ storage, registry, now: clock.now, newId: sequentialIds("eng") });
        const linear = defineWorkflow({
          id: "conformance-claim",
          version: 1,
          start: "a",
          steps: { a: { uses: "test.a", next: "b" }, b: { uses: "test.b", next: "c" }, c: { uses: "test.c" } },
        });
        const run = await engine.start(linear);

        const claims = await Promise.all([
          storage.runs.claimDue({ owner: "A", limit: 1, leaseMs: 30_000, now: at() }),
          storage.runs.claimDue({ owner: "B", limit: 1, leaseMs: 30_000, now: at() }),
        ]);

        const owners = claims.flat().map((item) => item.leaseOwner);
        expect(claims.flat().map((item) => item.id)).toEqual([run.id]);
        expect(owners).toHaveLength(1);
      });
    });
  });
}

function passthrough(stepId: string): StepHandler {
  const patch: Record<string, number> = { [stepId]: stepId.charCodeAt(0) - 96 };
  return {
    async execute() {
      return { status: "completed", output: { from: stepId }, patch };
    },
  };
}

function tracked(stepId: string, n: number, calls: string[]): StepHandler {
  return {
    async execute() {
      calls.push(stepId);
      return { status: "completed", output: { from: stepId }, patch: { [stepId]: n } };
    },
  };
}
