import type { JsonObject } from "../json.js";

/** 错误分类。比 message 字符串可靠，Engine / Worker 依据它决定语义。 */
export type WorkflowErrorCode =
  | "WORKFLOW_ERROR"
  | "VALIDATION_ERROR"
  | "DUPLICATE_REGISTRATION"
  | "HANDLER_NOT_FOUND"
  | "GUARD_NOT_FOUND"
  | "NO_MATCHING_TRANSITION"
  | "STEP_FAILED"
  | "STEP_TIMEOUT"
  | "UNKNOWN_OUTCOME"
  | "RUN_NOT_FOUND"
  | "STEP_RUN_NOT_FOUND"
  | "RUN_NOT_ACTIVE"
  | "LEASE_LOST"
  | "STORAGE_CONFLICT"
  | "LIMIT_EXCEEDED"
  | "CANCELLED"
  | "NOT_IMPLEMENTED";

export interface WorkflowErrorOptions {
  code?: WorkflowErrorCode;
  /**
   * 是否允许引擎自动重试。
   * 默认 false —— 只有明确知道副作用幂等 / 未发生时才置 true。
   */
  retryable?: boolean;
  details?: JsonObject;
  cause?: unknown;
}

/**
 * 所有 mwf 错误的基类。
 *
 * `retryable` 是语义核心：它区分「这次没成功，重试是对的」
 * 与「我们不知道外部到底发生了什么」（见 UnknownOutcomeError）。
 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly retryable: boolean;
  readonly details: JsonObject | undefined;

  constructor(message: string, options: WorkflowErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? "WORKFLOW_ERROR";
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toJSON(): SerializedWorkflowError {
    return serializeError(this);
  }
}

/** Definition 非法：结构、引用、或包含不可序列化的值。 */
export class ValidationError extends WorkflowError {
  constructor(message: string, options: Omit<WorkflowErrorOptions, "code"> = {}) {
    super(message, { ...options, code: "VALIDATION_ERROR" });
  }
}

/** 同一个 handler / guard 名字被注册两次。 */
export class DuplicateRegistrationError extends WorkflowError {
  constructor(kind: "handler" | "guard", name: string) {
    super(`${kind} "${name}" 已注册`, { code: "DUPLICATE_REGISTRATION", details: { kind, name } });
  }
}

export class HandlerNotFoundError extends WorkflowError {
  constructor(name: string) {
    super(`handler "${name}" 未注册`, { code: "HANDLER_NOT_FOUND", details: { name } });
  }
}

export class GuardNotFoundError extends WorkflowError {
  constructor(name: string) {
    super(`guard "${name}" 未注册`, { code: "GUARD_NOT_FOUND", details: { name } });
  }
}

/** 有 transition，但没有任何一个 guard 命中，且没有兜底分支。 */
export class NoMatchingTransitionError extends WorkflowError {
  constructor(stepId: string, candidates: readonly string[]) {
    super(`step "${stepId}" 没有任何 transition 命中`, {
      code: "NO_MATCHING_TRANSITION",
      details: { stepId, candidates: [...candidates] },
    });
  }
}

/**
 * 外部副作用结果未知：请求超时 / 连接中断，但对方可能已经执行成功。
 *
 * 绝对不能自动重试 —— 必须走人工或系统 reconciliation。
 */
export class UnknownOutcomeError extends WorkflowError {
  constructor(message: string, options: Omit<WorkflowErrorOptions, "code" | "retryable"> = {}) {
    super(message, { ...options, code: "UNKNOWN_OUTCOME", retryable: false });
  }
}

export class RunNotFoundError extends WorkflowError {
  constructor(runId: string) {
    super(`run "${runId}" 不存在`, { code: "RUN_NOT_FOUND", details: { runId } });
  }
}

export class StepRunNotFoundError extends WorkflowError {
  constructor(stepRunId: string) {
    super(`step run "${stepRunId}" 不存在`, { code: "STEP_RUN_NOT_FOUND", details: { stepRunId } });
  }
}

export class RunNotActiveError extends WorkflowError {
  constructor(runId: string, status: string) {
    super(`run "${runId}" 当前状态 ${status}，不接受该操作`, {
      code: "RUN_NOT_ACTIVE",
      details: { runId, status },
    });
  }
}

export class LeaseLostError extends WorkflowError {
  constructor(runId: string) {
    super(`run "${runId}" 的 lease 已被别人抢走`, { code: "LEASE_LOST", details: { runId } });
  }
}

/** 同一个 (workflowId, version) 想写入不同内容 —— 发布后的 definition 不可修改。 */
export class StorageConflictError extends WorkflowError {
  constructor(message: string, details?: JsonObject) {
    super(message, { code: "STORAGE_CONFLICT", details });
  }
}

export class LimitExceededError extends WorkflowError {
  constructor(message: string, details?: JsonObject) {
    super(message, { code: "LIMIT_EXCEEDED", details });
  }
}

/** 骨架阶段专用：功能已定型但还没实现。 */
export class NotImplementedError extends WorkflowError {
  constructor(what: string) {
    super(`${what} 尚未实现`, { code: "NOT_IMPLEMENTED", details: { what } });
  }
}

export function isWorkflowError(value: unknown): value is WorkflowError {
  return value instanceof WorkflowError;
}

/** 把任意 throw 出来的东西归一成 WorkflowError。 */
export function toWorkflowError(
  value: unknown,
  options: { message?: string; code?: WorkflowErrorCode; retryable?: boolean } = {},
): WorkflowError {
  if (value instanceof WorkflowError) return value;
  if (value instanceof Error) {
    return new WorkflowError(options.message ?? value.message, {
      code: options.code ?? "WORKFLOW_ERROR",
      retryable: options.retryable ?? false,
      cause: value,
    });
  }
  return new WorkflowError(options.message ?? `非 Error 抛出：${describe(value)}`, {
    code: options.code ?? "WORKFLOW_ERROR",
    retryable: options.retryable ?? false,
    details: { thrown: describe(value) },
  });
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 落库形态。Error 本身不可 JSON 序列化，所以存这个。 */
export interface SerializedWorkflowError {
  name: string;
  code: WorkflowErrorCode;
  message: string;
  retryable: boolean;
  details?: JsonObject;
}

export function serializeError(error: WorkflowError): SerializedWorkflowError {
  const out: SerializedWorkflowError = {
    name: error.name,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
  if (error.details !== undefined) out.details = error.details;
  return out;
}

export function deserializeError(input: SerializedWorkflowError): WorkflowError {
  return new WorkflowError(input.message, {
    code: input.code,
    retryable: input.retryable,
    details: input.details,
  });
}
