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
   * 原子抢占「可以推进」的 run。
   *
   * 抢的条件（三条都要满足）：
   *   1. status 属于 CLAIMABLE_RUN_STATUSES
   *   2. **有活可干**：
   *      - ACTIVE 状态：wake_at 为空或已过期（RETRYING 就是靠 wake_at 到点）
   *      - WAITING：`wake_at` 已到点（delay / 等待超时），
   *        **或者**有一条匹配当前挂起步骤 `wait_for` 的未消费信号（人类点了 Approve）
   *   3. 没有被别人持有的有效 lease
   *
   * 第 2 条里「有匹配的未消费信号」这个分支是刻意设计的：
   * `engine.signal()` 只写一条信号、不碰 run，所以不存在「信号记下了但 run 没被叫醒」的崩溃窗口 ——
   * run 会因为这条待消费信号自然变成可抢占。代价是最多一个轮询周期的延迟。
   *
   * 返回的 run 必须已经把 lease 写成本次 owner（必须和抢占在同一条语句/事务里完成）。
   *
   * **只写 lease，不改 status**：状态语义由 engine 单独负责。claim 顺手把 status 改成 RUNNING
   * 会抹掉 `CREATED` / `WAITING` 这两个信息，engine 就分不清「还没开始」「在等信号」了。
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
