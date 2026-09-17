import { beforeEach, describe, expect, it } from "vitest";

import {
  Registry,
  SCHEMA_VERSION,
  StorageConflictError,
  WorkflowEngine,
  buildIdempotencyKey,
  defineWorkflow,
  hashDefinition,
} from "../../src/index.js";
import type { ConsumeSignalInput } from "../../src/storage/interface.js";
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
        await storage.runs.create(makeRun("run-1", at(), { input: { orderId: "ORD-1" } }));

        await storage.runs.update("run-1", { status: "RUNNING", currentStepId: "a", currentStepRunId: "sr-1" });

        const run = await storage.runs.get("run-1");
        expect(run?.status).toBe("RUNNING");
        expect(run?.currentStepId).toBe("a");
        expect(run?.currentStepRunId).toBe("sr-1");
        expect(run?.input).toEqual({ orderId: "ORD-1" });
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

      it("等信号的 WAITING：只有「可用」的信号才让它可抢", async () => {
        await storage.runs.create(makeRun("waiting", at(), { status: "WAITING", wakeAt: null }));
        await storage.steps.create(
          makeStepRun(at(), {
            id: "sr-wait",
            runId: "waiting",
            stepId: "approve",
            status: "WAITING",
            waitFor: "approval",
            waitSinceSeq: 0,
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

        // 名字对上但「入队在等待之前」且未定向 → 依然不抢（否则就是陈旧信号冒领）
        const stale = await storage.signals.append(
          makeSignal(at(), { id: "s-stale", runId: "waiting", name: "approval" }),
        );
        await storage.steps.update("sr-wait", { waitSinceSeq: stale.seq });
        expect(await storage.runs.claimDue({ owner: "A", limit: 10, leaseMs: 30_000, now: at() })).toEqual([]);

        // 等待开始之后入队的信号 → 可抢（这也是 signal 没有崩溃窗口的原因：run 自己变成可抢）
        await storage.signals.append(makeSignal(at(), { id: "s-approval", runId: "waiting", name: "approval" }));
        const claimed = await storage.runs.claimDue({ owner: "A", limit: 10, leaseMs: 30_000, now: at() });
        expect(claimed.map((item) => item.id)).toEqual(["waiting"]);
      });

      it("定向给这个 step 的信号即使入队更早，也让它可抢", async () => {
        await storage.runs.create(makeRun("waiting2", at(), { status: "WAITING", wakeAt: null }));
        await storage.steps.create(
          makeStepRun(at(), {
            id: "sr-wait2",
            runId: "waiting2",
            stepId: "approve",
            status: "WAITING",
            waitFor: "approval",
            waitSinceSeq: 0,
            output: undefined,
            patch: undefined,
          }),
        );
        await storage.runs.update("waiting2", { currentStepId: "approve", currentStepRunId: "sr-wait2" });

        const targeted = await storage.signals.append(
          makeSignal(at(), { id: "s-targeted", runId: "waiting2", name: "approval", stepId: "approve" }),
        );
        await storage.steps.update("sr-wait2", { waitSinceSeq: targeted.seq });

        clock.advance(1_000);
        const claimed = await storage.runs.claimDue({ owner: "A", limit: 10, leaseMs: 30_000, now: at() });
        expect(claimed.map((item) => item.id)).toEqual(["waiting2"]);
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

      it("保留策略：只删「终态 + 已完成」的旧 run，连带 step run / signal / event", async () => {
        const old = at();
        clock.advance(10_000);
        const recent = at();

        // 三个 run：一个很早就完成、一个刚完成、一个还在跑
        await storage.runs.create(
          makeRun("old-done", old, { status: "COMPLETED", completedAt: old }),
        );
        await storage.runs.create(makeRun("new-done", recent, { status: "FAILED", completedAt: recent }));
        await storage.runs.create(makeRun("running", old, { status: "RUNNING" }));
        await storage.steps.create(makeStepRun(old, { id: "sr-old", runId: "old-done" }));
        await storage.signals.append(makeSignal(old, { id: "sig-old", runId: "old-done" }));
        await storage.events.append(makeEvent(old, { id: "ev-old", runId: "old-done" }));

        const cutoff = new Date(CONFORMANCE_START + 5_000).toISOString();
        expect(await storage.runs.deleteTerminalBefore(cutoff)).toBe(1);

        expect(await storage.runs.get("old-done")).toBeNull();
        expect(await storage.steps.get("sr-old")).toBeNull();
        expect(await storage.signals.listByRun("old-done")).toEqual([]);
        await expect(storage.events.listByRun("old-done")).resolves.toEqual([]);
        // 幂等键索引也要跟着清掉，否则同一个 key 以后插不进来
        expect(await storage.steps.getByIdempotencyKey("run-1:a:1")).toBeNull();

        // 新的终态 & 还在跑的都留着
        expect(await storage.runs.get("new-done")).not.toBeNull();
        expect(await storage.runs.get("running")).not.toBeNull();
      });

      it("保留策略支持 limit 分批删", async () => {
        const old = at();
        for (const id of ["r-1", "r-2", "r-3"]) {
          await storage.runs.create(makeRun(id, old, { status: "COMPLETED", completedAt: old }));
        }
        clock.advance(1_000);

        expect(await storage.runs.deleteTerminalBefore(at(), 2)).toBe(2);
        expect(await storage.runs.deleteTerminalBefore(at(), 2)).toBe(1);
        expect(await storage.runs.listByStatus("COMPLETED")).toEqual([]);
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

      it("等待相关的字段（waitFor / waitSinceSeq / waitPayload）能存能取", async () => {
        await storage.runs.create(makeRun("run-1", at()));
        await storage.steps.create(
          makeStepRun(at(), { status: "WAITING", waitFor: "approval", waitSinceSeq: 7, waitPayload: { by: "gery" } }),
        );

        const stepRun = await storage.steps.get("sr-1");
        expect(stepRun?.waitFor).toBe("approval");
        expect(stepRun?.waitSinceSeq).toBe(7);
        expect(stepRun?.waitPayload).toEqual({ by: "gery" });
      });

      it("failures 计数与 attempt 分开存", async () => {
        await storage.runs.create(makeRun("run-1", at()));
        await storage.steps.create(makeStepRun(at(), { attempt: 3, failures: 2 }));

        expect((await storage.steps.get("sr-1"))?.failures).toBe(2);
        await storage.steps.update("sr-1", { failures: 3 });
        expect((await storage.steps.get("sr-1"))?.failures).toBe(3);
      });
    });

    describe("signals", () => {
      beforeEach(async () => {
        await storage.runs.create(makeRun("run-1", at()));
      });

      /** 一次等待：`sinceSeq` 是水位线（入队序号 <= 它的信号都算「等待之前来的」） */
      function wait(sinceSeq: number, stepId = "approve"): ConsumeSignalInput {
        return { runId: "run-1", name: "approval", stepId, sinceSeq, now: at() };
      }

      it("append 会分配单调递增的 seq，watermark 跟着涨", async () => {
        expect(await storage.signals.watermark("run-1")).toBe(0);

        const first = await storage.signals.append(makeSignal(at(), { id: "s-1" }));
        clock.advance(1_000);
        const second = await storage.signals.append(makeSignal(at(), { id: "s-2" }));

        expect(second.seq).toBeGreaterThan(first.seq);
        expect(await storage.signals.watermark("run-1")).toBe(second.seq);
      });

      it("同一条信号只能被消费一次（重复点两次 Approve 不会推进两次）", async () => {
        await storage.signals.append(makeSignal(at(), { id: "s-1" }));
        clock.advance(1_000);
        await storage.signals.append(makeSignal(at(), { id: "s-2" }));
        const sinceSeq = 0; // 等待从最开始就登记着

        expect(await storage.signals.countPending("run-1")).toBe(2);

        const first = await storage.signals.consumeNext(wait(sinceSeq));
        expect(first?.id).toBe("s-1");
        expect(first?.consumedAt).not.toBeNull();

        const second = await storage.signals.consumeNext(wait(sinceSeq));
        expect(second?.id).toBe("s-2");

        expect(await storage.signals.consumeNext(wait(sinceSeq))).toBeNull();
        expect(await storage.signals.countPending("run-1")).toBe(0);
        expect((await storage.signals.listByRun("run-1")).map((item) => item.id)).toEqual(["s-1", "s-2"]);
      });

      it("按名字消费，别的名字不掺和", async () => {
        await storage.signals.append(makeSignal(at(), { id: "s-1", name: "approval" }));
        clock.advance(1_000);
        await storage.signals.append(makeSignal(at(), { id: "s-2", name: "payment" }));

        expect((await storage.signals.consumeNext({ ...wait(0), name: "payment" }))?.id).toBe("s-2");
        expect((await storage.signals.consumeNext(wait(0)))?.id).toBe("s-1");
      });

      it("未定向 + 入队在等待之前的信号**不会被冒领**（这就是那个 P0 bug）", async () => {
        // 信号先到（人类手抖点了两次 / 上游重发了 webhook）
        const stale = await storage.signals.append(makeSignal(at(), { id: "stale" }));
        clock.advance(1_000);

        // 这次等待登记时水位线已经包含它了 → 不消费
        expect(await storage.signals.consumeNext(wait(stale.seq))).toBeNull();
        // 它还留在队列里（可见、可重发），而不是被猜着消费掉
        expect(await storage.signals.countPending("run-1")).toBe(1);

        // 等待开始之后入队的那条才能被消费
        await storage.signals.append(makeSignal(at(), { id: "fresh" }));
        expect((await storage.signals.consumeNext(wait(stale.seq)))?.id).toBe("fresh");
        expect(await storage.signals.countPending("run-1")).toBe(1);
      });

      it("定向信号不受水位线限制（发送者明确说了给哪个 step）", async () => {
        const targeted = await storage.signals.append(makeSignal(at(), { id: "targeted", stepId: "approve" }));

        expect((await storage.signals.consumeNext(wait(targeted.seq)))?.id).toBe("targeted");
      });

      it("定向给别的 step 的信号不会被这次等待消费", async () => {
        const other = await storage.signals.append(makeSignal(at(), { id: "other", stepId: "gate-2" }));

        expect(await storage.signals.consumeNext(wait(other.seq, "gate-1"))).toBeNull();
        expect((await storage.signals.consumeNext(wait(other.seq, "gate-2")))?.id).toBe("other");
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

      it("游标不存在 → 报错，而不是默默返回全部/返回空", async () => {
        await storage.events.append(makeEvent(at(), { id: "e-1" }));

        await expect(storage.events.listByRun("run-1", { after: "不存在的游标" })).rejects.toThrow(/游标/);
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

        const run = await engine.start(linear, { input: { orderId: "ORD-1" } });
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

      it("schemaVersion 在 migrate 之后是一致的", async () => {
        await storage.migrate();
        expect(await storage.schemaVersion()).toBe(SCHEMA_VERSION);
      });

      // 注意：对 memory 来说这是**顺序执行**（单线程），证明不了真并发；
      // 真正的并发抢占测试在 tests/postgres.test.ts（多连接 + FOR UPDATE SKIP LOCKED）。
      // 这里保留它只是为了「同一套断言」的完整性 —— 两边至少不能出现「都抢到」。
      it("两个 worker 抢同一个 run：只有一个拿到 lease（memory 上是顺序的，真并发见 pg 套件）", async () => {
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
