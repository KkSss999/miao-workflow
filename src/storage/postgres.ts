import { NotImplementedError } from "../core/errors.js";
import type { WorkflowDefinition } from "../definition/workflow.js";
import type { WorkflowEvent } from "../runtime/events.js";
import type { RunStatus, WorkflowRun, WorkflowRunPatch } from "../runtime/run.js";
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

/**
 * 最小 SQL 客户端形状。
 *
 * 刻意不 import `pg` —— 库本身零运行时依赖，用的人把 pool 传进来就行：
 *
 * ```ts
 * import { Pool } from "pg";
 * const storage = new PostgresWorkflowStorage({ client: pool });
 * await storage.migrate();
 * ```
 */
export interface SqlQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface SqlClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
}

export interface PostgresStorageOptions {
  client: SqlClient;
  /** 表所在 schema，默认 public */
  schema?: string;
  now?: () => Date;
}

/**
 * PostgreSQL adapter —— Phase B 的实现目标。
 *
 * 设计约束（来自定位）：只依赖 Postgres。不要求 Redis、不要求独立 worker 集群、
 * 不要求分布式 scheduler。并发抢占靠 `FOR UPDATE SKIP LOCKED`。
 *
 * 建表语句见 `docs/postgres-schema.sql`。
 */
export class PostgresWorkflowStorage implements WorkflowStorage {
  readonly client: SqlClient;
  readonly schema: string;
  readonly now: () => Date;

  readonly definitions: DefinitionStore;
  readonly runs: RunStore;
  readonly steps: StepRunStore;
  readonly signals: SignalStore;
  readonly events: EventStore;

  constructor(options: PostgresStorageOptions) {
    this.client = options.client;
    this.schema = options.schema ?? "public";
    this.now = options.now ?? (() => new Date());

    this.definitions = new PostgresDefinitionStore(this);
    this.runs = new PostgresRunStore(this);
    this.steps = new PostgresStepRunStore(this);
    this.signals = new PostgresSignalStore(this);
    this.events = new PostgresEventStore(this);
  }

  async migrate(): Promise<void> {
    throw new NotImplementedError("PostgresWorkflowStorage.migrate（Phase B）");
  }
}

class PostgresDefinitionStore implements DefinitionStore {
  constructor(readonly storage: PostgresWorkflowStorage) {}

  async save(_input: { definition: WorkflowDefinition; definitionHash: string }): Promise<DefinitionRecord> {
    throw new NotImplementedError("PostgresDefinitionStore.save（Phase B）");
  }

  async get(_workflowId: string, _version: number): Promise<WorkflowDefinition | null> {
    throw new NotImplementedError("PostgresDefinitionStore.get（Phase B）");
  }

  async getLatest(_workflowId: string): Promise<WorkflowDefinition | null> {
    throw new NotImplementedError("PostgresDefinitionStore.getLatest（Phase B）");
  }

  async listVersions(_workflowId: string): Promise<number[]> {
    throw new NotImplementedError("PostgresDefinitionStore.listVersions（Phase B）");
  }

  async listWorkflowIds(): Promise<string[]> {
    throw new NotImplementedError("PostgresDefinitionStore.listWorkflowIds（Phase B）");
  }
}

class PostgresRunStore implements RunStore {
  constructor(readonly storage: PostgresWorkflowStorage) {}

  async create(_run: WorkflowRun): Promise<void> {
    throw new NotImplementedError("PostgresRunStore.create（Phase B）");
  }

  async get(_runId: string): Promise<WorkflowRun | null> {
    throw new NotImplementedError("PostgresRunStore.get（Phase B）");
  }

  async update(_runId: string, _patch: WorkflowRunPatch): Promise<void> {
    throw new NotImplementedError("PostgresRunStore.update（Phase B）");
  }

  async listByStatus(_status: RunStatus, _limit?: number): Promise<WorkflowRun[]> {
    throw new NotImplementedError("PostgresRunStore.listByStatus（Phase B）");
  }

  async claimDue(_options: ClaimOptions): Promise<WorkflowRun[]> {
    throw new NotImplementedError("PostgresRunStore.claimDue（Phase B）");
  }

  async renewLease(_runId: string, _owner: string, _leaseMs: number, _now?: string): Promise<boolean> {
    throw new NotImplementedError("PostgresRunStore.renewLease（Phase B）");
  }

  async releaseLease(_runId: string, _owner: string): Promise<void> {
    throw new NotImplementedError("PostgresRunStore.releaseLease（Phase B）");
  }
}

class PostgresStepRunStore implements StepRunStore {
  constructor(readonly storage: PostgresWorkflowStorage) {}

  async create(_stepRun: StepRun): Promise<void> {
    throw new NotImplementedError("PostgresStepRunStore.create（Phase B）");
  }

  async get(_stepRunId: string): Promise<StepRun | null> {
    throw new NotImplementedError("PostgresStepRunStore.get（Phase B）");
  }

  async getByIdempotencyKey(_idempotencyKey: string): Promise<StepRun | null> {
    throw new NotImplementedError("PostgresStepRunStore.getByIdempotencyKey（Phase B）");
  }

  async findLatest(_runId: string, _stepId: string): Promise<StepRun | null> {
    throw new NotImplementedError("PostgresStepRunStore.findLatest（Phase B）");
  }

  async listByRun(_runId: string): Promise<StepRun[]> {
    throw new NotImplementedError("PostgresStepRunStore.listByRun（Phase B）");
  }

  async listByStatus(_runId: string, _status: StepStatus): Promise<StepRun[]> {
    throw new NotImplementedError("PostgresStepRunStore.listByStatus（Phase B）");
  }

  async update(_stepRunId: string, _patch: StepRunPatch): Promise<void> {
    throw new NotImplementedError("PostgresStepRunStore.update（Phase B）");
  }

  async countByRun(_runId: string): Promise<number> {
    throw new NotImplementedError("PostgresStepRunStore.countByRun（Phase B）");
  }
}

class PostgresSignalStore implements SignalStore {
  constructor(readonly storage: PostgresWorkflowStorage) {}

  async append(_signal: WorkflowSignal): Promise<void> {
    throw new NotImplementedError("PostgresSignalStore.append（Phase D）");
  }

  async consumeNext(_runId: string, _name: string, _now?: string): Promise<WorkflowSignal | null> {
    throw new NotImplementedError("PostgresSignalStore.consumeNext（Phase D）");
  }

  async listByRun(_runId: string): Promise<WorkflowSignal[]> {
    throw new NotImplementedError("PostgresSignalStore.listByRun（Phase D）");
  }

  async countPending(_runId: string): Promise<number> {
    throw new NotImplementedError("PostgresSignalStore.countPending（Phase D）");
  }
}

class PostgresEventStore implements EventStore {
  constructor(readonly storage: PostgresWorkflowStorage) {}

  async append(_event: WorkflowEvent): Promise<void> {
    throw new NotImplementedError("PostgresEventStore.append（Phase B）");
  }

  async listByRun(_runId: string, _options?: { limit?: number; after?: string }): Promise<WorkflowEvent[]> {
    throw new NotImplementedError("PostgresEventStore.listByRun（Phase B）");
  }
}
