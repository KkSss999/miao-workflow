import type { StepId } from "../definition/step.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { SerializedWorkflowError } from "../core/errors.js";

/**
 * Run 状态机（第一原则：DB 是真相，不做 deterministic replay）。
 *
 * ```
 * CREATED ─→ RUNNING ─┬─→ WAITING ─→ RUNNING   (等 signal / delay)
 *                     ├─→ RETRYING ─→ RUNNING  (退避等待)
 *                     ├─→ COMPLETED
 *                     ├─→ FAILED
 *                     └─→ CANCELLED
 * ```
 */
export type RunStatus =
  | "CREATED"
  | "RUNNING"
  | "WAITING"
  | "RETRYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/** 需要 worker 主动推进的状态。 */
export const ACTIVE_RUN_STATUSES = ["CREATED", "RUNNING", "RETRYING"] as const satisfies readonly RunStatus[];

/** 等外部信号 / 等到期时间。worker 只在 wake_at 到点后接手。 */
export const WAITING_RUN_STATUSES = ["WAITING"] as const satisfies readonly RunStatus[];

/** worker 可以抢占的状态：ACTIVE + 已到点的 WAITING（delay）。 */
export const CLAIMABLE_RUN_STATUSES = [
  "CREATED",
  "RUNNING",
  "RETRYING",
  "WAITING",
] as const satisfies readonly RunStatus[];

export const TERMINAL_RUN_STATUSES = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const satisfies readonly RunStatus[];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function isActiveRunStatus(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function isClaimableRunStatus(status: RunStatus): boolean {
  return (CLAIMABLE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

/**
 * 这个 run 现在能不能被推进？
 *
 * - 等信号的 WAITING（wakeAt === null）**不能**抢 —— 抢了也没信号可消费，只会空转
 * - 等延迟的 WAITING 到点后才能抢
 */
export function isRunDue(run: Pick<WorkflowRun, "status" | "wakeAt">, at: IsoTimestamp): boolean {
  if (run.status === "WAITING") return run.wakeAt !== null && run.wakeAt <= at;
  return run.wakeAt === null || run.wakeAt <= at;
}

/** 时间戳统一用 UTC ISO 字符串：可 JSON 序列化、可直接字符串比较、可直接进 timestamptz。 */
export type IsoTimestamp = string;

export interface WorkflowRun {
  id: string;
  workflowId: string;
  /** 锁定 definition 版本：published v1 的 run 永远跑 v1 */
  workflowVersion: number;
  status: RunStatus;

  input: JsonValue | undefined;
  /** 步骤 output.patch 累积出来的共享上下文 */
  context: JsonObject;

  /** 即将执行的 step；null 表示还没开始或已结束 */
  currentStepId: StepId | null;

  /** WAITING / RETRYING 到点时间；ACTIVE 状态为 null */
  wakeAt: IsoTimestamp | null;

  leaseOwner: string | null;
  leaseExpiresAt: IsoTimestamp | null;

  /** 终止原因 */
  error: SerializedWorkflowError | null;

  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  completedAt: IsoTimestamp | null;
}

export type WorkflowRunPatch = Partial<Omit<WorkflowRun, "id" | "createdAt">>;
