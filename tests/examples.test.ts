import { describe, expect, it } from "vitest";

import { MemoryWorkflowStorage, WorkflowClient, WorkflowEngine, WorkflowWorker } from "../src/index.js";
import { registerApprovalFlow } from "../examples/approval-flow/handlers.js";
import { requestToAction } from "../examples/approval-flow/workflow.js";

/**
 * 示例同时也是「definition ↔ registry 一致性」的回归测试。
 *
 * 这类检查以后应当由 Engine 在 publish 时做（实际上已经做了：assertRegistryCoverage）。
 */
describe("examples/approval-flow", () => {
  it("definition 合法且是归一化形态", () => {
    expect(requestToAction.id).toBe("request-to-action");
    expect(requestToAction.version).toBe(1);
    expect(requestToAction.steps["approval"]?.next).toEqual([{ to: "create-record" }]);
    expect(requestToAction.steps["notify"]?.next).toEqual([]);
  });

  it("每个 step 的 uses 都有对应 handler", () => {
    const registry = registerApprovalFlow();
    const missing = Object.entries(requestToAction.steps)
      .filter(([, step]) => !registry.has(step.uses))
      .map(([stepId, step]) => `${stepId} → ${step.uses}`);

    expect(missing).toEqual([]);
  });

  it("每个 transition 引用的 guard 都有实现", () => {
    const registry = registerApprovalFlow();
    const used = new Set<string>();
    for (const step of Object.values(requestToAction.steps)) {
      for (const transition of step.next) {
        if (transition.when !== undefined) used.add(transition.when);
      }
    }

    expect([...used].filter((name) => !registry.hasGuard(name))).toEqual([]);
    expect([...used]).toEqual(["confidence.low"]);
  });

  it("注册表是干净的：保留名字没被业务占用", () => {
    const registry = registerApprovalFlow();
    expect(registry.handlerNames()).toEqual([
      "ai.classify",
      "email.send",
      "human.approval",
      "human.review",
      "record.create",
    ]);
  });
});

describe("examples/approval-flow 端到端", () => {
  it("整条链路：分类 → 人工复核 → 审批 → 建记录 → 通知（全程靠信号推进）", async () => {
    const storage = new MemoryWorkflowStorage();
    const engine = new WorkflowEngine({ storage, registry: registerApprovalFlow() });
    const worker = new WorkflowWorker({ engine, owner: "demo-worker", leaseMs: 60_000 });
    const client = new WorkflowClient(engine);

    const run = await client.start(requestToAction, { input: { requestId: "REQ-1024" } });

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
      requestId: "REQ-1024",
      confidence: 0.62,
      priority: "high",
      reviewedBy: "ops",
      approved: true,
      recordId: "rec_REQ-1024",
      source: "example",
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

  it("低置信度 → 人工复核：挂起时不占进程，第二次 tick 什么都不做", async () => {
    const storage = new MemoryWorkflowStorage();
    const engine = new WorkflowEngine({ storage, registry: registerApprovalFlow() });
    const worker = new WorkflowWorker({ engine, owner: "demo-worker", leaseMs: 60_000 });

    const run = await engine.start(requestToAction, { input: { requestId: "REQ-1024" } });
    const result = await worker.tick();

    expect(result.completed).toBe(0);
    const current = await engine.get(run.id);
    expect(current.status).toBe("WAITING");
    expect(current.currentStepId).toBe("manual-review");
    // 首个 step 的 patch 已经进了 context，供 guard 与后面的 step 用
    expect(current.context).toEqual({ requestId: "REQ-1024", confidence: 0.62, priority: "high" });
    expect(current.wakeAt).toBeNull();

    // 走到这里 run 就静静地挂着了 —— 线程、Promise、连接都没有挂着
    expect(await storage.runs.claimDue({ owner: "worker", limit: 10, leaseMs: 1_000 })).toEqual([]);

    const timeline = (await storage.events.listByRun(run.id)).map((item) => item.type);
    expect(timeline).toEqual([
      "workflow.created",
      "workflow.started",
      "step.started",
      "step.completed",
      "step.started",
      "step.waiting",
      "workflow.waiting",
    ]);
  });
});
