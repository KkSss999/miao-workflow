import { describe, expect, it } from "vitest";

import { WorkflowError, defineWorkflow, type StepHandler, type StepResult } from "../src/index.js";
import { createHarness, waiter } from "./support/harness.js";

/**
 * Phase D：异步与信号。
 *
 * 这一组测试就是「human-in-the-loop 到底是不是一等公民」的答案：
 * run 挂起时不占进程、不挂 Promise，进程随便重启，信号到了才继续。
 */

const approvalFlow = defineWorkflow({
  id: "approval-flow",
  version: 1,
  start: "triage",
  steps: {
    triage: { uses: "test.triage", next: "approve" },
    approve: { uses: "human.approval", next: "deliver" },
    deliver: { uses: "test.deliver" },
  },
});

function registerApproval(h: ReturnType<typeof createHarness>): void {
  h.registry.register({
    "test.triage": h.tracked("triage", { confidence: 0.62 }),
    "human.approval": waiter("approval"),
    "test.deliver": h.tracked("deliver"),
  });
}

/** 走一遍「起 run → 跑到挂起」 */
async function runUntilWaiting(h: ReturnType<typeof createHarness>) {
  const run = await h.engine.start(approvalFlow, { input: { intakeId: "INT-1024" } });
  await h.worker.tick();
  return run;
}

describe("Phase D: signal / wait / resume", () => {
  it("挂起 → 送信号 → 恢复并跑完（payload 交给 handler）", async () => {
    const h = createHarness();
    registerApproval(h);
    const run = await runUntilWaiting(h);

    const waiting = await h.engine.get(run.id);
    expect(waiting.status).toBe("WAITING");
    expect(waiting.currentStepId).toBe("approve");
    expect(waiting.wakeAt).toBeNull();
    expect(h.calls).toEqual(["triage"]);

    // 人类点了 Approve —— 这一步只写库，不执行任何业务
    await h.engine.signal(run.id, "approval", { decision: "approve", by: "gery" });

    // 挂起中的 run 现在可抢了（因为有一条匹配的未消费信号）
    const result = await h.worker.tick();
    expect(result).toEqual({ claimed: 1, handled: 1, failed: 0, completed: 1 });

    const final = await h.engine.get(run.id);
    expect(final.status).toBe("COMPLETED");
    expect(h.calls).toEqual(["triage", "deliver"]);

    // payload 进了 step run 的 output 与 context
    const approveRun = (await h.storage.steps.listByRun(run.id)).find((item) => item.stepId === "approve");
    expect(approveRun?.output).toEqual({ decision: "approve", by: "gery" });
    expect(final.context).toEqual({ confidence: 0.62, approved: true });

    const types = (await h.storage.events.listByRun(run.id)).map((item) => item.type);
    expect(types).toContain("signal.received");
    expect(types).toContain("workflow.waiting");
    expect(types).toContain("workflow.resumed");
    expect(types).toContain("workflow.completed");
  });

  it("信号只消费一次；重复 Approve 不会推进两次", async () => {
    const h = createHarness();
    registerApproval(h);
    const run = await runUntilWaiting(h);

    await h.engine.signal(run.id, "approval", { decision: "approve", seq: 1 });
    await h.engine.signal(run.id, "approval", { decision: "approve", seq: 2 });

    expect(await h.storage.signals.countPending(run.id)).toBe(2);

    await h.worker.tick();

    const signals = await h.storage.signals.listByRun(run.id);
    expect(signals.filter((item) => item.consumedAt !== null)).toHaveLength(1);
    expect(await h.storage.signals.countPending(run.id)).toBe(1);

    // handler 只被叫醒一次，拿到的是第一条信号
    const approveRun = (await h.storage.steps.listByRun(run.id)).find((item) => item.stepId === "approve");
    expect(approveRun?.attempt).toBe(2);
    expect(approveRun?.output).toEqual({ decision: "approve", seq: 1 });
  });

  it("名字不匹配的信号不会叫醒 run，也不会被误消费", async () => {
    const h = createHarness();
    registerApproval(h);
    const run = await runUntilWaiting(h);

    await h.engine.signal(run.id, "payment", { paid: true });

    // 没有匹配的信号 → 抢不到（不会空转）
    expect((await h.worker.tick()).claimed).toBe(0);
    expect((await h.engine.get(run.id)).status).toBe("WAITING");

    await h.engine.signal(run.id, "approval", { decision: "approve" });
    expect((await h.worker.tick()).claimed).toBe(1);
    expect(await h.storage.signals.countPending(run.id)).toBe(1); // payment 还留着
  });

  it("信号到了但进程崩了 → 重启后照样恢复（signal 只写库，不存在半完成状态）", async () => {
    const h = createHarness();
    registerApproval(h);
    const run = await runUntilWaiting(h);

    await h.engine.signal(run.id, "approval", { decision: "approve" });
    // 此刻 run 还是 WAITING —— engine.signal 刻意不碰 run
    expect((await h.engine.get(run.id)).status).toBe("WAITING");

    // 「重启」：全新的 engine + worker，进程启动时重新注册 handler，然后只靠数据库继续
    const restarted = createHarness({ storage: h.storage, owner: "worker-after-restart" });
    registerApproval(restarted);
    const result = await restarted.worker.tick();

    expect(result.claimed).toBe(1);
    expect((await restarted.engine.get(run.id)).status).toBe("COMPLETED");
  });

  it("等待超时（wakeAt）也能恢复，且 handler 知道自己是被时间叫醒的", async () => {
    const h = createHarness();
    const escalate = defineWorkflow({
      id: "escalate",
      version: 1,
      start: "ask",
      steps: { ask: { uses: "test.ask" } },
    });

    const seen: string[] = [];
    h.registry.register({
      "test.ask": {
        async execute({ resume }): Promise<StepResult> {
          if (resume === undefined) {
            seen.push("first");
            return { status: "waiting", waitFor: "approval", wakeAt: "2026-01-01T00:05:00.000Z" };
          }
          seen.push(`resumed:${resume.wakeAt ?? "signal"}`);
          return { status: "completed", patch: { escalated: true } };
        },
      },
    });

    const run = await h.engine.start(escalate);
    await h.worker.tick();
    expect((await h.engine.get(run.id)).status).toBe("WAITING");

    // 还没到点
    expect((await h.worker.tick()).claimed).toBe(0);

    h.advance(5 * 60_000);
    expect((await h.worker.tick()).claimed).toBe(1);

    expect(seen).toEqual(["first", "resumed:2026-01-01T00:05:00.000Z"]);
    expect((await h.engine.get(run.id)).status).toBe("COMPLETED");
  });

  it("被叫醒之后失败重试，不需要外部再送一次信号（payload 落在 step run 上）", async () => {
    const h = createHarness();
    const twoStage = defineWorkflow({
      id: "resume-then-fail",
      version: 1,
      start: "approve",
      steps: {
        approve: {
          uses: "human.approval",
          retry: { maxAttempts: 3, backoff: "fixed", initialDelayMs: 1_000, jitter: false },
        },
      },
    });

    let calls = 0;
    h.registry.register({
      "human.approval": {
        async execute({ resume }): Promise<StepResult> {
          calls += 1;
          if (resume === undefined) return { status: "waiting", waitFor: "approval" };
          if (calls === 2) {
            return {
              status: "failed",
              error: new WorkflowError("下游 503", { code: "STEP_FAILED", retryable: true }),
            };
          }
          return { status: "completed", output: resume.payload, patch: { approved: true } };
        },
      },
    });

    const run = await h.engine.start(twoStage);
    await h.worker.tick();
    expect((await h.engine.get(run.id)).status).toBe("WAITING");

    await h.engine.signal(run.id, "approval", { decision: "approve" });
    await h.worker.tick();
    expect((await h.engine.get(run.id)).status).toBe("RETRYING");

    // 注意：这里没有第二次 signal
    h.advance(1_000);
    await h.worker.tick();

    const final = await h.engine.get(run.id);
    expect(final.status).toBe("COMPLETED");
    const approveRun = (await h.storage.steps.listByRun(run.id))[0];
    expect(approveRun?.attempt).toBe(3);
    expect(approveRun?.output).toEqual({ decision: "approve" });
    expect(await h.storage.signals.countPending(run.id)).toBe(0);
  });
});

describe("Phase D: delay", () => {
  const withDelay = defineWorkflow({
    id: "follow-up",
    version: 1,
    start: "send",
    steps: {
      send: { uses: "test.send", next: "pause" },
      pause: { uses: "workflow.delay", config: { duration: "2d" }, next: "follow-up" },
      "follow-up": { uses: "test.follow-up" },
    },
  });

  it("2 天后才醒 —— 等待期间不占进程、抢不到", async () => {
    const h = createHarness();
    h.registry.register({
      "test.send": h.tracked("send"),
      "test.follow-up": h.tracked("follow-up"),
    });

    const run = await h.engine.start(withDelay);
    await h.worker.tick();

    const waiting = await h.engine.get(run.id);
    expect(waiting.status).toBe("WAITING");
    expect(waiting.currentStepId).toBe("pause");
    expect(waiting.wakeAt).toBe("2026-01-03T00:00:00.000Z");

    // 一天后依然抢不到
    h.advance(86_400_000);
    expect((await h.worker.tick()).claimed).toBe(0);
    expect(h.calls).toEqual(["send"]);

    // 两天后继续
    h.advance(86_400_000);
    expect((await h.worker.tick()).claimed).toBe(1);

    expect(h.calls).toEqual(["send", "follow-up"]);
    const pauseRun = (await h.storage.steps.listByRun(run.id)).find((item) => item.stepId === "pause");
    expect(pauseRun?.output).toEqual({ waitedForMs: 172_800_000, wokeAt: "2026-01-03T00:00:00.000Z" });
  });

  it("delay 支持裸数字（毫秒）与组合写法", async () => {
    const h = createHarness();
    const quick = defineWorkflow({
      id: "quick-delay",
      version: 1,
      start: "pause",
      steps: { pause: { uses: "workflow.delay", config: { duration: "1h30m" } } },
    });

    const run = await h.engine.start(quick);
    await h.worker.tick();

    expect((await h.engine.get(run.id)).wakeAt).toBe("2026-01-01T01:30:00.000Z");
    h.advance(90 * 60_000);
    await h.worker.tick();
    expect((await h.engine.get(run.id)).status).toBe("COMPLETED");
  });
});

describe("Phase D: cancel", () => {
  it("挂起中的 run 可以被取消，且之后不会再被推进", async () => {
    const h = createHarness();
    registerApproval(h);
    const run = await runUntilWaiting(h);

    const cancelled = await h.engine.cancel(run.id);

    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.wakeAt).toBeNull();
    expect(cancelled.completedAt).not.toBeNull();
    expect((await h.storage.events.listByRun(run.id)).map((item) => item.type)).toContain("workflow.cancelled");

    expect((await h.worker.tick()).claimed).toBe(0);
    // 取消之后送信号也没用
    await expect(h.engine.signal(run.id, "approval")).rejects.toThrow(/不接受该操作/);
  });

  it("已经终态的 run 不能重复取消", async () => {
    const h = createHarness();
    registerApproval(h);
    const run = await runUntilWaiting(h);
    await h.engine.cancel(run.id);

    await expect(h.engine.cancel(run.id)).rejects.toThrow(/不接受该操作/);
  });

  it("取消会释放 lease，别的 worker 不会卡在它身上", async () => {
    const h = createHarness();
    registerApproval(h);
    const run = await runUntilWaiting(h);
    await h.storage.runs.claimDue({ owner: "worker-x", limit: 1, leaseMs: 60_000 });

    await h.engine.cancel(run.id);

    expect((await h.engine.get(run.id)).leaseOwner).toBeNull();
  });
});

describe("Phase D: StepHandler 的挂起契约", () => {
  it("handler 只需要判断 resume 有没有值，不需要知道是谁叫醒的", async () => {
    const h = createHarness();
    const contract = defineWorkflow({
      id: "contract",
      version: 1,
      start: "gate",
      steps: { gate: { uses: "test.gate" } },
    });

    const handler: StepHandler = {
      async execute({ resume }): Promise<StepResult> {
        if (resume === undefined) return { status: "waiting", waitFor: "go" };
        // resume.payload 可能是 undefined（信号没带 payload）—— 用 resume 本身判断，不要用 payload 判断
        return { status: "completed", patch: { went: true } };
      },
    };
    h.registry.register({ "test.gate": handler });

    const run = await h.engine.start(contract);
    await h.worker.tick();
    expect((await h.engine.get(run.id)).status).toBe("WAITING");

    await h.engine.signal(run.id, "go");
    await h.worker.tick();

    expect((await h.engine.get(run.id)).context).toEqual({ went: true });
  });
});
