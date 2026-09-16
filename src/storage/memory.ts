import { randomUUID } from "node:crypto";

import { StorageConflictError, ValidationError } from "../core/errors.js";
import type { WorkflowDefinition } from "../definition/workflow.js";
import type { StepId } from "../definition/step.js";
import type { WorkflowEvent } from "../runtime/events.js";
import { isClaimableRunStatus, isRunDue, type RunStatus, type WorkflowRun, type WorkflowRunPatch } from "../runtime/run.js";
import { isSignalEligible, type WorkflowSignal } from "../runtime/signal.js";
import type { StepRun, StepRunPatch, StepStatus } from "../runtime/step-run.js";
import { SCHEMA_VERSION } from "./schema.js";
import type {
  ClaimOptions,
  ConsumeSignalInput,
  DefinitionRecord,
  DefinitionStore,
  EventStore,
  RunStore,
  SignalStore,
  StepRunStore,
  WaitContext,
  WorkflowStorage,
} from "./interface.js";

export interface MemoryStorageOptions {
  /** 覆盖时钟，测试用 */
  now?: () => Date;
  /** 覆盖 id 生成，测试用 */
  newId?: () => string;
}

/**
 * 内存实现的全部状态。
 *
 * 刻意把「记录表 + 索引」放在一个对象里，而不是让 store 反过来访问 storage 的公开方法 ——
 * 以前的 `runsMap()` 那种 accessor 等于把内部结构暴露成 API，调用方能绕开所有约束。
 */
interface MemoryState {
  definitions: Map<string, DefinitionRecord>;
  runs: Map<string, WorkflowRun>;
  stepRuns: Map<string, StepRun>;
  signals: Map<string, WorkflowSignal>;
  events: Map<string, WorkflowEvent>;

  /** 幂等键 → step run id（Postgres 那边是 UNIQUE 索引，这里是等价物） */
  stepRunByKey: Map<string, string>;
  /** run → step run id 列表（插入顺序，等价于 Postgres 的 ORDER BY seq） */
  stepRunsByRun: Map<string, string[]>;
  /** run → signal id 列表（插入顺序） */
  signalsByRun: Map<string, string[]>;
  /** run → event id 列表（插入顺序） */
  eventsByRun: Map<string, string[]>;
  /** run → 已入队信号的最大 seq（水位线查询用） */
  signalWatermark: Map<string, number>;
  signalSeq: number;

  now: () => Date;
  newId: () => string;
}

/**
 * 内存实现 —— tests / 本地开发 / demo 用。
 *
 * 它在语义上必须和 Postgres 实现保持一致，否则测试就是在自欺欺人：
 * - definition 已发布版本不可改（hash 不一致 → StorageConflictError）
 * - run 抢占是原子的，且**只写 lease 不改 status**
 * - signal 只能被消费一次，且要满足「可用性规则」（定向 or 水位线之后）
 * - 外键：step run / signal / event 必须指向存在的 run
 * - 顺序 = 插入顺序（用索引数组维护，等价于 Postgres 的 seq）
 */
export class MemoryWorkflowStorage implements WorkflowStorage {
  readonly now: () => Date;
  readonly newId: () => string;

  readonly #state: MemoryState;

  readonly definitions: DefinitionStore;
  readonly runs: RunStore;
  readonly steps: StepRunStore;
  readonly signals: SignalStore;
  readonly events: EventStore;

  constructor(options: MemoryStorageOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());

    this.#state = {
      definitions: new Map(),
      runs: new Map(),
      stepRuns: new Map(),
      signals: new Map(),
      events: new Map(),
      stepRunByKey: new Map(),
      stepRunsByRun: new Map(),
      signalsByRun: new Map(),
      eventsByRun: new Map(),
      signalWatermark: new Map(),
      signalSeq: 0,
      now: this.now,
      newId: this.newId,
    };

    this.definitions = new MemoryDefinitionStore(this.#state);
    this.runs = new MemoryRunStore(this.#state);
    this.steps = new MemoryStepRunStore(this.#state);
    this.signals = new MemorySignalStore(this.#state);
    this.events = new MemoryEventStore(this.#state);
  }

  async migrate(): Promise<void> {
    // 内存实现无需建表
  }

  async schemaVersion(): Promise<number> {
    return SCHEMA_VERSION;
  }

  nowIso(): string {
    return this.now().toISOString();
  }
}

/** 存进来 clone 一份，取出去再 clone 一份：调用方永远改不到库里的对象。 */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Postgres 上有外键（step_runs / signals / events → runs），内存实现必须守同一条规矩。 */
function requireRunExists(state: MemoryState, runId: string, what: string): void {
  if (!state.runs.has(runId)) {
    throw new StorageConflictError(`${what} 引用的 run "${runId}" 不存在（外键约束）`, { runId });
  }
}

function listOf(map: Map<string, string[]>, key: string): string[] {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created: string[] = [];
  map.set(key, created);
  return created;
}

class MemoryDefinitionStore implements DefinitionStore {
  constructor(readonly state: MemoryState) {}

  async save(input: { definition: WorkflowDefinition; definitionHash: string }): Promise<DefinitionRecord> {
    const { definition, definitionHash } = input;
    const key = `${definition.id}@${definition.version}`;
    const existing = this.state.definitions.get(key);

    if (existing !== undefined) {
      if (existing.definitionHash !== definitionHash) {
        throw new StorageConflictError(
          `workflow "${definition.id}" v${definition.version} 已发布，内容不可修改（请发新版本）`,
          { workflowId: definition.id, version: definition.version },
        );
      }
      return clone(existing);
    }

    const record: DefinitionRecord = {
      workflowId: definition.id,
      version: definition.version,
      definition: clone(definition),
      definitionHash,
      createdAt: this.state.now().toISOString(),
    };
    this.state.definitions.set(key, record);
    return clone(record);
  }

  async get(workflowId: string, version: number): Promise<WorkflowDefinition | null> {
    const record = this.state.definitions.get(`${workflowId}@${version}`);
    return record === undefined ? null : clone(record.definition);
  }

  async getLatest(workflowId: string): Promise<WorkflowDefinition | null> {
    const versions = await this.listVersions(workflowId);
    const latest = versions.at(-1);
    return latest === undefined ? null : this.get(workflowId, latest);
  }

  async listVersions(workflowId: string): Promise<number[]> {
    return [...this.state.definitions.values()]
      .filter((record) => record.workflowId === workflowId)
      .map((record) => record.version)
      .sort((a, b) => a - b);
  }

  async listWorkflowIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const record of this.state.definitions.values()) ids.add(record.workflowId);
    return [...ids].sort();
  }
}

class MemoryRunStore implements RunStore {
  constructor(readonly state: MemoryState) {}

  async create(run: WorkflowRun): Promise<void> {
    // 与 Postgres 的主键约束对齐：重复 id 必须报错，而不是悄悄覆盖
    if (this.state.runs.has(run.id)) {
      throw new StorageConflictError(`run "${run.id}" 已存在`, { runId: run.id });
    }
    this.state.runs.set(run.id, clone(run));
  }

  async get(runId: string): Promise<WorkflowRun | null> {
    const run = this.state.runs.get(runId);
    return run === undefined ? null : clone(run);
  }

  async update(runId: string, patch: WorkflowRunPatch): Promise<void> {
    const current = this.state.runs.get(runId);
    if (current === undefined) return;
    const next: WorkflowRun = { ...current, ...patch, updatedAt: this.state.now().toISOString() };
    this.state.runs.set(runId, next);
  }

  async listByStatus(status: RunStatus, limit?: number): Promise<WorkflowRun[]> {
    const matched = [...this.state.runs.values()]
      .filter((run) => run.status === status)
      .sort(byCreatedAt);
    return clone(limit === undefined ? matched : matched.slice(0, limit));
  }

  async claimDue(options: ClaimOptions): Promise<WorkflowRun[]> {
    const at = options.now ?? this.state.now().toISOString();
    const leaseExpiresAt = new Date(Date.parse(at) + options.leaseMs).toISOString();

    const due = [...this.state.runs.values()]
      .filter(
        (run) =>
          isClaimableRunStatus(run.status) &&
          (run.leaseExpiresAt === null || run.leaseExpiresAt < at) &&
          (isRunDue(run, at) || this.#hasPendingSignal(run)),
      )
      .sort(byCreatedAt)
      .slice(0, options.limit);

    for (const run of due) {
      // 只写 lease，不改 status —— 状态语义由 engine 单独负责。
      // 否则 claim 会把 CREATED / WAITING 抹掉，engine 就再也看不到「这个 run 还没开始」
      // 或「这一步在等信号」，审计事件（workflow.started）也会被吞掉。
      run.leaseOwner = options.owner;
      run.leaseExpiresAt = leaseExpiresAt;
      run.updatedAt = at;
    }

    return clone(due);
  }

  async renewLease(runId: string, owner: string, leaseMs: number, now?: string): Promise<boolean> {
    const run = this.state.runs.get(runId);
    if (run === undefined || run.leaseOwner !== owner) return false;

    const at = now ?? this.state.now().toISOString();
    run.leaseExpiresAt = new Date(Date.parse(at) + leaseMs).toISOString();
    run.updatedAt = at;
    return true;
  }

  async releaseLease(runId: string, owner: string): Promise<void> {
    const run = this.state.runs.get(runId);
    if (run === undefined || run.leaseOwner !== owner) return;
    run.leaseOwner = null;
    run.leaseExpiresAt = null;
    run.updatedAt = this.state.now().toISOString();
  }

  /**
   * 删除**已经结束**且结束时间早于 `before` 的 run（连带 step run / signal / event）。
   *
   * 只删终态：RUNNING / WAITING 的 run 正在被别的 worker 处理，删掉就是数据事故。
   */
  async deleteTerminalBefore(before: string, limit?: number): Promise<number> {
    const victims = [...this.state.runs.values()]
      .filter((run) => isTerminal(run.status) && run.completedAt !== null && run.completedAt < before)
      .sort(byCreatedAt)
      .slice(0, limit ?? Number.POSITIVE_INFINITY);

    for (const run of victims) {
      this.#deleteRun(run.id);
    }
    return victims.length;
  }

  #deleteRun(runId: string): void {
    for (const stepRunId of this.state.stepRunsByRun.get(runId) ?? []) {
      const stepRun = this.state.stepRuns.get(stepRunId);
      if (stepRun !== undefined) this.state.stepRunByKey.delete(stepRun.idempotencyKey);
      this.state.stepRuns.delete(stepRunId);
    }
    for (const signalId of this.state.signalsByRun.get(runId) ?? []) this.state.signals.delete(signalId);
    for (const eventId of this.state.eventsByRun.get(runId) ?? []) this.state.events.delete(eventId);

    this.state.stepRunsByRun.delete(runId);
    this.state.signalsByRun.delete(runId);
    this.state.eventsByRun.delete(runId);
    this.state.signalWatermark.delete(runId);
    this.state.runs.delete(runId);
  }

  /** 与 CLAIM_DUE_SQL 里的 EXISTS 子查询同一个规则（conformance 盯着两边别跑偏） */
  #hasPendingSignal(run: WorkflowRun): boolean {
    if (run.status !== "WAITING" || run.currentStepRunId === null) return false;
    const active = this.state.stepRuns.get(run.currentStepRunId);
    const wait = waitContextOf(active);
    if (wait === null) return false;

    for (const signalId of this.state.signalsByRun.get(run.id) ?? []) {
      const signal = this.state.signals.get(signalId);
      if (signal === undefined || signal.consumedAt !== null) continue;
      if (isSignalEligible(signal, wait)) return true;
    }
    return false;
  }
}

class MemoryStepRunStore implements StepRunStore {
  constructor(readonly state: MemoryState) {}

  async create(stepRun: StepRun): Promise<void> {
    requireRunExists(this.state, stepRun.runId, "step run");
    if (this.state.stepRuns.has(stepRun.id)) {
      throw new StorageConflictError(`step run "${stepRun.id}" 已存在`, { stepRunId: stepRun.id });
    }
    // 与 Postgres 的 UNIQUE(idempotency_key) 对齐：这是「重复副作用」的最后一道闸
    if (this.state.stepRunByKey.has(stepRun.idempotencyKey)) {
      throw new StorageConflictError(`幂等键 "${stepRun.idempotencyKey}" 已存在`, {
        idempotencyKey: stepRun.idempotencyKey,
      });
    }

    this.state.stepRuns.set(stepRun.id, clone(stepRun));
    this.state.stepRunByKey.set(stepRun.idempotencyKey, stepRun.id);
    listOf(this.state.stepRunsByRun, stepRun.runId).push(stepRun.id);
  }

  async get(stepRunId: string): Promise<StepRun | null> {
    const stepRun = this.state.stepRuns.get(stepRunId);
    return stepRun === undefined ? null : clone(stepRun);
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<StepRun | null> {
    const id = this.state.stepRunByKey.get(idempotencyKey);
    return id === undefined ? null : this.get(id);
  }

  async findLatest(runId: string, stepId: StepId): Promise<StepRun | null> {
    let latest: StepRun | null = null;
    for (const stepRun of this.#byRun(runId)) {
      if (stepRun.stepId !== stepId) continue;
      if (latest === null || stepRun.visit > latest.visit) latest = stepRun;
    }
    return latest === null ? null : clone(latest);
  }

  async listByRun(runId: string): Promise<StepRun[]> {
    return clone(this.#byRun(runId));
  }

  async listByStatus(runId: string, status: StepStatus): Promise<StepRun[]> {
    return clone(this.#byRun(runId).filter((stepRun) => stepRun.status === status));
  }

  async update(stepRunId: string, patch: StepRunPatch): Promise<void> {
    const current = this.state.stepRuns.get(stepRunId);
    if (current === undefined) return;

    // 幂等键理论上不会变；真变了就同步索引，别留下脏指针
    if (patch.idempotencyKey !== undefined && patch.idempotencyKey !== current.idempotencyKey) {
      this.state.stepRunByKey.delete(current.idempotencyKey);
      this.state.stepRunByKey.set(patch.idempotencyKey, stepRunId);
    }

    const next: StepRun = { ...current, ...patch, updatedAt: this.state.now().toISOString() };
    this.state.stepRuns.set(stepRunId, next);
  }

  async countByRun(runId: string): Promise<number> {
    return this.#byRun(runId).length;
  }

  /** 按插入顺序取某个 run 的 step run（等价于 Postgres 的 ORDER BY seq） */
  #byRun(runId: string): StepRun[] {
    const records: StepRun[] = [];
    for (const id of this.state.stepRunsByRun.get(runId) ?? []) {
      const stepRun = this.state.stepRuns.get(id);
      if (stepRun !== undefined) records.push(stepRun);
    }
    return records;
  }
}

class MemorySignalStore implements SignalStore {
  constructor(readonly state: MemoryState) {}

  async append(signal: Omit<WorkflowSignal, "seq">): Promise<WorkflowSignal> {
    requireRunExists(this.state, signal.runId, "signal");
    if (this.state.signals.has(signal.id)) {
      throw new StorageConflictError(`signal "${signal.id}" 已存在`, { signalId: signal.id });
    }

    // seq 由 storage 分配，调用方传什么都不算
    this.state.signalSeq += 1;
    const stored: WorkflowSignal = { ...clone(signal), seq: this.state.signalSeq };
    this.state.signals.set(stored.id, stored);
    listOf(this.state.signalsByRun, stored.runId).push(stored.id);
    this.state.signalWatermark.set(stored.runId, stored.seq);
    return clone(stored);
  }

  async watermark(runId: string): Promise<number> {
    return this.state.signalWatermark.get(runId) ?? 0;
  }

  async consumeNext(input: ConsumeSignalInput): Promise<WorkflowSignal | null> {
    for (const signalId of this.state.signalsByRun.get(input.runId) ?? []) {
      const signal = this.state.signals.get(signalId);
      if (signal === undefined || signal.consumedAt !== null) continue;
      if (!isSignalEligible(signal, input)) continue;
      signal.consumedAt = input.now ?? this.state.now().toISOString();
      return clone(signal);
    }
    return null;
  }

  async listByRun(runId: string): Promise<WorkflowSignal[]> {
    return clone(
      (this.state.signalsByRun.get(runId) ?? [])
        .map((id) => this.state.signals.get(id))
        .filter((signal): signal is WorkflowSignal => signal !== undefined),
    );
  }

  async countPending(runId: string): Promise<number> {
    let count = 0;
    for (const id of this.state.signalsByRun.get(runId) ?? []) {
      if (this.state.signals.get(id)?.consumedAt === null) count += 1;
    }
    return count;
  }
}

class MemoryEventStore implements EventStore {
  constructor(readonly state: MemoryState) {}

  async append(event: WorkflowEvent): Promise<void> {
    requireRunExists(this.state, event.runId, "event");
    if (this.state.events.has(event.id)) {
      throw new StorageConflictError(`event "${event.id}" 已存在`, { eventId: event.id });
    }
    this.state.events.set(event.id, clone(event));
    listOf(this.state.eventsByRun, event.runId).push(event.id);
  }

  async listByRun(runId: string, options: { limit?: number; after?: string } = {}): Promise<WorkflowEvent[]> {
    const all = (this.state.eventsByRun.get(runId) ?? [])
      .map((id) => this.state.events.get(id))
      .filter((event): event is WorkflowEvent => event !== undefined);

    let startIndex = 0;
    if (options.after !== undefined) {
      const index = all.findIndex((event) => event.id === options.after);
      if (index === -1) {
        // 与 Postgres 对齐：游标不存在是客户端的问题，不能默默返回全部
        throw new ValidationError(`事件游标 "${options.after}" 不存在（run ${runId}）`, {
          details: { runId, after: options.after },
        });
      }
      startIndex = index + 1;
    }

    const sliced = all.slice(startIndex);
    return clone(options.limit === undefined ? sliced : sliced.slice(0, options.limit));
  }
}

/** step run → 等待上下文（与 SQL 里的 join 条件一一对应） */
function waitContextOf(active: StepRun | undefined): WaitContext | null {
  if (active === undefined || active.waitFor === null) return null;
  return { name: active.waitFor, stepId: active.stepId, sinceSeq: active.waitSinceSeq ?? 0 };
}

function isTerminal(status: RunStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}

/**
 * 只比 createdAt。同一时刻的并列用插入顺序（Array#sort 是稳定排序）——
 * 注意不要用 id 做 tiebreak：字符串序下 "id-10" < "id-2"，那是排障时的经典陷阱。
 */
function byCreatedAt(a: { createdAt: string }, b: { createdAt: string }): number {
  if (a.createdAt === b.createdAt) return 0;
  return a.createdAt < b.createdAt ? -1 : 1;
}
