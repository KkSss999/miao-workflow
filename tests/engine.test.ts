import { describe, expect, it } from "vitest";

import {
  MemoryWorkflowStorage,
  Registry,
  UnknownOutcomeError,
  ValidationError,
  WorkflowEngine,
  WorkflowError,
  defineWorkflow,
  type StepExecutionContext,
  type StepHandler,
  type StepResult,
} from "../src/index.js";

/**
 * Phase A 验收：顺序执行、条件分支、版本绑定、崩溃恢复不重放副作用、防死循环。
 *
 * Storage 用 MemoryWorkflowStorage（语义与 Postgres 对齐），时钟与随机源都注入，
 * 所以整个测试是确定性的 —— 不 sleep、不等真时间。
 */

interface Harness {
  engine: WorkflowEngine;
  registry: Registry;
  storage: MemoryWorkflowStorage;
  calls: string[];
  advance: (ms: number) => void;
}

function harness(options: { maxStepsPerTick?: number } = {}): Harness {
  let current = new Date("2026-01-01T00:00:00.000Z");
  let seq = 0;
  const newId = (): string => `id-${++seq}`;
  const storage = new MemoryWorkflowStorage({ now: () => current, newId });
  const registry = new Registry();
  const engine = new WorkflowEngine({
    storage,
    registry,
    now: () => current,
    newId,
    random: () => 0.5,
    ...(options.maxStepsPerTick === undefined
      ? {}
      : { limits: { maxStepsPerTick: options.maxStepsPerTick } }),
  });
  const calls: string[] = [];

  return {
    engine,
    registry,
    storage,
    calls,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

function handler(
  fn: (context: StepExecutionContext) => Promise<StepResult<unknown>> | StepResult<unknown>,
): StepHandler {
  return { execute: async (context) => fn(context) };
}

const linear = defineWorkflow({
  id: "linear",
  version: 1,
  start: "a",
  steps: {
    a: { uses: "test.a", next: "b" },
    b: { uses: "test.b", next: "c" },
    c: { uses: "test.c" },
  },
});

describe("Phase A: 顺序执行", () => {
  it("A → B → C 跑完，context 由每步 patch 累积起来", async () => {
    const { engine, registry, storage } = harness();
    registry.register({
      "test.a": handler(({ input }) => ({
        status: "completed",
        output: { from: "a", gotInput: input },
        patch: { a: 1 },
      })),
      "test.b": handler(({ input, context }) => ({
        status: "completed",
        output: { from: "b", sawA: input, sawPatch: context["a"] },
        patch: { b: 2 },
      })),
      "test.c": handler(() => ({ status: "completed", patch: { c: 3 } })),
    });

    const run = await engine.start(linear, { input: { intakeId: "INT-1" } });
    expect(run.status).toBe("CREATED");
    expect(run.currentStepId).toBe("a");
    expect(run.currentStepRunId).toBeNull();

    const result = await engine.tick(run.id);
    expect(result).toEqual({ steps: 3, status: "COMPLETED" });

    const final = await engine.get(run.id);
    expect(final.status).toBe("COMPLETED");
    expect(final.context).toEqual({ a: 1, b: 2, c: 3 });
    expect(final.currentStepId).toBeNull();
    expect(final.currentStepRunId).toBeNull();
    expect(final.completedAt).not.toBeNull();

    // B 拿到的 input 是 A 的 output，且能看到 A 写进 context 的 patch
    const stepRuns = await storage.steps.listByRun(run.id);
    expect(stepRuns.map((item) => item.stepId)).toEqual(["a", "b", "c"]);
    // 首个 step 的 input 是 run.input，之后的 input 是上一步的 output
    expect(stepRuns[0]?.input).toEqual({ intakeId: "INT-1" });
    expect(stepRuns[1]?.input).toEqual({ from: "a", gotInput: { intakeId: "INT-1" } });
    expect(stepRuns[1]?.output).toEqual({
      from: "b",
      sawA: { from: "a", gotInput: { intakeId: "INT-1" } },
      sawPatch: 1,
    });
  });

  it("幂等键是 runId:stepId:visit", async () => {
    const { engine, registry, storage } = harness();
    registry.register({
      "test.a": handler(() => ({ status: "completed" })),
      "test.b": handler(() => ({ status: "completed" })),
      "test.c": handler(() => ({ status: "completed" })),
    });

    const run = await engine.start(linear);
    await engine.tick(run.id);

    const stepRuns = await storage.steps.listByRun(run.id);
    expect(stepRuns.map((item) => item.idempotencyKey)).toEqual([
      `${run.id}:a:1`,
      `${run.id}:b:1`,
      `${run.id}:c:1`,
    ]);
    expect(new Set(stepRuns.map((item) => item.idempotencyKey)).size).toBe(3);
  });

  it("事件流是完整的时间线（审计来源）", async () => {
    const { engine, registry, storage } = harness();
    registry.register({
      "test.a": handler(() => ({ status: "completed" })),
      "test.b": handler(() => ({ status: "completed" })),
      "test.c": handler(() => ({ status: "completed" })),
    });

    const run = await engine.start(linear);
    await engine.tick(run.id);

    const events = await storage.events.listByRun(run.id);
    expect(events.map((item) => item.type)).toEqual([
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
    expect(events.filter((item) => item.stepId !== null).map((item) => item.stepId)).toEqual([
      "a",
      "a",
      "b",
      "b",
      "c",
      "c",
    ]);
  });
});

describe("Phase A: 条件分支", () => {
  const branchy = defineWorkflow({
    id: "branchy",
    version: 1,
    start: "triage",
    steps: {
      triage: {
        uses: "test.triage",
        next: [{ to: "manual-review", when: "confidence.low" }, { to: "approval" }],
      },
      "manual-review": { uses: "test.manual", next: "approval" },
      approval: { uses: "test.approval" },
    },
  });

  function setup(): Harness {
    const h = harness();
    h.registry.register({
      "test.triage": handler(({ input }) => ({
        status: "completed",
        output: { confidence: Number((input as { confidence: number }).confidence) },
        patch: { confidence: Number((input as { confidence: number }).confidence) },
      })),
      "test.manual": handler(() => {
        h.calls.push("manual-review");
        return { status: "completed" };
      }),
      "test.approval": handler(() => {
        h.calls.push("approval");
        return { status: "completed" };
      }),
    });
    h.registry.guard("confidence.low", ({ context }) => Number(context["confidence"] ?? 1) < 0.75);
    return h;
  }

  it("低置信度走人工复核", async () => {
    const h = setup();
    const run = await h.engine.start(branchy, { input: { confidence: 0.3 } });
    await h.engine.tick(run.id);

    expect(h.calls).toEqual(["manual-review", "approval"]);
    const stepRuns = await h.storage.steps.listByRun(run.id);
    expect(stepRuns.map((item) => item.stepId)).toEqual(["triage", "manual-review", "approval"]);
  });

  it("高置信度直接进审批", async () => {
    const h = setup();
    const run = await h.engine.start(branchy, { input: { confidence: 0.95 } });
    await h.engine.tick(run.id);

    expect(h.calls).toEqual(["approval"]);
    const stepRuns = await h.storage.steps.listByRun(run.id);
    expect(stepRuns.map((item) => item.stepId)).toEqual(["triage", "approval"]);
  });
});

describe("Phase A: 版本绑定", () => {
  it("老 run 永远跑它绑定的版本，发布 v2 不影响它", async () => {
    const h = harness();
    h.registry.register({
      "test.a": handler(() => ({ status: "completed" })),
      "test.b": handler(() => {
        h.calls.push("v1-handler");
        return { status: "completed" };
      }),
      "test.b2": handler(() => {
        h.calls.push("v2-handler");
        return { status: "completed" };
      }),
    });

    const v1 = defineWorkflow({
      id: "versioned",
      version: 1,
      start: "a",
      steps: { a: { uses: "test.a", next: "b" }, b: { uses: "test.b" } },
    });
    const v2 = defineWorkflow({
      id: "versioned",
      version: 2,
      start: "a",
      steps: { a: { uses: "test.a", next: "b" }, b: { uses: "test.b2" } },
    });

    const run = await h.engine.start(v1);
    await h.engine.publish(v2);

    await h.engine.tick(run.id);

    expect(h.calls).toEqual(["v1-handler"]);
    expect((await h.engine.get(run.id)).workflowVersion).toBe(1);
    // 新 run 才用 v2
    const newRun = await h.engine.start("versioned");
    expect(newRun.workflowVersion).toBe(2);
    await h.engine.tick(newRun.id);
    expect(h.calls).toEqual(["v1-handler", "v2-handler"]);
  });

  it("未发布的 workflow 起 run 会报错", async () => {
    const h = harness();
    await expect(h.engine.start("nope")).rejects.toThrow(/还没发布/);
  });
});

describe("Phase A: 崩溃恢复不重放副作用", () => {
  it("step 已落库但 run 还没推进时崩溃 → 不重复执行，patch 从 step run 重放", async () => {
    const h = harness();
    h.registry.register({
      "test.a": handler(() => {
        h.calls.push("a");
        return { status: "completed", output: { from: "a" }, patch: { a: 1 } };
      }),
      "test.b": handler(() => {
        h.calls.push("b");
        return { status: "completed", output: { from: "b" }, patch: { b: 2 } };
      }),
      "test.c": handler(() => {
        h.calls.push("c");
        return { status: "completed", patch: { c: 3 } };
      }),
    });

    const run = await h.engine.start(linear, { input: { intakeId: "INT-1" } });

    // 造出崩溃现场：A 已经落库成功，但 run 还没推进（context 也还没写）
    const at = "2026-01-01T00:00:00.000Z";
    await h.storage.steps.create({
      id: "step-run-a",
      runId: run.id,
      stepId: "a",
      status: "COMPLETED",
      attempt: 1,
      visit: 1,
      input: { intakeId: "INT-1" },
      output: { from: "a" },
      patch: { a: 1 },
      error: null,
      waitFor: null,
      idempotencyKey: `${run.id}:a:1`,
      startedAt: at,
      finishedAt: at,
      wakeAt: null,
      createdAt: at,
      updatedAt: at,
    });
    await h.storage.runs.update(run.id, {
      status: "RUNNING",
      currentStepId: "a",
      currentStepRunId: "step-run-a",
    });

    const recovered = await h.engine.tick(run.id);

    expect(recovered.status).toBe("COMPLETED");
    // A 的副作用没有被重放
    expect(h.calls).toEqual(["b", "c"]);
    // 但状态被完整重建：A 的 patch 从 step run 里重放出来
    expect((await h.engine.get(run.id)).context).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("指针悬空（写下指针后、step run 落库前崩了）→ 复用同一个 id 与幂等键", async () => {
    const h = harness();
    h.registry.register({
      "test.a": handler(({ idempotencyKey }) => {
        h.calls.push(idempotencyKey);
        return { status: "completed", output: { from: "a" }, patch: { a: 1 } };
      }),
      "test.b": handler(() => ({ status: "completed" })),
      "test.c": handler(() => ({ status: "completed" })),
    });

    const run = await h.engine.start(linear);
    // 模拟：engine 已经把「我正要做这个」写进 run，然后进程就死了（记录还没落库）
    await h.storage.runs.update(run.id, {
      status: "RUNNING",
      currentStepRunId: "ghost-step-run",
    });

    const resumed = await h.engine.tick(run.id);
    expect(resumed.status).toBe("COMPLETED");

    // 幂等键仍然是 :1 —— 崩溃前后不变，外部服务才不会重复执行
    expect(h.calls[0]).toBe(`${run.id}:a:1`);
    const ghost = await h.storage.steps.get("ghost-step-run");
    expect(ghost?.idempotencyKey).toBe(`${run.id}:a:1`);
    expect(ghost?.status).toBe("COMPLETED");
  });
});

describe("Phase A: 防死循环", () => {
  const cycle = defineWorkflow({
    id: "cycle",
    version: 1,
    start: "a",
    steps: {
      a: { uses: "test.a", next: "b" },
      b: { uses: "test.b", next: "a" },
    },
  });

  it("撞到 maxStepsPerTick 就交回队列，而不是把 CPU 吃穿", async () => {
    const h = harness({ maxStepsPerTick: 5 });
    h.registry.register({
      "test.a": handler(() => ({ status: "completed", patch: { a: 1 } })),
      "test.b": handler(() => ({ status: "completed", patch: { b: 1 } })),
    });

    const run = await h.engine.start(cycle);

    const first = await h.engine.tick(run.id);
    expect(first).toEqual({ steps: 5, status: "RUNNING" });
    expect((await h.storage.steps.listByRun(run.id))).toHaveLength(5);

    const mid = await h.engine.get(run.id);
    expect(mid.status).toBe("RUNNING");
    expect(mid.currentStepId).toBe("b");
    // 回边的 visit 会递增，幂等键不会撞车
    const keys = (await h.storage.steps.listByRun(run.id)).map((item) => item.idempotencyKey);
    expect(keys).toEqual([
      `${run.id}:a:1`,
      `${run.id}:b:1`,
      `${run.id}:a:2`,
      `${run.id}:b:2`,
      `${run.id}:a:3`,
    ]);

    const second = await h.engine.tick(run.id);
    expect(second).toEqual({ steps: 5, status: "RUNNING" });
    expect(await h.storage.steps.listByRun(run.id)).toHaveLength(10);
  });
});

describe("Phase A: 失败路径", () => {
  it("不可重试的失败 → run FAILED，并记录错误与事件", async () => {
    const h = harness();
    h.registry.register({
      "test.a": handler(() => {
        throw new Error("boom");
      }),
      "test.b": handler(() => ({ status: "completed" })),
      "test.c": handler(() => ({ status: "completed" })),
    });

    const run = await h.engine.start(linear);
    const result = await h.engine.tick(run.id);

    expect(result.status).toBe("FAILED");
    const final = await h.engine.get(run.id);
    expect(final.error?.code).toBe("STEP_FAILED");
    expect(final.currentStepId).toBe("a");

    const events = (await h.storage.events.listByRun(run.id)).map((item) => item.type);
    expect(events).toContain("step.failed");
    expect(events).toContain("workflow.failed");
    expect(events).not.toContain("workflow.completed");
  });

  it("可重试的失败 → RETRYING + wake_at，到点后重试同一条记录", async () => {
    const h = harness();
    const attempts: number[] = [];
    h.registry.register({
      "test.a": handler(({ attempt }) => {
        attempts.push(attempt);
        if (attempt < 3) {
          return { status: "failed", error: new WorkflowError("暂时不可用", { code: "STEP_FAILED", retryable: true }) };
        }
        return { status: "completed", output: { attempt }, patch: { done: true } };
      }),
      "test.b": handler(() => ({ status: "completed" })),
    });

    const flaky = defineWorkflow({
      id: "flaky",
      version: 1,
      start: "a",
      steps: {
        a: {
          uses: "test.a",
          retry: { maxAttempts: 3, backoff: "fixed", initialDelayMs: 1_000, jitter: false },
          next: "b",
        },
        b: { uses: "test.b" },
      },
    });

    const run = await h.engine.start(flaky);

    const first = await h.engine.tick(run.id);
    expect(first.status).toBe("RETRYING");
    expect(attempts).toEqual([1]);
    expect((await h.engine.get(run.id)).wakeAt).toBe("2026-01-01T00:00:01.000Z");

    h.advance(1_000);
    expect((await h.engine.tick(run.id)).status).toBe("RETRYING");
    expect(attempts).toEqual([1, 2]);

    h.advance(1_000);
    expect((await h.engine.tick(run.id)).status).toBe("COMPLETED");
    expect(attempts).toEqual([1, 2, 3]);

    // 三次尝试共用同一条 step run 记录与同一个幂等键
    const aRuns = (await h.storage.steps.listByRun(run.id)).filter((item) => item.stepId === "a");
    expect(aRuns).toHaveLength(1);
    expect(aRuns[0]?.attempt).toBe(3);
    expect(aRuns[0]?.idempotencyKey).toBe(`${run.id}:a:1`);
    expect(aRuns[0]?.status).toBe("COMPLETED");
  });

  it("UNKNOWN 永不自动重试", async () => {
    const h = harness();
    h.registry.register({
      "test.a": handler(() => ({
        status: "failed",
        error: new UnknownOutcomeError("邮件投递结果未知"),
      })),
      "test.b": handler(() => ({ status: "completed" })),
      "test.c": handler(() => ({ status: "completed" })),
    });

    const withRetry = defineWorkflow({
      id: "unknown",
      version: 1,
      start: "a",
      steps: {
        a: { uses: "test.a", retry: { maxAttempts: 5, initialDelayMs: 10 }, next: "b" },
        b: { uses: "test.b" },
      },
    });

    const run = await h.engine.start(withRetry);
    const result = await h.engine.tick(run.id);

    expect(result.status).toBe("FAILED");
    expect((await h.storage.steps.listByRun(run.id))[0]?.status).toBe("UNKNOWN");
    expect((await h.storage.steps.listByRun(run.id))[0]?.attempt).toBe(1);
    const types = (await h.storage.events.listByRun(run.id)).map((item) => item.type);
    expect(types).toContain("step.unknown");
    expect(types).not.toContain("workflow.retrying");
  });

  it("waiting 的步骤会让 run 挂起（不占进程）", async () => {
    const h = harness();
    h.registry.register({
      "test.a": handler(() => ({ status: "completed" })),
      "test.wait": handler(() => ({ status: "waiting", waitFor: "approval" })),
    });

    const withApproval = defineWorkflow({
      id: "approval-flow",
      version: 1,
      start: "a",
      steps: {
        a: { uses: "test.a", next: "approve" },
        approve: { uses: "test.wait" },
      },
    });

    const run = await h.engine.start(withApproval);
    const result = await h.engine.tick(run.id);

    expect(result.status).toBe("WAITING");
    const waiting = await h.engine.get(run.id);
    expect(waiting.currentStepId).toBe("approve");
    expect(waiting.currentStepRunId).not.toBeNull();
    // 等信号的 run 不能被抢占（wake_at 为 null），D 阶段才会被 signal 叫醒
    expect(waiting.wakeAt).toBeNull();
    expect(await h.storage.runs.claimDue({ owner: "w", limit: 10, leaseMs: 1_000 })).toEqual([]);
    // 再次 tick 什么也不做
    expect(await h.engine.tick(run.id)).toEqual({ steps: 0, status: "WAITING" });
  });

  it("超时会被强制生效，即使 handler 不理会 AbortSignal", async () => {
    const h = harness();
    h.registry.register({
      "test.a": handler(() => ({ status: "completed" })),
      "test.hang": handler(() => new Promise<StepResult<unknown>>(() => undefined)),
    });

    const withTimeout = defineWorkflow({
      id: "timeout",
      version: 1,
      start: "a",
      steps: {
        a: { uses: "test.a", next: "hang" },
        hang: { uses: "test.hang", timeoutMs: 20, retry: { maxAttempts: 1 } },
      },
    });

    const run = await h.engine.start(withTimeout);
    const result = await h.engine.tick(run.id);

    expect(result.status).toBe("FAILED");
    const stepRuns = await h.storage.steps.listByRun(run.id);
    expect(stepRuns[1]?.error?.code).toBe("STEP_TIMEOUT");
  });
});

describe("Phase A: 注册表覆盖检查", () => {
  it("definition 引用了没注册的 handler → 启动时就炸", async () => {
    const h = harness();
    h.registry.register({
      "test.a": handler(() => ({ status: "completed" })),
    });

    const missing = defineWorkflow({
      id: "missing",
      version: 1,
      start: "a",
      steps: {
        a: { uses: "test.a", next: "b" },
        b: { uses: "nobody.implements.this" },
      },
    });

    await expect(h.engine.publish(missing)).rejects.toThrow(ValidationError);
    await expect(h.engine.start(missing)).rejects.toThrow(/缺少注册/);
  });

  it("definition 引用了没注册的 guard → 启动时也炸", async () => {
    const h = harness();
    h.registry.register({
      "test.a": handler(() => ({ status: "completed" })),
      "test.b": handler(() => ({ status: "completed" })),
    });

    const missingGuard = defineWorkflow({
      id: "missing-guard",
      version: 1,
      start: "a",
      steps: {
        a: { uses: "test.a", next: [{ to: "b", when: "nope" }, { to: "b" }] },
        b: { uses: "test.b" },
      },
    });

    await expect(h.engine.start(missingGuard)).rejects.toThrow(/guard: nope/);
  });
});
