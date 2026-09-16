import type { SerializedWorkflowError } from "../core/errors.js";
import type { StepId } from "../definition/step.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { IsoTimestamp } from "./run.js";

/**
 * Step 状态机。
 *
 * ```
 * PENDING ─→ RUNNING ─┬─→ COMPLETED
 *                     ├─→ WAITING   (human.approval / workflow.delay)
 *                     ├─→ RETRYING  (退避等待，等 wake_at)
 *                     ├─→ FAILED    (重试耗尽或不可重试)
 *                     └─→ UNKNOWN   (外部结果未知，必须 reconciliation)
 * ```
 *
 * UNKNOWN 是刻意保留的一等状态：请求 timeout 时对方可能已经成功，
 * 直接 FAILED → RETRY 会造成重复副作用（重复发邮件 / 重复建单）。
 */
export type StepStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING"
  | "RETRYING"
  | "COMPLETED"
  | "FAILED"
  | "UNKNOWN";

export const TERMINAL_STEP_STATUSES = ["COMPLETED", "FAILED", "UNKNOWN"] as const satisfies readonly StepStatus[];

export function isTerminalStepStatus(status: StepStatus): boolean {
  return (TERMINAL_STEP_STATUSES as readonly StepStatus[]).includes(status);
}

export interface StepRun {
  id: string;
  runId: string;
  stepId: StepId;

  status: StepStatus;
  /** 当前（或最后一次）尝试次数，1-based。**审计用**：等待被唤醒重新执行也算一次 */
  attempt: number;
  /**
   * 这一步**真正失败**过几次。
   *
   * 重试判定用这个，不用 attempt —— 否则「等待被唤醒」也会吃掉重试预算：
   * 一个 maxAttempts=2 的审批步骤，等一次再失败就直接永久失败了。
   */
  failures: number;
  /** 第几次进入这个 step。V1 是顺序执行，恒为 1。 */
  visit: number;

  input: JsonValue | undefined;
  output: JsonValue | undefined;
  /**
   * 这一步对 context 的贡献。
   *
   * 单独存一份，是为了让 step run 自包含：崩溃恢复时不必重新执行 handler 就能
   * 把 context 重建出来（不做 deterministic replay，只做状态重放）。
   */
  patch: JsonObject | undefined;
  error: SerializedWorkflowError | null;

  /** waiting 时等的是什么（signal 名） */
  waitFor: string | null;
  /**
   * 这次等待的**信号水位线**：入队序号 <= 它的信号都算「这次等待之前来的」，不予消费。
   *
   * 这就是「同一次等待只能被之后到达的信号唤醒」的实现方式。
   */
  waitSinceSeq: number | null;
  waitPayload?: JsonValue;

  /**
   * 副作用幂等键。
   *
   * 同一次 step run 的所有 attempt 共用一个 key —— 这样重试时外部服务能识别出
   * 「这是同一次业务动作」，不会重复执行。
   */
  idempotencyKey: string;

  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
  wakeAt: IsoTimestamp | null;

  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type StepRunPatch = Partial<Omit<StepRun, "id" | "runId" | "stepId" | "createdAt">>;

/**
 * `{runId}:{stepId}:{visit}`
 *
 * 比 `{runId}:{stepId}` 多一段 visit，是为了将来真的出现回边（A→B→A）时
 * 两次访问能用不同的 key；同一次访问内的重试仍然共用。
 */
export function buildIdempotencyKey(runId: string, stepId: StepId, visit: number): string {
  return `${runId}:${stepId}:${visit}`;
}

