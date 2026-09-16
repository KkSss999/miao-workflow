import { UnknownOutcomeError, WorkflowError, type WorkflowErrorCode } from "../../core/errors.js";
import type { Registry } from "../../core/registry.js";
import type { StepHandler, StepResult } from "../../core/runner.js";
import type { JsonObject } from "../../json.js";
import { buildWasmRequest, type WasmStepErrorPayload } from "./abi.js";
import { WasmHostError } from "./errors.js";
import { WasmStepModule, loadWasmModule, type WasmModuleOptions } from "./instance.js";
import type { WasmSource } from "./runtime.js";

export interface WasmHandlerOptions extends WasmModuleOptions {
  /** 注册用的名字；只影响错误信息 */
  handlerName?: string;
}

/**
 * 把一个 wasm 模块变成普通的 `StepHandler`。
 *
 * Core 完全不知道这是 wasm —— 它拿到的东西和其他 handler 一模一样。
 * 这就是「extension 而不是 Core」的具体含义。
 */
export function createWasmHandler(source: WasmSource, options: WasmHandlerOptions = {}): StepHandler {
  const loaded = loadWasmModule(source, {
    ...options,
    ...(options.handlerName === undefined ? {} : { name: options.handlerName }),
  });
  return handlerFor(loaded);
}

/** 复用同一个模块实例（推荐：模块实例化不便宜，而且这样内存复用更可控）。 */
export function handlerFor(module: WasmStepModule): StepHandler {
  return {
    async execute(context, config): Promise<StepResult> {
      const response = module.invoke(buildWasmRequest(context, isJsonObject(config) ? config : undefined));

      switch (response.status) {
        case "completed":
          return {
            status: "completed",
            ...(response.output === undefined ? {} : { output: response.output }),
            ...(response.patch === undefined ? {} : { patch: response.patch }),
          };
        case "waiting":
          return response.wakeAt === undefined
            ? { status: "waiting", waitFor: response.waitFor }
            : { status: "waiting", waitFor: response.waitFor, wakeAt: response.wakeAt };
        case "failed":
          return { status: "failed", error: toWorkflowError(response.error, module.name) };
      }
    },
  };
}

/**
 * 批量注册 —— 第三方接入的入口就是这一句。
 *
 * ```ts
 * registerWasmHandlers(registry, {
 *   "text.extract": await readFile("./extract.wasm"),
 *   "rules.evaluate": await readFile("./rules.wasm"),
 * });
 * ```
 */
export function registerWasmHandlers(
  registry: Registry,
  modules: Record<string, WasmSource>,
  options: WasmHandlerOptions = {},
): Registry {
  for (const [name, source] of Object.entries(modules)) {
    registry.register(name, createWasmHandler(source, { ...options, handlerName: name }));
  }
  return registry;
}

function toWorkflowError(payload: WasmStepErrorPayload, moduleName: string): WorkflowError {
  const message = payload.message ?? `wasm 模块 "${moduleName}" 报告失败`;
  const details: JsonObject = { ...(payload.details ?? {}), module: moduleName };

  if (payload.code === "UNKNOWN_OUTCOME") {
    // 保持一等语义：外部结果未知 → 引擎永不自动重试
    return new UnknownOutcomeError(message, { details });
  }
  if (payload.code === "STEP_FAILED" || payload.code === undefined) {
    return new WorkflowError(message, { code: "STEP_FAILED", retryable: payload.retryable ?? false, details });
  }
  if (payload.code === "STEP_TIMEOUT") {
    return new WorkflowError(message, { code: "STEP_TIMEOUT", retryable: payload.retryable ?? true, details });
  }
  return new WorkflowError(message, {
    code: payload.code as WorkflowErrorCode,
    retryable: payload.retryable ?? false,
    details,
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { WasmHostError, WasmStepModule, loadWasmModule };
export type { WasmModuleOptions };
