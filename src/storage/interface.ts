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

  /**
   * 保留策略：删除**终态**且 `completedAt < before` 的 run（连带 step run / signal / event）。
   *
   * 只删终态 —— RUNNING / WAITING 的 run 可能正被别的 worker 处理，删掉就是数据事故。
   *
   * @returns 实际删掉的 run 数
   */
  deleteTerminalBefore(before: string, limit?: number): Promise<number>;
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

export interface WaitContext {
  /** 步骤在等什么（step run 的 waitFor） */
  name: string;
  /** 哪一个 step 在等（用于定向信号） */
  stepId: string;
  /** 这次等待的信号水位线（step run 的 waitSinceSeq） */
  sinceSeq: number;
}

export interface ConsumeSignalInput extends WaitContext {
  runId: string;
  now?: string;
}

export interface SignalStore {
  /**
   * 入队一条信号。
   *
   * `seq` 由 storage 分配（Postgres 是 identity 列，内存实现是自增计数器）——
   * 调用方传进来的 seq 会被忽略，返回值以 storage 分配的为准。
   */
  append(signal: Omit<WorkflowSignal, "seq">): Promise<WorkflowSignal>;
  /** 当前该 run 的信号水位线（= 已入队信号的最大 seq，没有则 0）。 */
  watermark(runId: string): Promise<number>;
  /**
   * 消费最老的一条**对这次等待可用**的信号，并原子地打上 consumed_at。
   *
   * 可用性规则见 `isSignalEligible`：名字一致 + （定向且 step 对上）或（未定向且到得比等待晚）。
   * 同一条信号只能被消费一次 —— 重复点两次「Approve」不会推进两次。
   * 没有可用信号时返回 null。
   */
  consumeNext(input: ConsumeSignalInput): Promise<WorkflowSignal | null>;
  listByRun(runId: string): Promise<WorkflowSignal[]>;
  countPending(runId: string): Promise<number>;
}

export interface EventStore {
  /** 只追加，永不修改 */
  append(event: WorkflowEvent): Promise<void>;
  /**
   * 按 run 读取审计事件（插入顺序）。
   *
   * @param options.after 上一页最后一条事件的 id（游标）。
   *   **游标不存在时抛 ValidationError** —— 两个适配器行为必须一致，
   *   否则「内存里返回全部、库里返回空」这种分歧会变成线上翻页事故。
   */
  listByRun(runId: string, options?: { limit?: number; after?: string }): Promise<WorkflowEvent[]>;
}

export interface WorkflowStorage {
  readonly definitions: DefinitionStore;
  readonly runs: RunStore;
  readonly steps: StepRunStore;
  readonly signals: SignalStore;
  readonly events: EventStore;
  /** 建表 / 迁移（幂等）。Memory 实现是 no-op。 */
  migrate(): Promise<void>;
  /** 当前 schema 版本（Memory 与 Postgres 都返回 SCHEMA_VERSION）。 */
  schemaVersion(): Promise<number>;
}
