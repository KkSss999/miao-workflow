import type { WorkflowDefinition } from "../definition/workflow.js";
import type { StepId } from "../definition/step.js";
import type { WorkflowEvent } from "../runtime/events.js";
import type { RunStatus, WorkflowRun, WorkflowRunPatch } from "../runtime/run.js";
import type { WorkflowSignal } from "../runtime/signal.js";
import type { StepRun, StepRunPatch, StepStatus } from "../runtime/step-run.js";

/**
 * Storage 只保证一件事：**死了以后还记得做到哪。**
 *
 * Core 不认识 PostgreSQL，也不认识 Redis。它只认识这五个 Store。
 */

export interface DefinitionRecord {
  workflowId: string;
  version: number;
  definition: WorkflowDefinition;
  definitionHash: string;
  createdAt: string;
}

export interface DefinitionStore {
  /**
   * 幂等写入：
   * - 同 version + 同 hash → 什么都不做
   * - 同 version + 不同 hash → 抛 StorageConflictError（已发布版本不可修改）
   */
  save(input: { definition: WorkflowDefinition; definitionHash: string }): Promise<DefinitionRecord>;
  get(workflowId: string, version: number): Promise<WorkflowDefinition | null>;
  getLatest(workflowId: string): Promise<WorkflowDefinition | null>;
  listVersions(workflowId: string): Promise<number[]>;
  listWorkflowIds(): Promise<string[]>;
}

export interface ClaimOptions {
  /** worker 标识，写进 lease_owner */
  owner: string;
  limit: number;
  leaseMs: number;
  /** 覆盖「现在」，测试用 */
  now?: string;
}

export interface RunStore {
  create(run: WorkflowRun): Promise<void>;
  get(runId: string): Promise<WorkflowRun | null>;
  update(runId: string, patch: WorkflowRunPatch): Promise<void>;
  listByStatus(status: RunStatus, limit?: number): Promise<WorkflowRun[]>;

  /**
   * 原子抢占到期的 run。
   *
   * 抢的条件：
   *   - status 属于 CLAIMABLE_RUN_STATUSES
   *   - 到点了：ACTIVE 看 wake_at（null 或已过期）；WAITING 必须有 wake_at 且已过 ——
   *     等信号的 WAITING（wake_at IS NULL）抢了也没信号，只会空转
   *   - 没有被别人持有的有效 lease
   *
   * Postgres 实现是这条（不需要 Redis）：
   *
   * ```sql
   * SELECT id FROM workflow_runs
   *  WHERE status IN ('CREATED','RUNNING','RETRYING','WAITING')
   *    AND (status <> 'WAITING' OR wake_at IS NOT NULL)
   *    AND (wake_at IS NULL OR wake_at <= NOW())
   *    AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
   *  ORDER BY created_at
   *  FOR UPDATE SKIP LOCKED
   *  LIMIT $1;
   * ```
   *
   * 返回的 run 必须已经把 lease 写成本次 owner。
   */
  claimDue(options: ClaimOptions): Promise<WorkflowRun[]>;

  /** 续租。返回 false 表示 lease 已经不是自己的了（LeaseLostError 的前兆）。 */
  renewLease(runId: string, owner: string, leaseMs: number, now?: string): Promise<boolean>;
  /** 主动释放，让别的 worker 马上能接手。 */
  releaseLease(runId: string, owner: string): Promise<void>;
}

export interface StepRunStore {
  create(stepRun: StepRun): Promise<void>;
  get(stepRunId: string): Promise<StepRun | null>;
  /** 幂等键查历史：重试前先看这一步是不是已经成功过了 */
  getByIdempotencyKey(idempotencyKey: string): Promise<StepRun | null>;
  /** 某个 step 最近一次的执行记录 */
  findLatest(runId: string, stepId: StepId): Promise<StepRun | null>;
  listByRun(runId: string): Promise<StepRun[]>;
  listByStatus(runId: string, status: StepStatus): Promise<StepRun[]>;
  update(stepRunId: string, patch: StepRunPatch): Promise<void>;
  countByRun(runId: string): Promise<number>;
}

export interface SignalStore {
  append(signal: WorkflowSignal): Promise<void>;
  /**
   * 消费最老的一条未消费信号，并原子地打上 consumed_at。
   *
   * 同一条信号只能被消费一次 —— 重复点两次「Approve」不会推进两次。
   * 没有未消费信号时返回 null。
   */
  consumeNext(runId: string, name: string, now?: string): Promise<WorkflowSignal | null>;
  listByRun(runId: string): Promise<WorkflowSignal[]>;
  countPending(runId: string): Promise<number>;
}

export interface EventStore {
  /** 只追加，永不修改 */
  append(event: WorkflowEvent): Promise<void>;
  listByRun(runId: string, options?: { limit?: number; after?: string }): Promise<WorkflowEvent[]>;
}

export interface WorkflowStorage {
  readonly definitions: DefinitionStore;
  readonly runs: RunStore;
  readonly steps: StepRunStore;
  readonly signals: SignalStore;
  readonly events: EventStore;
  /** 建表 / 迁移。Memory 实现是 no-op。 */
  migrate(): Promise<void>;
}
