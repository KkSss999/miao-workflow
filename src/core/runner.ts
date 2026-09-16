import type { StepId } from "../definition/step.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { IsoTimestamp } from "../runtime/run.js";
import type { WorkflowStorage } from "../storage/interface.js";
import { NotImplementedError, type WorkflowError } from "./errors.js";
import type { Registry } from "./registry.js";

/**
 * Handler 契约 —— 整个系统最核心的抽象。
 *
 * Handler 只回答两个问题：
 *   1. 这一步怎么做？
 *   2. 做完之后 context 要怎么变？
 *
 * 它**不**回答：下一步去哪（transition 回答）、失败要不要重试（retry policy 回答）、
 * 状态怎么落库（storage 回答）。
 */
export interface StepExecutionContext {
  runId: string;
  stepRunId: string;
  stepId: StepId;

  /** 上一步的 output（start 步骤则为 run.input） */
  input: JsonValue | undefined;
  /** 到目前为止累积的 context */
  context: JsonObject;

  /** 1-based 尝试次数 */
  attempt: number;
  /** 第几次进入这个 step（V1 恒为 1） */
  visit: number;

  /**
   * 幂等键：同一次 step run 的所有 attempt 共用。
   * 调外部 API 时请带上（Stripe / Resend 等都支持 Idempotency-Key）。
   */
  idempotencyKey: string;

  /** 超时 / 取消信号，传给 fetch 之类的 API */
  signal: AbortSignal;
}

/**
 * Step 的结果只有三种形态。刻意不提供第四种。
 *
 * - `completed` —— 成功，可以带 output 与 context patch
 * - `waiting`   —— 挂起等信号（human-in-the-loop / delay），没有 Promise 挂在那里
 * - `failed`    —— 失败；是否重试由 retry policy 决定，不由 handler 决定
 */
export type StepResult<TOutput = unknown> =
  | { status: "completed"; output?: TOutput; patch?: JsonObject }
  | { status: "waiting"; waitFor: string; wakeAt?: IsoTimestamp }
  | { status: "failed"; error: WorkflowError };

/**
 * @typeParam TConfig 该 handler 期望的 config（definition 里的 `config` 字段）
 * @typeParam TOutput 输出
 *
 * 两个泛型都不做类型层约束 —— 因为 TypeScript 的 interface 没有隐式 index signature，
 * 强制 `extends JsonValue` 会逼使用者把 interface 改成 type 别名，那太烦人。
 *
 * 「output / patch 必须是 JSON」由运行时守：engine 拿到结果后会做一次
 * `isJsonValue` 检查，MemoryStorage 另有 structuredClone 兜底（Phase A 接上）。
 */
export interface StepHandler<TConfig = unknown, TOutput = unknown> {
  execute(context: StepExecutionContext, config: TConfig): Promise<StepResult<TOutput>>;
}

export interface StepRunnerOptions {
  registry: Registry;
  storage: WorkflowStorage;
}

export interface StepExecutionOutcome {
  nextStepId: StepId | null;
}

/**
 * 执行单个 step：建 step_run → 调 handler → 落库 → 决定下一步。
 *
 * 骨架阶段只有形状，实现落在 Phase A / Phase C。
 */
export class StepRunner {
  constructor(readonly options: StepRunnerOptions) {}

  async executeStep(_runId: string, _stepId: StepId): Promise<StepExecutionOutcome> {
    throw new NotImplementedError("StepRunner.executeStep（Phase A）");
  }
}
