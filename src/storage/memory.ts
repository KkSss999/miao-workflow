import { randomUUID } from "node:crypto";

import { StorageConflictError } from "../core/errors.js";
import type { WorkflowDefinition } from "../definition/workflow.js";
import type { StepId } from "../definition/step.js";
import type { WorkflowEvent } from "../runtime/events.js";
import { isClaimableRunStatus, isRunDue, type RunStatus, type WorkflowRun, type WorkflowRunPatch } from "../runtime/run.js";
import type { WorkflowSignal } from "../runtime/signal.js";
import type { StepRun, StepRunPatch, StepStatus } from "../runtime/step-run.js";
import type {
  ClaimOptions,
  DefinitionRecord,
  DefinitionStore,
  EventStore,
  RunStore,
  SignalStore,
  StepRunStore,
  WorkflowStorage,
} from "./interface.js";

export interface MemoryStorageOptions {
  /** 覆盖时钟，测试用 */
  now?: () => Date;
  /** 覆盖 id 生成，测试用 */
  newId?: () => string;
}

/**
 * 内存实现 —— tests / 本地开发 / demo 用。
 *
 * 它在语义上必须和 Postgres 实现保持一致，否则测试就是在自欺欺人：
 * - definition 已发布版本不可改（hash 不一致 → StorageConflictError）
 * - run 抢占是原子的，同一时刻只有一个 owner 拿到 lease
 * - signal 只能被消费一次
 */
export class MemoryWorkflowStorage implements WorkflowStorage {
  readonly now: () => Date;
  readonly newId: () => string;

  readonly #definitions = new Map<string, DefinitionRecord>();
  readonly #runs = new Map<string, WorkflowRun>();
  readonly #stepRuns = new Map<string, StepRun>();
  readonly #signals = new Map<string, WorkflowSignal>();
  readonly #events = new Map<string, WorkflowEvent>();

  readonly definitions: DefinitionStore;
  readonly runs: RunStore;
  readonly steps: StepRunStore;
  readonly signals: SignalStore;
  readonly events: EventStore;

  constructor(options: MemoryStorageOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());

    this.definitions = new MemoryDefinitionStore(this);
    this.runs = new MemoryRunStore(this);
    this.steps = new MemoryStepRunStore(this);
    this.signals = new MemorySignalStore(this);
    this.events = new MemoryEventStore(this);
  }

  async migrate(): Promise<void> {
    // 内存实现无需建表
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  definitionKey(workflowId: string, version: number): string {
    return `${workflowId}@${version}`;
  }

  definitionsMap(): Map<string, DefinitionRecord> {
    return this.#definitions;
  }

  runsMap(): Map<string, WorkflowRun> {
    return this.#runs;
  }

  stepRunsMap(): Map<string, StepRun> {
    return this.#stepRuns;
  }

  signalsMap(): Map<string, WorkflowSignal> {
    return this.#signals;
  }

  eventsMap(): Map<string, WorkflowEvent> {
    return this.#events;
  }
}

/** 存进来 clone 一份，取出去再 clone 一份：调用方永远改不到库里的对象。 */
function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryDefinitionStore implements DefinitionStore {
  constructor(readonly storage: MemoryWorkflowStorage) {}

  async save(input: { definition: WorkflowDefinition; definitionHash: string }): Promise<DefinitionRecord> {
    const { definition, definitionHash } = input;
    const key = this.storage.definitionKey(definition.id, definition.version);
    const existing = this.storage.definitionsMap().get(key);

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
      createdAt: this.storage.nowIso(),
    };
    this.storage.definitionsMap().set(key, record);
    return clone(record);
  }

  async get(workflowId: string, version: number): Promise<WorkflowDefinition | null> {
    const record = this.storage.definitionsMap().get(this.storage.definitionKey(workflowId, version));
    return record === undefined ? null : clone(record.definition);
  }

  async getLatest(workflowId: string): Promise<WorkflowDefinition | null> {
    const versions = await this.listVersions(workflowId);
    const latest = versions.at(-1);
    return latest === undefined ? null : this.get(workflowId, latest);
  }

  async listVersions(workflowId: string): Promise<number[]> {
    return [...this.storage.definitionsMap().values()]
      .filter((record) => record.workflowId === workflowId)
      .map((record) => record.version)
      .sort((a, b) => a - b);
  }

  async listWorkflowIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const record of this.storage.definitionsMap().values()) ids.add(record.workflowId);
    return [...ids].sort();
  }
}

class MemoryRunStore implements RunStore {
  constructor(readonly storage: MemoryWorkflowStorage) {}

  async create(run: WorkflowRun): Promise<void> {
    this.storage.runsMap().set(run.id, clone(run));
  }

  async get(runId: string): Promise<WorkflowRun | null> {
    const run = this.storage.runsMap().get(runId);
    return run === undefined ? null : clone(run);
  }

  async update(runId: string, patch: WorkflowRunPatch): Promise<void> {
    const current = this.storage.runsMap().get(runId);
    if (current === undefined) return;
    const next: WorkflowRun = { ...current, ...patch, updatedAt: this.storage.nowIso() };
    this.storage.runsMap().set(runId, next);
  }

  async listByStatus(status: RunStatus, limit?: number): Promise<WorkflowRun[]> {
    const matched = [...this.storage.runsMap().values()]
      .filter((run) => run.status === status)
      .sort(byCreatedAt);
    return clone(limit === undefined ? matched : matched.slice(0, limit));
  }

  async claimDue(options: ClaimOptions): Promise<WorkflowRun[]> {
    const at = options.now ?? this.storage.nowIso();
    const leaseExpiresAt = new Date(Date.parse(at) + options.leaseMs).toISOString();

    const due = [...this.storage.runsMap().values()]
      .filter(
        (run) =>
          isClaimableRunStatus(run.status) &&
          isRunDue(run, at) &&
          (run.leaseExpiresAt === null || run.leaseExpiresAt < at),
      )
      .sort(byCreatedAt)
      .slice(0, options.limit);

    for (const run of due) {
      run.status = "RUNNING";
      run.leaseOwner = options.owner;
      run.leaseExpiresAt = leaseExpiresAt;
      run.updatedAt = at;
    }

    return clone(due);
  }

  async renewLease(runId: string, owner: string, leaseMs: number, now?: string): Promise<boolean> {
    const run = this.storage.runsMap().get(runId);
    if (run === undefined || run.leaseOwner !== owner) return false;

    const at = now ?? this.storage.nowIso();
    run.leaseExpiresAt = new Date(Date.parse(at) + leaseMs).toISOString();
    run.updatedAt = at;
    return true;
  }

  async releaseLease(runId: string, owner: string): Promise<void> {
    const run = this.storage.runsMap().get(runId);
    if (run === undefined || run.leaseOwner !== owner) return;
    run.leaseOwner = null;
    run.leaseExpiresAt = null;
    run.updatedAt = this.storage.nowIso();
  }
}

class MemoryStepRunStore implements StepRunStore {
  constructor(readonly storage: MemoryWorkflowStorage) {}

  async create(stepRun: StepRun): Promise<void> {
    this.storage.stepRunsMap().set(stepRun.id, clone(stepRun));
  }

  async get(stepRunId: string): Promise<StepRun | null> {
    const stepRun = this.storage.stepRunsMap().get(stepRunId);
    return stepRun === undefined ? null : clone(stepRun);
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<StepRun | null> {
    for (const stepRun of this.storage.stepRunsMap().values()) {
      if (stepRun.idempotencyKey === idempotencyKey) return clone(stepRun);
    }
    return null;
  }

  async findLatest(runId: string, stepId: StepId): Promise<StepRun | null> {
    let latest: StepRun | null = null;
    for (const stepRun of this.storage.stepRunsMap().values()) {
      if (stepRun.runId !== runId || stepRun.stepId !== stepId) continue;
      if (latest === null || stepRun.visit > latest.visit) latest = stepRun;
    }
    return latest === null ? null : clone(latest);
  }

  async listByRun(runId: string): Promise<StepRun[]> {
    // Map 的迭代顺序就是插入顺序 —— 这也是内存实现里「时间」的自然定义
    return clone([...this.storage.stepRunsMap().values()].filter((stepRun) => stepRun.runId === runId));
  }

  async listByStatus(runId: string, status: StepStatus): Promise<StepRun[]> {
    return clone(
      [...this.storage.stepRunsMap().values()].filter(
        (stepRun) => stepRun.runId === runId && stepRun.status === status,
      ),
    );
  }

  async update(stepRunId: string, patch: StepRunPatch): Promise<void> {
    const current = this.storage.stepRunsMap().get(stepRunId);
    if (current === undefined) return;
    const next: StepRun = { ...current, ...patch, updatedAt: this.storage.nowIso() };
    this.storage.stepRunsMap().set(stepRunId, next);
  }

  async countByRun(runId: string): Promise<number> {
    let count = 0;
    for (const stepRun of this.storage.stepRunsMap().values()) {
      if (stepRun.runId === runId) count += 1;
    }
    return count;
  }
}

class MemorySignalStore implements SignalStore {
  constructor(readonly storage: MemoryWorkflowStorage) {}

  async append(signal: WorkflowSignal): Promise<void> {
    this.storage.signalsMap().set(signal.id, clone(signal));
  }

  async consumeNext(runId: string, name: string, now?: string): Promise<WorkflowSignal | null> {
    for (const signal of this.storage.signalsMap().values()) {
      if (signal.runId !== runId || signal.name !== name || signal.consumedAt !== null) continue;
      signal.consumedAt = now ?? this.storage.nowIso();
      return clone(signal);
    }
    return null;
  }

  async listByRun(runId: string): Promise<WorkflowSignal[]> {
    return clone([...this.storage.signalsMap().values()].filter((signal) => signal.runId === runId));
  }

  async countPending(runId: string): Promise<number> {
    let count = 0;
    for (const signal of this.storage.signalsMap().values()) {
      if (signal.runId === runId && signal.consumedAt === null) count += 1;
    }
    return count;
  }
}

class MemoryEventStore implements EventStore {
  constructor(readonly storage: MemoryWorkflowStorage) {}

  async append(event: WorkflowEvent): Promise<void> {
    this.storage.eventsMap().set(event.id, clone(event));
  }

  async listByRun(runId: string, options: { limit?: number; after?: string } = {}): Promise<WorkflowEvent[]> {
    const all = [...this.storage.eventsMap().values()].filter((event) => event.runId === runId);

    const startIndex = options.after === undefined ? 0 : all.findIndex((event) => event.id === options.after) + 1;
    const sliced = all.slice(startIndex);
    return clone(options.limit === undefined ? sliced : sliced.slice(0, options.limit));
  }
}

/**
 * 只比 createdAt。同一时刻的并列用插入顺序（Array#sort 是稳定排序）——
 * 注意不要用 id 做 tiebreak：字符串序下 "id-10" < "id-2"，那是排障时的经典陷阱。
 */
function byCreatedAt(a: { createdAt: string }, b: { createdAt: string }): number {
  if (a.createdAt === b.createdAt) return 0;
  return a.createdAt < b.createdAt ? -1 : 1;
}
