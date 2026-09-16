import { UnknownOutcomeError, WorkflowError, type WorkflowErrorCode } from "../../core/errors.js";
import type { Registry } from "../../core/registry.js";
import type { StepHandler, StepResult } from "../../core/runner.js";
import type { JsonObject } from "../../json.js";
import { buildWasmRequest, type WasmStepErrorPayload } from "./abi.js";
import { WasmHostError } from "./errors.js";
import { loadWasmModule } from "./instance.js";
import type { WasmStepInvoker } from "./invoker.js";
import type { WasmSource } from "./runtime.js";
import { WasmWorkerHost, type WasmWorkerHostOptions } from "./worker-host.js";

export interface WasmHandlerOptions extends WasmWorkerHostOptions {
  /** 注册用的名字；只影响错误信息 */
  handlerName?: string;

  /**
   * 执行模式：
   *
   * - `"inline"`（默认）：同线程同步调用。最快，但模块里的死循环会阻塞事件循环，
   *   `step.timeoutMs` 拦不住它。**只适合自己写的、可信的模块。**
   * - `"worker"`：独立线程执行。超时（`step.timeoutMs` 或 `timeoutMs`）
   *   会 **terminate** 那个线程 —— 死循环模块也能被干掉。**第三方模块用这个。**
   */
  execution?: "inline" | "worker";
}

/**
 * 把一个 wasm 模块变成普通的 `StepHandler`。
 *
 * Core 完全不知道这是 wasm —— 它拿到的东西和其他 handler 一模一样。
 * 这就是「extension 而不是 Core」的具体含义。
 */
/**
 * 比普通 StepHandler 多一个 `dispose()` —— worker 模式要释放线程。
 * `StepHandler` 本身没有生命周期概念（Core 也不需要有），所以这是扩展自己的约定。
 */
export interface WasmStepHandler extends StepHandler {
  dispose(): Promise<void>;
}

export function createWasmHandler(source: WasmSource, options: WasmHandlerOptions = {}): WasmStepHandler {
  const name = options.handlerName;
  const common = {
    ...options,
    ...(name === undefined ? {} : { name }),
  };

  // worker 模式是**懒启动**的：第一次调用时才起线程，注册保持同步
  const invoker: WasmStepInvoker =
    options.execution === "worker" ? new WasmWorkerHost(source, common) : loadWasmModule(source, common);

  const handler = handlerFor(invoker);
  return { ...handler, dispose: async () => invoker.dispose?.() };
}

/** 复用同一个模块实例 / worker（推荐：实例化与起线程都不便宜）。 */
export function handlerFor(invoker: WasmStepInvoker): StepHandler {
  return {
    async execute(context, config): Promise<StepResult> {
      const response = await invoker.invoke(
        buildWasmRequest(context, isJsonObject(config) ? config : undefined),
        context.signal,
      );

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
          return { status: "failed", error: toWorkflowError(response.error, invoker.name) };
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

export { WasmHostError, WasmWorkerHost, loadWasmModule };
export type { WasmWorkerHostOptions };
export type { WasmStepInvoker };
