import { describe, expect, it } from "vitest";

import {
  ValidationError,
  defineWorkflow,
  findUnreachableSteps,
  hashDefinition,
  stableStringify,
} from "../src/index.js";

const linear = {
  id: "test-workflow",
  version: 1,
  start: "a",
  steps: {
    a: { uses: "test.a", next: "b" },
    b: { uses: "test.b", next: "c" },
    c: { uses: "test.c" },
  },
};

describe("defineWorkflow", () => {
  it("把简写 next 归一化成数组", () => {
    const definition = defineWorkflow(linear);
    expect(definition.steps["a"]?.next).toEqual([{ to: "b" }]);
    expect(definition.steps["c"]?.next).toEqual([]);
  });

  it("保留带 guard 的分支与兜底分支", () => {
    const definition = defineWorkflow({
      id: "branch",
      version: 1,
      start: "triage",
      steps: {
        triage: {
          uses: "ai.classify",
          next: [{ to: "manual-review", when: "confidence.low" }, { to: "approval" }],
        },
        "manual-review": { uses: "human.review", next: "approval" },
        approval: { uses: "human.approval" },
      },
    });

    expect(definition.steps["triage"]?.next).toEqual([
      { to: "manual-review", when: "confidence.low" },
      { to: "approval" },
    ]);
  });

  it("定义是纯 JSON：可以 JSON.parse(JSON.stringify(x)) 无损还原", () => {
    const definition = defineWorkflow({ ...linear, meta: { title: "线性流程", tags: ["test"] } });
    const roundTripped = JSON.parse(JSON.stringify(definition)) as unknown;
    expect(roundTripped).toEqual(definition);
  });

  it("拒绝不可序列化的 config", () => {
    expect(() =>
      defineWorkflow({
        id: "bad",
        version: 1,
        start: "a",
        steps: { a: { uses: "test.a", config: { fn: (() => 1) as never } } },
      }),
    ).toThrow(ValidationError);
  });

  it("拒绝循环引用", () => {
    const config: Record<string, unknown> = {};
    config["self"] = config;
    expect(() =>
      defineWorkflow({
        id: "cycle",
        version: 1,
        start: "a",
        steps: { a: { uses: "test.a", config: config as never } },
      }),
    ).toThrow(/循环引用/);
  });

  it("拒绝指向不存在步骤的 transition", () => {
    expect(() =>
      defineWorkflow({
        id: "dangling",
        version: 1,
        start: "a",
        steps: { a: { uses: "test.a", next: "nope" } },
      }),
    ).toThrow(/不存在的步骤/);
  });

  it("拒绝不存在的 start", () => {
    expect(() => defineWorkflow({ ...linear, start: "zzz" })).toThrow(/workflow.start/);
  });

  it("拒绝不可达步骤", () => {
    expect(() =>
      defineWorkflow({
        id: "orphan",
        version: 1,
        start: "a",
        steps: {
          a: { uses: "test.a" },
          orphan: { uses: "test.orphan" },
        },
      }),
    ).toThrow(/不可达/);
  });

  it("拒绝把无条件兜底分支放在中间", () => {
    expect(() =>
      defineWorkflow({
        id: "fallback-order",
        version: 1,
        start: "a",
        steps: {
          a: { uses: "test.a", next: [{ to: "b" }, { to: "c", when: "x" }] },
          b: { uses: "test.b" },
          c: { uses: "test.c" },
        },
      }),
    ).toThrow(/最后/);
  });

  it("拒绝非法的 retry 配置", () => {
    expect(() =>
      defineWorkflow({
        id: "retry",
        version: 1,
        start: "a",
        steps: { a: { uses: "test.a", retry: { maxAttempts: 0 } } },
      }),
    ).toThrow(/maxAttempts/);
  });

  it("拒绝非整数 version", () => {
    expect(() => defineWorkflow({ ...linear, version: 1.5 })).toThrow(/version/);
  });
});

describe("definition hash", () => {
  it("与对象 key 顺序无关", () => {
    const left = defineWorkflow({
      id: "same",
      version: 1,
      start: "a",
      steps: {
        a: { uses: "test.a", next: "b" },
        b: { uses: "test.b" },
      },
    });
    const right = defineWorkflow({
      start: "a",
      version: 1,
      id: "same",
      steps: {
        b: { uses: "test.b" },
        a: { next: "b", uses: "test.a" },
      },
    });

    expect(stableStringify(left as never)).toEqual(stableStringify(right as never));
    expect(hashDefinition(left)).toEqual(hashDefinition(right));
  });

  it("内容变化会改变 hash", () => {
    const v1 = defineWorkflow(linear);
    const v2 = defineWorkflow({
      ...linear,
      steps: { ...linear.steps, c: { uses: "test.c2" } },
    });
    expect(hashDefinition(v1)).not.toEqual(hashDefinition(v2));
  });

  it("findUnreachableSteps 只报真正走不到的步骤", () => {
    const definition = defineWorkflow({
      id: "reach",
      version: 1,
      start: "a",
      steps: {
        a: { uses: "test.a", next: [{ to: "b", when: "yes" }, { to: "c" }] },
        b: { uses: "test.b" },
        c: { uses: "test.c" },
      },
    });
    expect(findUnreachableSteps(definition)).toEqual([]);
  });
});
