import { describe, expect, it } from "vitest";

import { MemoryWorkflowStorage, WorkflowClient, WorkflowEngine, WorkflowWorker } from "../src/index.js";
import { registerIntakeOps } from "../examples/intakeops/handlers.js";
import { intakeToAction } from "../examples/intakeops/workflow.js";

/**
 * 例子同时也是「definition ↔ registry 一致性」的回归测试。
 *
 * 这类检查以后应当由 Engine 在 publish 时做（Phase A）：definition 里出现的每个
 * handler / guard 名，都必须已经在 Registry 里注册。
 */
describe("examples/intakeops", () => {
  it("definition 合法且是归一化形态", () => {
    expect(intakeToAction.id).toBe("intake-to-action");
    expect(intakeToAction.version).toBe(1);
    expect(intakeToAction.steps["approval"]?.next).toEqual([{ to: "create-lead" }]);
    expect(intakeToAction.steps["send-email"]?.next).toEqual([]);
  });

  it("每个 step 的 uses 都有对应 handler", () => {
    const registry = registerIntakeOps();
    const missing = Object.entries(intakeToAction.steps)
      .filter(([, step]) => !registry.has(step.uses))
      .map(([stepId, step]) => `${stepId} → ${step.uses}`);

    expect(missing).toEqual([]);
  });

  it("每个 transition 引用的 guard 都有实现", () => {
    const registry = registerIntakeOps();
    const used = new Set<string>();
    for (const step of Object.values(intakeToAction.steps)) {
      for (const transition of step.next) {
        if (transition.when !== undefined) used.add(transition.when);
      }
    }

    expect([...used].filter((name) => !registry.hasGuard(name))).toEqual([]);
    expect([...used]).toEqual(["confidence.low"]);
  });

  it("注册表是干净的：保留名字没被业务占用", () => {
    const registry = registerIntakeOps();
    expect(registry.handlerNames()).toEqual([
      "ai.triage",
      "email.send",
      "human.approval",
      "human.review",
      "lead.create",
    ]);
  });
});

describe("examples/intakeops 端到端（Phase A）", () => {
  it("整条链路：分类 → 人工复核 → 审批 → 建 lead → 发邮件（全程靠信号推进）", async () => {
    const storage = new MemoryWorkflowStorage();
    const engine = new WorkflowEngine({ storage, registry: registerIntakeOps() });
    const worker = new WorkflowWorker({ engine, owner: "demo-worker", leaseMs: 60_000 });
    const client = new WorkflowClient(engine);

    const run = await client.start(intakeToAction, { input: { intakeId: "INT-1024" } });

    // 1. 跑到人工复核
    await worker.tick();
    expect((await client.get(run.id)).currentStepId).toBe("manual-review");

    // 2. 复核通过
    await client.signal(run.id, "review", { reviewer: "ops" });
    await worker.tick();
    expect((await client.get(run.id)).currentStepId).toBe("approval");

    // 3. 审批通过 —— 这一步可能等好几天，进程随便重启
    await client.signal(run.id, "approval", { decision: "approve", by: "gery" });
    await worker.tick();

    const final = await client.get(run.id);
    expect(final.status).toBe("COMPLETED");
    expect(final.context).toEqual({
      intakeId: "INT-1024",
      confidence: 0.62,
      priority: "high",
      reviewedBy: "ops",
      approved: true,
      leadId: "lead_INT-1024",
      source: "intakeops",
    });

    // 完整审计时间线 —— 这就是「这个 run 到底发生了什么」的唯一权威来源
    const timeline = (await storage.events.listByRun(run.id)).map((item) => item.type);
    expect(timeline).toEqual([
      "workflow.created",
      "workflow.started",
      "step.started",
      "step.completed",
      "step.started",
      "step.waiting",
      "workflow.waiting",
      "signal.received",
      "workflow.resumed",
      "step.started",
      "step.completed",
      "step.started",
      "step.waiting",
      "workflow.waiting",
      "signal.received",
      "workflow.resumed",
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
  });

  it("低置信度 → 人工复核 → 挂起等 review 信号（不占进程）", async () => {
    const storage = new MemoryWorkflowStorage();
    const engine = new WorkflowEngine({ storage, registry: registerIntakeOps() });

    const run = await engine.start(intakeToAction, { input: { intakeId: "INT-1024" } });
    const result = await engine.tick(run.id);

    expect(result.status).toBe("WAITING");

    const current = await engine.get(run.id);
    expect(current.currentStepId).toBe("manual-review");
    // triage 的 patch 已经进了 context，供 guard 与后面的 step 用
    expect(current.context).toEqual({ intakeId: "INT-1024", confidence: 0.62, priority: "high" });
    expect(current.wakeAt).toBeNull();

    const events = await storage.events.listByRun(run.id);
    expect(events.map((item) => item.type)).toEqual([
      "workflow.created",
      "workflow.started",
      "step.started",
      "step.completed",
      "step.started",
      "step.waiting",
      "workflow.waiting",
    ]);

    // 走到这里 run 就静静地挂着了 —— 线程、Promise、连接都没有挂着
    expect(await storage.runs.claimDue({ owner: "worker", limit: 10, leaseMs: 1_000 })).toEqual([]);
  });
});
