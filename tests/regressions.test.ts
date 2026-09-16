import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  LeaseManager,
  MemoryWorkflowStorage,
  Registry,
  ValidationError,
  WorkflowEngine,
  WorkflowWorker,
  defineWorkflow,
  type RunStore,
  type StepResult,
} from "../src/index.js";
import { createHarness, sleep, waiter } from "./support/harness.js";

/**
 * Review 回归测试 —— 每条对应一个真实修过的 bug，注释里写了「不修会怎样」。
 *
 * 这些用例的价值不在覆盖率，而在于：以后谁都别想悄悄把它们改回去。
 */

describe("回归: 心跳里的存储错误必须被吞掉（否则会杀掉进程）", () => {
  function brokenRuns(renew: () => Promise<boolean>): RunStore {
    return {
      claimDue: async () => [],
      renewLease: renew,
      releaseLease: async () => undefined,
    } as unknown as RunStore;
  }

  it("续租抛错 → onError 上报；连续失败到阈值才认为 lease 丢了", async () => {
    const errors: unknown[] = [];
    let lost = 0;
    const lease = new LeaseManager({
      runs: brokenRuns(async () => {
        throw new Error("数据库抽风");
      }),
      owner: "w",
      leaseMs: 1_000,
      renewIntervalMs: 5,
    });

    const stop = lease.startHeartbeat("run-1", {
      onError: (error) => errors.push(error),
      onLost: () => {
        lost += 1;
      },
      maxConsecutiveFailures: 3,
    });

    await sleep(80);
    stop();

    expect(errors.length).toBeGreaterThanOrEqual(DEFAULT_MAX_CONSECUTIVE_FAILURES);
    expect(lost).toBe(1); // 只报一次，且是连续失败到阈值之后
  });

  it("续租返回 false → 立刻认为 lease 丢了", async () => {
    let lost = 0;
    const lease = new LeaseManager({
      runs: brokenRuns(async () => false),
      owner: "w",
      leaseMs: 1_000,
      renewIntervalMs: 5,
    });

    const stop = lease.startHeartbeat("run-1", {
      onLost: () => {
        lost += 1;
      },
    });
    await sleep(30);
    stop();

    expect(lost).toBe(1);
  });
});

describe("回归: 陈旧/重复信号不能被后续的等待冒领", () => {
  it("连点两次 Approve，第二个信号不会被下一个 gate 吃掉", async () => {
    const h = createHarness();
    const flow = defineWorkflow({
      id: "two-gates",
      version: 1,
      start: "gate1",
      steps: {
        gate1: { uses: "human.approval", next: "work" },
        work: { uses: "test.work", next: "gate2" },
        gate2: { uses: "human.approval" },
      },
    });

    const seen: string[] = [];
    h.registry.register({
      "test.work": h.tracked("work"),
      "human.approval": {
        async execute({ stepId, resume }): Promise<StepResult> {
          if (resume === undefined) return { status: "waiting", waitFor: "approval" };
          seen.push(stepId);
          return { status: "completed" };
        },
      },
    });

    const run = await h.engine.start(flow);
    await h.worker.tick(); // gate1 等待

    // 手抖点了两次（或者上游重发了 webhook）
    await h.engine.signal(run.id, "approval", { click: 1 });
    await h.engine.signal(run.id, "approval", { click: 2 });

    await h.worker.tick(); // gate1 消费 click:1 → work → gate2 等待
    expect((await h.engine.get(run.id)).currentStepId).toBe("gate2");

    // 没有任何人批准过 gate2 —— 它不该自己往前走
    const noop = await h.worker.tick();
    expect(noop.claimed).toBe(0);
    expect((await h.engine.get(run.id)).status).toBe("WAITING");
    expect(seen).toEqual(["gate1"]);

    // 那个多出来的信号还在队列里（可见、可重发），没有被猜着消费
    expect(await h.storage.signals.countPending(run.id)).toBe(1);

    // 想让 gate2 过，就得**定向**投递给它
    await h.engine.signal(run.id, "approval", { gate: 2 }, { stepId: "gate2" });
    await h.worker.tick();

    expect((await h.engine.get(run.id)).status).toBe("COMPLETED");
    expect(seen).toEqual(["gate1", "gate2"]);
  });

  it("定向到不存在的 step 会被拒绝（打错名字和打错信号名一样致命）", async () => {
    const h = createHarness();
    h.registry.register({ "human.approval": waiter("approval") });
    const run = await h.engine.start(
      defineWorkflow({ id: "g", version: 1, start: "gate", steps: { gate: { uses: "human.approval" } } }),
    );

    await expect(h.engine.signal(run.id, "approval", {}, { stepId: "nope" })).rejects.toThrow(ValidationError);
  });
});

describe("回归: 非 JSON 结果必须记成干净的失败", () => {
  it("handler 返回循环引用 → run FAILED（不是 RangeError 逃出去 + 卡在 RUNNING）", async () => {
    const errors: unknown[] = [];
    const storage = new MemoryWorkflowStorage();
    const registry = new Registry();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    registry.register({
      "test.cycle": {
        async execute(): Promise<StepResult> {
          return { status: "completed", output: cyclic as never };
        },
      },
    });

    const engine = new WorkflowEngine({ storage, registry });
    const worker = new WorkflowWorker({ engine, owner: "w", onError: (error) => errors.push(error) });

    const run = await engine.start(
      defineWorkflow({ id: "cyclic", version: 1, start: "a", steps: { a: { uses: "test.cycle" } } }),
    );
    await worker.tick();

    const after = await engine.get(run.id);
    expect(errors).toEqual([]); // 没有异常逃到引擎外
    expect(after.status).toBe("FAILED");
    expect(after.error?.code).toBe("VALIDATION_ERROR");

    const stepRun = (await storage.steps.listByRun(run.id))[0];
    expect(stepRun?.status).toBe("FAILED");
    expect(stepRun?.error?.code).toBe("VALIDATION_ERROR");
  });

  it("isJsonValue 对自引用返回 false（而不是把递归栈打爆）", async () => {
    const { isJsonValue } = await import("../src/index.js");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expect(isJsonValue(cyclic)).toBe(false);
    expect(isJsonValue({ a: [1, { b: true }], c: null })).toBe(true);
  });
});

describe("回归: 非终态 run 没有 currentStepId 时必须报错", () => {
  it("不许静默从头重跑（那等于重复副作用）", async () => {
    const storage = new MemoryWorkflowStorage();
    const registry = new Registry();
    const calls: string[] = [];
    registry.register({
      "test.a": {
        async execute(): Promise<StepResult> {
          calls.push("a");
          return { status: "completed" };
        },
      },
    });
    const errors: unknown[] = [];
    const engine = new WorkflowEngine({ storage, registry });
    const worker = new WorkflowWorker({ engine, owner: "w", onError: (error) => errors.push(error) });

    const run = await engine.start(
      defineWorkflow({ id: "null-pointer", version: 1, start: "a", steps: { a: { uses: "test.a" } } }),
    );
    await storage.runs.update(run.id, { status: "RUNNING", currentStepId: null, currentStepRunId: null });

    await worker.tick();

    expect(calls).toEqual([]); // 一个 handler 都没跑
    expect(errors[0]).toBeInstanceOf(ValidationError);
  });
});

describe("回归: 等待重入不该吃掉重试预算", () => {
  it("maxAttempts=2 的步骤「等一次再失败」→ 仍然有一次重试", async () => {
    const h = createHarness();
    const flow = defineWorkflow({
      id: "wait-then-fail",
      version: 1,
      start: "gate",
      steps: {
        gate: { uses: "human.approval", retry: { maxAttempts: 2, initialDelayMs: 10, jitter: false } },
      },
    });

    const { WorkflowError } = await import("../src/index.js");
    let failedOnce = false;
    h.registry.register({
      "human.approval": {
        async execute({ resume }): Promise<StepResult> {
          if (resume === undefined) return { status: "waiting", waitFor: "approval" };
          if (!failedOnce) {
            failedOnce = true;
            return {
              status: "failed",
              error: new WorkflowError("第一次真失败", { code: "STEP_FAILED", retryable: true }),
            };
          }
          return { status: "completed" };
        },
      },
    });

    const run = await h.engine.start(flow);
    await h.worker.tick(); // 等待
    await h.engine.signal(run.id, "approval", { ok: true });

    await h.worker.tick(); // 唤醒 → 失败（第 1 次真失败）→ 还有重试预算
    expect((await h.engine.get(run.id)).status).toBe("RETRYING");

    h.advance(10);
    await h.worker.tick();

    const final = await h.engine.get(run.id);
    expect(final.status).toBe("COMPLETED");
    const stepRun = (await h.storage.steps.listByRun(run.id))[0];
    expect(stepRun?.attempt).toBe(3); // 3 次调用
    expect(stepRun?.failures).toBe(1); // 只真失败过 1 次
  });
});

describe("回归: engine limits 必须校验", () => {
  it("maxStepsPerTick = 0 直接拒绝构造", () => {
    const storage = new MemoryWorkflowStorage();
    expect(() => new WorkflowEngine({ storage, registry: new Registry(), limits: { maxStepsPerTick: 0 } })).toThrow(
      ValidationError,
    );
    expect(
      () => new WorkflowEngine({ storage, registry: new Registry(), limits: { maxStepsPerTick: 1.5 } }),
    ).toThrow(/maxStepsPerTick/);
  });
});

describe("回归: 直接调 engine.tick({owner}) 时，挂起也要交还 lease", () => {
  it("返回 WAITING 后 leaseOwner 必须是 null（与撞上限那条路径一致）", async () => {
    const storage = new MemoryWorkflowStorage();
    const registry = new Registry();
    registry.register({ "human.approval": waiter("approval") });
    const engine = new WorkflowEngine({ storage, registry });

    const run = await engine.start(
      defineWorkflow({ id: "wait-release", version: 1, start: "g", steps: { g: { uses: "human.approval" } } }),
    );

    await storage.runs.claimDue({ owner: "w", limit: 1, leaseMs: 60_000 });
    await engine.tick(run.id, { owner: "w", leaseMs: 60_000 });

    const after = await engine.get(run.id);
    expect(after.status).toBe("WAITING");
    expect(after.leaseOwner).toBeNull();
  });
});

describe("回归: 永久 FAILED 的 run 也能被人工救回来", () => {
  it("重试耗尽的 FAILED → reconcile(retry) → 同幂等键重跑并跑完", async () => {
    const h = createHarness();
    const { WorkflowError } = await import("../src/index.js");
    let failUntil = 2;
    h.registry.register({
      "test.flaky": {
        async execute(): Promise<StepResult> {
          if (failUntil > 0) {
            failUntil -= 1;
            return { status: "failed", error: new WorkflowError("下游挂了", { code: "STEP_FAILED", retryable: true }) };
          }
          return { status: "completed", patch: { recovered: true } };
        },
      },
    });

    const run = await h.engine.start(
      defineWorkflow({
        id: "reconcile-failed",
        version: 1,
        start: "a",
        steps: { a: { uses: "test.flaky", retry: { maxAttempts: 2, initialDelayMs: 1, jitter: false } } },
      }),
    );

    // 跑到永久失败
    await h.worker.tick();
    h.advance(1);
    await h.worker.tick();
    const failed = await h.engine.get(run.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.error?.code).toBe("STEP_FAILED");

    const stepRunBefore = (await h.storage.steps.listByRun(run.id))[0];
    expect(stepRunBefore?.failures).toBe(2);
    expect(stepRunBefore?.idempotencyKey).toBe(`${run.id}:a:1`);

    // 运维修好了下游 → 人工重试
    expect((await h.engine.reconcile(run.id, "retry")).status).toBe("RUNNING");
    await h.worker.tick();

    const final = await h.engine.get(run.id);
    expect(final.status).toBe("COMPLETED");
    expect(final.context).toEqual({ recovered: true });

    // 同一条 step run、同一个幂等键 —— 下游才能去重
    const stepRuns = await h.storage.steps.listByRun(run.id);
    expect(stepRuns).toHaveLength(1);
    expect(stepRuns[0]?.idempotencyKey).toBe(`${run.id}:a:1`);
    expect(stepRuns[0]?.attempt).toBe(3);
    expect(stepRuns[0]?.failures).toBe(0); // 人工重试复位了失败计数

    const events = (await h.storage.events.listByRun(run.id)).map((item) => item.type);
    expect(events).toContain("workflow.resumed");
  });

  it("人工重试之后，自动重试策略重新生效", async () => {
    const h = createHarness();
    const { WorkflowError } = await import("../src/index.js");
    let failures = 0;
    h.registry.register({
      "test.once": {
        async execute(): Promise<StepResult> {
          failures += 1;
          // 第 1、2 次失败（maxAttempts=2 用完 → 永久失败），第 3 次成功
          if (failures <= 2) {
            return { status: "failed", error: new WorkflowError("挂了", { code: "STEP_FAILED", retryable: true }) };
          }
          return { status: "completed" };
        },
      },
    });

    const run = await h.engine.start(
      defineWorkflow({
        id: "reconcile-budget",
        version: 1,
        start: "a",
        steps: { a: { uses: "test.once", retry: { maxAttempts: 2, initialDelayMs: 1, jitter: false } } },
      }),
    );

    await h.worker.tick(); // 第 1 次失败 → RETRYING
    h.advance(1);
    await h.worker.tick(); // 第 2 次失败 → FAILED（预算用完）
    expect((await h.engine.get(run.id)).status).toBe("FAILED");

    await h.engine.reconcile(run.id, "retry");
    await h.worker.tick(); // 第 3 次 → 成功

    expect((await h.engine.get(run.id)).status).toBe("COMPLETED");
    expect(failures).toBe(3);
  });

  it("abandon 也能用在永久失败上，并保留原来的错误码供审计", async () => {
    const h = createHarness();
    const { WorkflowError } = await import("../src/index.js");
    h.registry.register({
      "test.dead": {
        async execute(): Promise<StepResult> {
          return { status: "failed", error: new WorkflowError("没救了", { code: "STEP_FAILED" }) };
        },
      },
    });

    const run = await h.engine.start(
      defineWorkflow({ id: "reconcile-abandon", version: 1, start: "a", steps: { a: { uses: "test.dead" } } }),
    );
    await h.worker.tick();
    expect((await h.engine.get(run.id)).status).toBe("FAILED");

    const abandoned = await h.engine.reconcile(run.id, "abandon");
    expect(abandoned.status).toBe("CANCELLED");
    expect(abandoned.error?.code).toBe("STEP_FAILED"); // 审计保留

    const cancelled = (await h.storage.events.listByRun(run.id)).filter(
      (item) => item.type === "workflow.cancelled",
    );
    expect(cancelled[0]?.payload["previousCode"]).toBe("STEP_FAILED");
  });

  it("没失败的 run 不允许 reconcile", async () => {
    const h = createHarness();
    h.registry.register({ "test.ok": h.tracked("ok") });
    const run = await h.engine.start(
      defineWorkflow({ id: "reconcile-guard", version: 1, start: "a", steps: { a: { uses: "test.ok" } } }),
    );
    await h.worker.tick();

    await expect(h.engine.reconcile(run.id, "retry")).rejects.toThrow(/不接受该操作/);
  });
});

describe("优化回归: publish / definition 缓存不能改变语义", () => {
  it("同一份 definition 重复发布只写一次库（但内容不同仍然报冲突）", async () => {
    const h = createHarness();
    h.registry.register({ "test.a": h.tracked("a") });

    let saves = 0;
    const original = h.storage.definitions.save.bind(h.storage.definitions);
    h.storage.definitions.save = async (input) => {
      saves += 1;
      return original(input);
    };

    const definition = defineWorkflow({
      id: "cached-publish",
      version: 1,
      start: "a",
      steps: { a: { uses: "test.a" } },
    });

    await h.engine.start(definition);
    await h.engine.start(definition);
    await h.engine.start(definition);
    expect(saves).toBe(1); // 后两次命中缓存

    // 同版本不同内容 → 依然要走库，让 storage 抛冲突
    const changed = defineWorkflow({
      id: "cached-publish",
      version: 1,
      start: "a",
      steps: { a: { uses: "test.a", meta: { title: "改了" } } },
    });
    await expect(h.engine.start(changed)).rejects.toThrow(/已发布/);
    expect(saves).toBe(2);

    // 新版本照常发布
    const v2 = defineWorkflow({
      id: "cached-publish",
      version: 2,
      start: "a",
      steps: { a: { uses: "test.a" } },
    });
    await h.engine.publish(v2);
    expect(saves).toBe(3);
  });

  it("definition 读取走缓存：连续 tick 不会再查库", async () => {
    const h = createHarness();
    h.registry.register({ "test.a": h.tracked("a") });
    const definition = defineWorkflow({
      id: "cached-definition",
      version: 1,
      start: "a",
      steps: { a: { uses: "test.a", next: "b" }, b: { uses: "test.b" } },
    });
    h.registry.register({ "test.b": h.tracked("b") });

    const run = await h.engine.start(definition);

    let reads = 0;
    const original = h.storage.definitions.get.bind(h.storage.definitions);
    h.storage.definitions.get = async (workflowId, version) => {
      reads += 1;
      return original(workflowId, version);
    };

    await h.engine.tick(run.id);
    await h.engine.tick(run.id);
    expect(reads).toBe(0); // publish 时已经缓存了
  });
});

describe("回归: 事件游标不存在时必须报错（两个适配器一致）", () => {
  it("memory：抛 ValidationError，而不是返回全部", async () => {
    const storage = new MemoryWorkflowStorage();
    const at = "2026-01-01T00:00:00.000Z";
    await storage.runs.create({
      id: "r",
      workflowId: "w",
      workflowVersion: 1,
      status: "CREATED",
      input: undefined,
      context: {},
      currentStepId: null,
      currentStepRunId: null,
      wakeAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      error: null,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    });
    await storage.events.append({
      id: "e1",
      runId: "r",
      stepId: null,
      type: "workflow.started",
      payload: {},
      createdAt: at,
    });

    await expect(storage.events.listByRun("r", { after: "nope" })).rejects.toThrow(ValidationError);
    expect((await storage.events.listByRun("r", { after: "e1" })).length).toBe(0);
  });
});
