import { isJsonValue, type JsonObject, type JsonValue } from "../../json.js";
import type { StepResume } from "../../runtime/builtins.js";
import type { StepExecutionContext } from "../../core/runner.js";
import { WasmHostError } from "./errors.js";

/**
 * ABI v1 —— 跨 wasm 边界的唯一协议。
 *
 * 刻意保持 **JSON in / JSON out**：这样将来换执行模式（worker_threads、远程宿主）
 * 都不需要改协议，也不需要动 Core。
 *
 * 完整规范见 docs/wasm-abi.md。
 */
export const WASM_ABI_VERSION = 1;

/** 宿主写请求 / 模块写响应时，不允许超过这个大小（防跑飞的模块） */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface WasmStepRequest {
  abi: number;
  stepId: string;
  runId: string;
  stepRunId: string;
  attempt: number;
  visit: number;
  idempotencyKey: string;
  input?: JsonValue;
  context: JsonObject;
  config?: JsonObject;
  resume?: StepResume;
}

export type WasmStepResponse =
  | { status: "completed"; output?: JsonValue; patch?: JsonObject }
  | { status: "waiting"; waitFor: string; wakeAt?: string }
  | { status: "failed"; error: WasmStepErrorPayload };

export interface WasmStepErrorPayload {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: JsonObject;
}

/** 模块能用的错误码白名单 —— 不允许模块凭空发明错误语义。 */
export const WASM_ERROR_CODES = [
  "STEP_FAILED",
  "STEP_TIMEOUT",
  "UNKNOWN_OUTCOME",
  "VALIDATION_ERROR",
  "LIMIT_EXCEEDED",
  "WORKFLOW_ERROR",
] as const;

export type WasmErrorCode = (typeof WASM_ERROR_CODES)[number];

/** 把 engine 的执行上下文压成 JSON 请求（`AbortSignal` 跨不过去，也不该跨）。 */
export function buildWasmRequest(context: StepExecutionContext, config: JsonObject | undefined): WasmStepRequest {
  const request: WasmStepRequest = {
    abi: WASM_ABI_VERSION,
    stepId: context.stepId,
    runId: context.runId,
    stepRunId: context.stepRunId,
    attempt: context.attempt,
    visit: context.visit,
    idempotencyKey: context.idempotencyKey,
    context: context.context,
  };
  if (context.input !== undefined) request.input = context.input;
  if (config !== undefined) request.config = config;
  if (context.resume !== undefined) request.resume = context.resume;
  return request;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeRequest(request: WasmStepRequest): Uint8Array {
  return encoder.encode(JSON.stringify(request));
}

/** 解析模块返回的响应，任何不合规的地方都抛 WasmHostError（kind: wasm.response）。 */
export function decodeResponse(bytes: Uint8Array, moduleName: string): WasmStepResponse {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch (cause) {
    throw responseError(moduleName, "响应不是合法 UTF-8", cause);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw responseError(moduleName, `响应不是合法 JSON：${preview(text)}`, cause);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw responseError(moduleName, "响应必须是 JSON 对象");
  }

  const record = parsed as Record<string, unknown>;
  switch (record["status"]) {
    case "completed":
      return {
        status: "completed",
        ...(record["output"] === undefined ? {} : { output: assertJson(moduleName, "output", record["output"]) }),
        ...(record["patch"] === undefined ? {} : { patch: assertObject(moduleName, "patch", record["patch"]) }),
      };

    case "waiting": {
      const waitFor = record["waitFor"];
      if (typeof waitFor !== "string" || waitFor.length === 0) {
        throw responseError(moduleName, "waiting 响应必须带非空的 waitFor");
      }
      const wakeAt = record["wakeAt"];
      if (wakeAt !== undefined && typeof wakeAt !== "string") {
        throw responseError(moduleName, "wakeAt 必须是 ISO 时间字符串");
      }
      return wakeAt === undefined ? { status: "waiting", waitFor } : { status: "waiting", waitFor, wakeAt };
    }

    case "failed": {
      const error = record["error"];
      if (typeof error !== "object" || error === null || Array.isArray(error)) {
        throw responseError(moduleName, "failed 响应必须带 error 对象");
      }
      return { status: "failed", error: assertErrorPayload(moduleName, error as Record<string, unknown>) };
    }

    default:
      throw responseError(
        moduleName,
        `未知的 status：${JSON.stringify(record["status"])}（只允许 completed / waiting / failed）`,
      );
  }
}

function assertErrorPayload(moduleName: string, raw: Record<string, unknown>): WasmStepErrorPayload {
  const payload: WasmStepErrorPayload = {};

  if (raw["code"] !== undefined) {
    const code = raw["code"];
    if (typeof code !== "string") throw responseError(moduleName, "error.code 必须是字符串");
    // 白名单之外一律降级 —— 模块不该能定义新的错误语义
    payload.code = (WASM_ERROR_CODES as readonly string[]).includes(code) ? code : "STEP_FAILED";
  }
  if (raw["message"] !== undefined) {
    if (typeof raw["message"] !== "string") throw responseError(moduleName, "error.message 必须是字符串");
    payload.message = raw["message"];
  }
  if (raw["retryable"] !== undefined) {
    if (typeof raw["retryable"] !== "boolean") throw responseError(moduleName, "error.retryable 必须是布尔值");
    payload.retryable = raw["retryable"];
  }
  if (raw["details"] !== undefined) {
    payload.details = assertObject(moduleName, "error.details", raw["details"]);
  }
  return payload;
}

function assertJson(moduleName: string, field: string, value: unknown): JsonValue {
  if (!isJsonValue(value)) {
    throw responseError(moduleName, `${field} 不是 JSON 值`);
  }
  return value;
}

function assertObject(moduleName: string, field: string, value: unknown): JsonObject {
  const json = assertJson(moduleName, field, value);
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw responseError(moduleName, `${field} 必须是 JSON 对象`);
  }
  return json;
}

function responseError(moduleName: string, message: string, cause?: unknown): WasmHostError {
  return new WasmHostError(`wasm 模块 "${moduleName}" 响应非法：${message}`, {
    kind: "wasm.response",
    moduleName,
    ...(cause === undefined ? {} : { cause }),
  });
}

function preview(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}…` : JSON.stringify(text);
}
