import { describe, expect, it } from "vitest";

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
