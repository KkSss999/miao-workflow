import { WorkflowError } from "../../core/errors.js";
import type { JsonObject } from "../../json.js";

/**
 * wasm 宿主自己的错误类型。
 *
 * 它**继承 Core 的 WorkflowError**，因为它就是 Core 词汇表里的东西：
 * 「这一步失败了」。kind 放在 details 里 —— 这样 Core 不需要知道什么叫 wasm，
 * 而排障的人又能一眼看出是哪一层出的问题。
 */
export type WasmHostErrorKind =
  | "wasm.abi"
  | "wasm.imports"
  | "wasm.bounds"
  | "wasm.trap"
  | "wasm.response"
  | "wasm.overrun";

export interface WasmHostErrorOptions {
  kind: WasmHostErrorKind;
  moduleName?: string;
  /** trap 这类问题重试没有意义；只有明确的瞬态错误才该重试 */
  retryable?: boolean;
  code?: "STEP_FAILED" | "STEP_TIMEOUT";
  cause?: unknown;
}

export class WasmHostError extends WorkflowError {
  readonly kind: WasmHostErrorKind;

  constructor(message: string, options: WasmHostErrorOptions) {
    const details: JsonObject = { kind: options.kind };
    if (options.moduleName !== undefined) details["module"] = options.moduleName;

    super(message, {
      code: options.code ?? "STEP_FAILED",
      retryable: options.retryable ?? false,
      details,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.kind = options.kind;
  }
}
