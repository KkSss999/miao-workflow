import { describe, expect, it } from "vitest";

import {
  UnknownOutcomeError,
  WorkflowError,
  defineWorkflow,
  type StepHandler,
  type StepResult,
} from "../src/index.js";
import { createHarness, sleep } from "./support/harness.js";

/**
 * Phase C：可靠执行。
 *
 * 这里要回答的是「一个 worker 崩了会怎样」「两个 worker 会不会打架」
 * 「坏掉的 handler 会不会拖垮整批」—— 都是生产环境真会发生的事。
 */

const threeStep = defineWorkflow({
  id: "three-step",
  version: 1,
  start: "a",
  steps: {
    a: { uses: "test.a", next: "b" },
    b: { uses: "test.b", next: "c" },
    c: { uses: "test.c" },
  },
});

function registerThree(h: ReturnType<typeof createHarness>): void {
  h.registry.register({ "test.a": h.tracked("a"), "test.b": h.tracked("b"), "test.c": h.tracked("c") });
}

describe("Phase C: Worker", () => {
  it("抢到 run、推到终态、并把 lease 交还", async () => {
    const h = createHarness();
    registerThree(h);
    const run = await h.engine.start(threeStep);

    const result = await h.worker.tick();

    expect(result).toEqual({ claimed: 1, processed: 1, failed: 0 });
    const final = await h.engine.get(run.id);
    expect(final.status).toBe("COMPLETED");
    expect(final.leaseOwner).toBeNull();
    expect(h.calls).toEqual(["a", "b", "c"]);
  });

  it("一次 tick 按 concurrency 抢一批 run", async () => {
    const h = createHarness({ concurrency: 3 });
    registerThree(h);
    await h.engine.start(threeStep);
    await h.engine.start(threeStep);
    await h.engine.start(threeStep);

    const result = await h.worker.tick();

    expect(result.claimed).toBe(3);
    expect(result.processed).toBe(3);
    // 三个 run 都被推进完了
    expect(h.calls).toHaveLength(9);
    // 再 tick 没有活可干
    expect((await h.worker.tick()).claimed).toBe(0);
  });

  it("别人的 lease 没到期就抢不到（不会两个 worker 同时推进）", async () => {
    const h = createHarness();
    registerThree(h);
    await h.engine.start(threeStep);

    const stolen = await h.storage.runs.claimDue({ owner: "other", limit: 1, leaseMs: 60_000 });
    expect(stolen).toHaveLength(1);

    expect(await h.worker.tick()).toEqual({ claimed: 0, processed: 0, failed: 0 });
  });

  it("crash recovery：worker A 死了（lease 没释放），租期过后 B 接着跑", async () => {
    const h = createHarness();
    registerThree(h);
    const run = await h.engine.start(threeStep);

    // A 抢到了 lease，写下指针，然后进程被杀
    await h.storage.runs.claimDue({ owner: "worker-A", limit: 1, leaseMs: 30_000, now: h.nowIso() });
    await h.storage.runs.update(run.id, { status: "RUNNING", currentStepRunId: "ghost-a" });

    // 租期没过之前没人能动它
    expect((await h.worker.tick()).claimed).toBe(0);

    h.advance(30_001);
    const result = await h.worker.tick();

    expect(result).toEqual({ claimed: 1, processed: 1, failed: 0 });
    expect((await h.engine.get(run.id)).status).toBe("COMPLETED");
    // A 留下的悬空指针被复用：同一个 step run id + 同一个幂等键
    const first = (await h.storage.steps.listByRun(run.id))[0];
    expect(first?.id).toBe("ghost-a");
    expect(first?.idempotencyKey).toBe(`${run.id}:a:1`);
    expect(first?.status).toBe("COMPLETED");
  });

  it("失败隔离：一个 run 炸了不影响同一批里别的 run", async () => {
    const h = createHarness();
    registerThree(h);
    const good = await h.engine.start(threeStep);
    const broken = await h.engine.start(threeStep);

    // 把 broken 的指针指到一个不存在的步骤（模拟数据被外部改坏）
    await h.storage.runs.update(broken.id, { currentStepId: "no-such-step" });

    const result = await h.worker.tick();

    expect(result.claimed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.processed).toBe(1);
    expect((await h.engine.get(good.id)).status).toBe("COMPLETED");
    expect((await h.engine.get(broken.id)).status).toBe("RUNNING");
  });

  it("retry 跨 tick：第一次失败 → RETRYING，到点后同一个 worker 再跑一次", async () => {
    const h = createHarness();
    let attempts = 0;
    const flaky = defineWorkflow({
      id: "flaky",
      version: 1,
      start: "a",
      steps: {
        a: {
          uses: "test.flaky",
          retry: { maxAttempts: 3, backoff: "fixed", initialDelayMs: 5_000, jitter: false },
          next: "b",
        },
        b: { uses: "test.b" },
      },
    });
    h.registry.register({
      "test.flaky": {
        async execute({ attempt }): Promise<StepResult> {
          attempts = attempt;
          if (attempt < 3) {
            return {
              status: "failed",
              error: new WorkflowError("暂时不可用", { code: "STEP_FAILED", retryable: true }),
            };
          }
          return { status: "completed", patch: { done: true } };
        },
      },
      "test.b": h.tracked("b"),
    });

    const run = await h.engine.start(flaky);

    await h.worker.tick();
    const retrying = await h.engine.get(run.id);
    expect(retrying.status).toBe("RETRYING");
    expect(retrying.wakeAt).toBe("2026-01-01T00:00:05.000Z");

    // 还没到点：抢不到，也就不会空转
    expect((await h.worker.tick()).claimed).toBe(0);

    h.advance(5_000);
    expect((await h.worker.tick()).claimed).toBe(1);
    expect(attempts).toBe(2);
    expect((await h.engine.get(run.id)).status).toBe("RETRYING");

    h.advance(5_000);
    expect((await h.worker.tick()).claimed).toBe(1);

    expect(attempts).toBe(3);
    expect((await h.engine.get(run.id)).status).toBe("COMPLETED");
    // 三次尝试共用同一条记录
    const aRuns = (await h.storage.steps.listByRun(run.id)).filter((item) => item.stepId === "a");
    expect(aRuns).toHaveLength(1);
    expect(aRuns[0]?.attempt).toBe(3);
  });

  it("心跳：handler 比租期还久，lease 不会被别人抢走", async () => {
    const h = createHarness({ owner: "worker-long", leaseMs: 60, leaseRenewIntervalMs: 20 });
    const slow = defineWorkflow({
      id: "slow",
      version: 1,
      start: "slow",
      steps: { slow: { uses: "test.slow" } },
    });
    h.registry.register({
      "test.slow": {
        async execute(): Promise<StepResult> {
          await sleep(120);
          return { status: "completed" };
        },
      },
    });

    const run = await h.engine.start(slow);
    const ticking = h.worker.tick();

    // 时间已经超过原始租期，但心跳把它续上了
    await sleep(80);
    const mid = await h.engine.get(run.id);
    expect(mid.leaseOwner).toBe("worker-long");
    expect(mid.leaseExpiresAt).not.toBeNull();

    const other = createHarness({ owner: "worker-other", storage: h.storage, leaseMs: 60 });
    expect((await other.worker.tick()).claimed).toBe(0);

    const result = await ticking;
    expect(result).toEqual({ claimed: 1, processed: 1, failed: 0 });
    expect((await h.engine.get(run.id)).status).toBe("COMPLETED");
  });

  it("drain 等所有在途的 run 跑完（优雅退出）", async () => {
    const h = createHarness({ concurrency: 2 });
    registerThree(h);
    await h.engine.start(threeStep);
    await h.engine.start(threeStep);

    const ticking = h.worker.tick();
    await h.worker.drain();
    const result = await ticking;

    expect(result.processed).toBe(2);
  });
});

describe("Phase C: UNKNOWN 的 reconciliation", () => {
  function unknownWorkflow() {
    return defineWorkflow({
      id: "unknown",
      version: 1,
      start: "send",
      steps: { send: { uses: "test.send", next: "after" }, after: { uses: "test.after" } },
    });
  }

  function registerUnknown(h: ReturnType<typeof createHarness>, outcomes: readonly ("unknown" | "ok")[]): void {
    let call = 0;
    const handler: StepHandler = {
      async execute(): Promise<StepResult> {
        const outcome = outcomes[Math.min(call, outcomes.length - 1)];
        call += 1;
        h.calls.push(`send:${call}`);
        if (outcome === "unknown") {
          return { status: "failed", error: new UnknownOutcomeError("邮件投递结果未知") };
        }
        return { status: "completed", patch: { sent: true } };
      },
    };
    h.registry.register({ "test.send": handler, "test.after": h.tracked("after") });
  }

  it("UNKNOWN 会停下来等人；reconcile(retry) 用同一个幂等键重跑", async () => {
    const h = createHarness();
    registerUnknown(h, ["unknown", "ok"]);
    const run = await h.engine.start(unknownWorkflow());

    await h.worker.tick();
    const stuck = await h.engine.get(run.id);
    expect(stuck.status).toBe("FAILED");
    expect(stuck.error?.code).toBe("UNKNOWN_OUTCOME");
    // 不会自动重试 —— 再 tick 也抢不到（终态）
    expect((await h.worker.tick()).claimed).toBe(0);

    const resumed = await h.engine.reconcile(run.id, "retry");
    expect(resumed.status).toBe("RUNNING");
    expect(resumed.error).toBeNull();

    await h.worker.tick();

    expect((await h.engine.get(run.id)).status).toBe("COMPLETED");
    const sendRuns = (await h.storage.steps.listByRun(run.id)).filter((item) => item.stepId === "send");
    expect(sendRuns).toHaveLength(1);
    expect(sendRuns[0]?.attempt).toBe(2);
    // 幂等键没变 —— 下游才能识别出「这是同一次业务动作」
    expect(sendRuns[0]?.idempotencyKey).toBe(`${run.id}:send:1`);
  });

  it("reconcile(abandon) 放弃这个 run", async () => {
    const h = createHarness();
    registerUnknown(h, ["unknown"]);
    const run = await h.engine.start(unknownWorkflow());
    await h.worker.tick();

    const abandoned = await h.engine.reconcile(run.id, "abandon");

    expect(abandoned.status).toBe("CANCELLED");
    expect(abandoned.completedAt).not.toBeNull();
    const events = (await h.storage.events.listByRun(run.id)).map((item) => item.type);
    expect(events).toContain("workflow.cancelled");
  });

  it("不是 UNKNOWN 的 run 不允许 reconcile", async () => {
    const h = createHarness();
    registerThree(h);
    const run = await h.engine.start(threeStep);
    await h.worker.tick();

    await expect(h.engine.reconcile(run.id, "retry")).rejects.toThrow(/不接受该操作/);
  });
});
