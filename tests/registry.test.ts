import { describe, expect, it } from "vitest";

import {
  DuplicateRegistrationError,
  GuardNotFoundError,
  HandlerNotFoundError,
  RESERVED_HANDLERS,
  Registry,
  isReservedHandler,
} from "../src/index.js";
import type { StepHandler } from "../src/index.js";

const noop: StepHandler = {
  async execute() {
    return { status: "completed" };
  },
};

describe("Registry", () => {
  it("注册并解析 handler", () => {
    const registry = new Registry();
    registry.register("ai.classify", noop);
    expect(registry.has("ai.classify")).toBe(true);
    expect(registry.resolve("ai.classify")).toBe(noop);
    expect(registry.handlerNames()).toEqual(["ai.classify"]);
  });

  it("支持批量注册（链式）", () => {
    const registry = new Registry().register({
      "ai.classify": noop,
      "record.create": noop,
    });
    expect(registry.handlerNames()).toEqual(["ai.classify", "record.create"]);
  });

  it("重名默认报错，不允许悄悄覆盖", () => {
    const registry = new Registry().register("a", noop);
    expect(() => registry.register("a", noop)).toThrow(DuplicateRegistrationError);
  });

  it("可以选择 replace 覆盖", () => {
    const replacement: StepHandler = {
      async execute() {
        return { status: "completed", output: "new" };
      },
    };
    const registry = new Registry({ duplicate: "replace" }).register("a", noop);
    registry.register("a", replacement);
    expect(registry.resolve("a")).toBe(replacement);
  });

  it("解析未注册的 handler 会抛出明确的错误", () => {
    const registry = new Registry();
    expect(() => registry.resolve("nope")).toThrow(HandlerNotFoundError);
  });

  it("guard 与 handler 分开命名空间", () => {
    const registry = new Registry();
    registry.register("same.name", noop);
    registry.guard("same.name", () => true);
    expect(registry.has("same.name")).toBe(true);
    expect(registry.hasGuard("same.name")).toBe(true);
  });

  it("guard 能读到 context 并参与判断", () => {
    const registry = new Registry().guard("confidence.low", ({ context }) =>
      Number(context["confidence"] ?? 1) < 0.75,
    );
    const guard = registry.resolveGuard("confidence.low");
    expect(guard({ runId: "r", stepId: "s", context: { confidence: 0.4 }, output: undefined })).toBe(true);
    expect(guard({ runId: "r", stepId: "s", context: { confidence: 0.9 }, output: undefined })).toBe(false);
  });

  it("解析未注册的 guard 会抛出 GuardNotFoundError", () => {
    expect(() => new Registry().resolveGuard("nope")).toThrow(GuardNotFoundError);
  });

  it("保留 handler 名字带 workflow. 前缀", () => {
    expect(isReservedHandler(RESERVED_HANDLERS.delay)).toBe(true);
    expect(isReservedHandler(RESERVED_HANDLERS.complete)).toBe(true);
    expect(isReservedHandler("email.send")).toBe(false);
  });
});
