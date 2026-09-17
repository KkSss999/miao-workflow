import { describe, expect, it } from "vitest";

import { NoMatchingTransitionError, Registry, defineWorkflow, resolveNextStep } from "../src/index.js";
import type { StepDefinition } from "../src/index.js";

const guardRegistry = new Registry()
  .guard("always", () => true)
  .guard("never", () => false)
  .guard("confidence.low", ({ context }) => Number(context["confidence"] ?? 1) < 0.75);

function resolve(args: {
  step: StepDefinition;
  stepId?: string;
  context?: { confidence?: number };
  output?: string;
}) {
  return resolveNextStep({
    runId: "run-1",
    stepId: args.stepId ?? "current",
    step: args.step,
    context: (args.context ?? {}) as never,
    output: args.output,
    guards: guardRegistry,
  });
}

describe("resolveNextStep", () => {
  it("线性步骤直接给出下一步", () => {
    const definition = defineWorkflow({
      id: "linear",
      version: 1,
      start: "a",
      steps: {
        a: { uses: "test.a", next: "b" },
        b: { uses: "test.b" },
      },
    });
    const step = definition.steps["a"];
    expect(step).toBeDefined();
    expect(resolve({ step: step as StepDefinition })).toBe("b");
  });

  it("终点步骤返回 null", () => {
    const step: StepDefinition = { uses: "test.a", next: [] };
    expect(resolve({ step })).toBeNull();
  });

  it("按声明顺序取第一个命中的分支", () => {
    const step: StepDefinition = {
      uses: "ai.classify",
      next: [
        { to: "manual-review", when: "confidence.low" },
        { to: "approval" },
      ],
    };
    expect(resolve({ step, context: { confidence: 0.3 } })).toBe("manual-review");
    expect(resolve({ step, context: { confidence: 0.95 } })).toBe("approval");
  });

  it("guard 返回 false 就跳过，继续看后面的分支", () => {
    const step: StepDefinition = {
      uses: "test.a",
      next: [
        { to: "b", when: "never" },
        { to: "c", when: "always" },
      ],
    };
    expect(resolve({ step })).toBe("c");
  });

  it("没有命中任何分支且无兜底 → NoMatchingTransitionError", () => {
    const step: StepDefinition = {
      uses: "test.a",
      next: [{ to: "b", when: "never" }],
    };
    expect(() => resolve({ step, stepId: "branchy" })).toThrow(NoMatchingTransitionError);
  });

  it("转移是纯函数：同样的输入永远是同样的结果", () => {
    const step: StepDefinition = {
      uses: "test.a",
      next: [
        { to: "b", when: "confidence.low" },
        { to: "c" },
      ],
    };
    const context = { confidence: 0.5 };
    expect(resolve({ step, context })).toBe(resolve({ step, context }));
  });
});
