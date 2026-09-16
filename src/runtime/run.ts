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

  /**
   * 当前正在处理的那条 step run —— 这是「我做到哪」的唯一权威指针。
   *
   * 它消掉了两种情况的歧义：
   * - 崩溃在「step 已落库、run 还没推进」之间 → 指针仍指向那条 COMPLETED，
   *   恢复时直接重放 patch 并前移，**不重放副作用**
   * - 回边（A→B→A）→ 指针已被清空，于是新建一条 visit+1 的记录，是新的一次执行
   *
   * 指针可能短暂指向一条还没落库的记录（执行中崩了），恢复时按同一 id、同一
   * visit 重来，幂等键因此在崩溃前后保持不变。
   */
  currentStepRunId: string | null;

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
