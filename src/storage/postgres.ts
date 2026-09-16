import { StorageConflictError } from "../core/errors.js";
import type { SerializedWorkflowError } from "../core/errors.js";
import type { WorkflowDefinition } from "../definition/workflow.js";
import type { StepId } from "../definition/step.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { WorkflowEvent, WorkflowEventType } from "../runtime/events.js";
import { CLAIMABLE_RUN_STATUSES, type RunStatus, type WorkflowRun, type WorkflowRunPatch } from "../runtime/run.js";
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
import { CLAIM_DUE_SQL, CONSUME_SIGNAL_SQL, SCHEMA_SQL } from "./schema.js";

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
  /** 覆盖时钟（写 updated_at、以及 claim 的「现在」），测试用 */
  now?: () => Date;
}

/**
 * PostgreSQL adapter。
 *
 * 设计约束（来自定位）：只依赖 Postgres。不要求 Redis、不要求独立 worker 集群、
 * 不要求分布式 scheduler —— 并发抢占靠一条 `FOR UPDATE SKIP LOCKED` 的 UPDATE ... RETURNING。
 *
 * 与 `MemoryWorkflowStorage` 的语义必须逐条对齐（同一套 conformance 测试跑两边）：
 * - 已发布 definition 不可修改（hash 不一致 → StorageConflictError）
 * - 同一 run 在租期内只会被一个 owner 抢到
 * - signal 只能被消费一次
 * - 记录顺序 = 插入顺序（用自增 `seq`，不用随机 id 做 tiebreak）
 *
 * 表名不做 schema 限定，走连接的 search_path。
 */
export class PostgresWorkflowStorage implements WorkflowStorage {
  readonly client: SqlClient;
  readonly now: () => Date;

  readonly definitions: DefinitionStore;
  readonly runs: RunStore;
  readonly steps: StepRunStore;
  readonly signals: SignalStore;
  readonly events: EventStore;

  constructor(options: PostgresStorageOptions) {
    this.client = options.client;
    this.now = options.now ?? (() => new Date());

    this.definitions = new PostgresDefinitionStore(this);
    this.runs = new PostgresRunStore(this);
    this.steps = new PostgresStepRunStore(this);
    this.signals = new PostgresSignalStore(this);
    this.events = new PostgresEventStore(this);
  }

  /** 幂等建表（全部 CREATE ... IF NOT EXISTS）。 */
  async migrate(): Promise<void> {
    await this.client.query(SCHEMA_SQL);
  }
}

/* ────────────────────────────── 行 ↔ 记录映射 ────────────────────────────── */

type Timestamp = Date | string | null;

interface RunRow {
  id: string;
  workflow_id: string;
  workflow_version: number;
  status: string;
  input: JsonValue | null;
  context: JsonObject;
  current_step_id: string | null;
  current_step_run_id: string | null;
  wake_at: Timestamp;
  lease_owner: string | null;
  lease_expires_at: Timestamp;
  error: SerializedWorkflowError | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: Timestamp;
}

interface StepRunRow {
  id: string;
  run_id: string;
  step_id: string;
  status: string;
  attempt: number;
  visit: number;
  input: JsonValue | null;
  output: JsonValue | null;
  patch: JsonObject | null;
  error: SerializedWorkflowError | null;
  wait_for: string | null;
  wait_payload: JsonValue | null;
  idempotency_key: string;
  started_at: Timestamp;
  finished_at: Timestamp;
  wake_at: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface DefinitionRow {
  workflow_id: string;
  version: number;
  definition: WorkflowDefinition;
  definition_hash: string;
  created_at: Timestamp;
}

interface SignalRow {
  id: string;
  run_id: string;
  name: string;
  payload: JsonValue | null;
  created_at: Timestamp;
  consumed_at: Timestamp;
}

interface EventRow {
  id: string;
  run_id: string;
  step_id: string | null;
  type: string;
  payload: JsonObject;
  created_at: Timestamp;
}

/** pg 会把 timestamptz 解析成 Date；也兼容把 string 直接塞回来的驱动。 */
function toIso(value: Timestamp): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireIso(value: Timestamp): string {
  const iso = toIso(value);
  if (iso === null) throw new StorageConflictError("数据库返回了空的 created_at");
  return iso;
}

/** undefined 一律写成 NULL —— pg 对 undefined 的处理不值得依赖。 */
function value(input: unknown): unknown {
  return input === undefined ? null : input;
}

function toRun(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    status: row.status as RunStatus,
    input: row.input ?? undefined,
    context: row.context,
    currentStepId: row.current_step_id,
    currentStepRunId: row.current_step_run_id,
    wakeAt: toIso(row.wake_at),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: toIso(row.lease_expires_at),
    error: row.error,
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
    completedAt: toIso(row.completed_at),
  };
}

function toStepRun(row: StepRunRow): StepRun {
  const stepRun: StepRun = {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    status: row.status as StepStatus,
    attempt: row.attempt,
    visit: row.visit,
    input: row.input ?? undefined,
    output: row.output ?? undefined,
    patch: row.patch ?? undefined,
    error: row.error,
    waitFor: row.wait_for,
    idempotencyKey: row.idempotency_key,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    wakeAt: toIso(row.wake_at),
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
  };
  if (row.wait_payload !== null) stepRun.waitPayload = row.wait_payload;
  return stepRun;
}

function toSignal(row: SignalRow): WorkflowSignal {
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    payload: row.payload ?? undefined,
    createdAt: requireIso(row.created_at),
    consumedAt: toIso(row.consumed_at),
  };
}

function toEvent(row: EventRow): WorkflowEvent {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    type: row.type as WorkflowEventType,
    payload: row.payload,
    createdAt: requireIso(row.created_at),
  };
}

/** camelCase patch → 白名单列名。绝不把调用方给的字符串直接拼进 SQL。 */
const RUN_COLUMNS = {
  workflowId: "workflow_id",
  workflowVersion: "workflow_version",
  status: "status",
  input: "input",
  context: "context",
  currentStepId: "current_step_id",
  currentStepRunId: "current_step_run_id",
  wakeAt: "wake_at",
  leaseOwner: "lease_owner",
  leaseExpiresAt: "lease_expires_at",
  error: "error",
  completedAt: "completed_at",
  updatedAt: "updated_at",
} as const satisfies Record<keyof WorkflowRunPatch, string>;

const STEP_RUN_COLUMNS = {
  status: "status",
  attempt: "attempt",
  visit: "visit",
  input: "input",
  output: "output",
  patch: "patch",
  error: "error",
  waitFor: "wait_for",
  waitPayload: "wait_payload",
  idempotencyKey: "idempotency_key",
  startedAt: "started_at",
  finishedAt: "finished_at",
  wakeAt: "wake_at",
  updatedAt: "updated_at",
} as const satisfies Record<keyof StepRunPatch, string>;

/* ────────────────────────────── Stores ────────────────────────────── */

class PostgresDefinitionStore implements DefinitionStore {
  constructor(readonly storage: PostgresWorkflowStorage) {}

  async save(input: { definition: WorkflowDefinition; definitionHash: string }): Promise<DefinitionRecord> {
    const { definition, definitionHash } = input;
    const inserted = await this.storage.client.query<DefinitionRow>(
      `INSERT INTO workflow_definitions (workflow_id, version, definition, definition_hash, created_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)
       ON CONFLICT (workflow_id, version) DO NOTHING
       RETURNING *`,
      [
        definition.id,
        definition.version,
        JSON.stringify(definition),
        definitionHash,
        this.storage.now().toISOString(),
      ],
    );

    const row = inserted.rows[0];
    if (row !== undefined) return this.#toRecord(row);

    // 已经存在：同内容幂等，不同内容报错
    const existing = await this.storage.client.query<DefinitionRow>(
      `SELECT * FROM workflow_definitions WHERE workflow_id = $1 AND version = $2`,
      [definition.id, definition.version],
    );
    const found = existing.rows[0];
    if (found === undefined) {
      throw new StorageConflictError(`workflow "${definition.id}" v${definition.version} 写入冲突`, {
        workflowId: definition.id,
        version: definition.version,
      });
    }
    if (found.definition_hash !== definitionHash) {
      throw new StorageConflictError(
        `workflow "${definition.id}" v${definition.version} 已发布，内容不可修改（请发新版本）`,
        { workflowId: definition.id, version: definition.version },
      );
    }
    return this.#toRecord(found);
  }

  async get(workflowId: string, version: number): Promise<WorkflowDefinition | null> {
    const result = await this.storage.client.query<DefinitionRow>(
      `SELECT * FROM workflow_definitions WHERE workflow_id = $1 AND version = $2`,
      [workflowId, version],
    );
    const row = result.rows[0];
    return row === undefined ? null : row.definition;
  }

  async getLatest(workflowId: string): Promise<WorkflowDefinition | null> {
    const result = await this.storage.client.query<DefinitionRow>(
      `SELECT * FROM workflow_definitions WHERE workflow_id = $1 ORDER BY version DESC LIMIT 1`,
      [workflowId],
    );
    const row = result.rows[0];
    return row === undefined ? null : row.definition;
  }

  async listVersions(workflowId: string): Promise<number[]> {
    const result = await this.storage.client.query<{ version: number }>(
      `SELECT version FROM workflow_definitions WHERE workflow_id = $1 ORDER BY version`,
      [workflowId],
    );
    return result.rows.map((row) => row.version);
  }

  async listWorkflowIds(): Promise<string[]> {
    const result = await this.storage.client.query<{ workflow_id: string }>(
      `SELECT DISTINCT workflow_id FROM workflow_definitions ORDER BY workflow_id`,
    );
    return result.rows.map((row) => row.workflow_id);
  }

  #toRecord(row: DefinitionRow): DefinitionRecord {
    return {
      workflowId: row.workflow_id,
      version: row.version,
      definition: row.definition,
      definitionHash: row.definition_hash,
      createdAt: requireIso(row.created_at),
    };
  }
}

class PostgresRunStore implements RunStore {
  constructor(readonly storage: PostgresWorkflowStorage) {}

  async create(run: WorkflowRun): Promise<void> {
    await this.storage.client.query(
      `INSERT INTO workflow_runs (
         id, workflow_id, workflow_version, status, input, context,
         current_step_id, current_step_run_id, wake_at, lease_owner, lease_expires_at,
         error, created_at, updated_at, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb, $6::jsonb,
         $7, $8, $9::timestamptz, $10, $11::timestamptz,
         $12::jsonb, $13::timestamptz, $14::timestamptz, $15::timestamptz
       )`,
      [
        run.id,
        run.workflowId,
        run.workflowVersion,
        run.status,
        JSON.stringify(value(run.input)),
        JSON.stringify(run.context),
        run.currentStepId,
        run.currentStepRunId,
        run.wakeAt,
        run.leaseOwner,
        run.leaseExpiresAt,
        run.error === null ? null : JSON.stringify(run.error),
        run.createdAt,
        run.updatedAt,
        run.completedAt,
      ],
    );
  }

  async get(runId: string): Promise<WorkflowRun | null> {
    const result = await this.storage.client.query<RunRow>(`SELECT * FROM workflow_runs WHERE id = $1`, [
      runId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toRun(row);
  }

  async update(runId: string, patch: WorkflowRunPatch): Promise<void> {
    await this.#update(runId, patch);
  }

  async listByStatus(status: RunStatus, limit?: number): Promise<WorkflowRun[]> {
    const result = await this.storage.client.query<RunRow>(
      `SELECT * FROM workflow_runs WHERE status = $1 ORDER BY created_at, seq LIMIT $2`,
      [status, limit ?? null],
    );
    return result.rows.map(toRun);
  }

  async claimDue(options: ClaimOptions): Promise<WorkflowRun[]> {
    const at = options.now ?? this.storage.now().toISOString();
    const leaseExpiresAt = new Date(Date.parse(at) + options.leaseMs).toISOString();

    const result = await this.storage.client.query<RunRow>(CLAIM_DUE_SQL, [
      [...CLAIMABLE_RUN_STATUSES],
      at,
      options.limit,
      options.owner,
      leaseExpiresAt,
    ]);
    return result.rows.map(toRun);
  }

  async renewLease(runId: string, owner: string, leaseMs: number, now?: string): Promise<boolean> {
    const at = now ?? this.storage.now().toISOString();
    const leaseExpiresAt = new Date(Date.parse(at) + leaseMs).toISOString();
    const result = await this.storage.client.query(
      `UPDATE workflow_runs
          SET lease_expires_at = $3::timestamptz, updated_at = $4::timestamptz
        WHERE id = $1 AND lease_owner = $2`,
      [runId, owner, leaseExpiresAt, at],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async releaseLease(runId: string, owner: string): Promise<void> {
    await this.storage.client.query(
      `UPDATE workflow_runs
          SET lease_owner = NULL, lease_expires_at = NULL, updated_at = $3::timestamptz
        WHERE id = $1 AND lease_owner = $2`,
      [runId, owner, this.storage.now().toISOString()],
    );
  }

  async #update(runId: string, patch: WorkflowRunPatch): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, raw] of Object.entries(patch)) {
      const column = RUN_COLUMNS[key as keyof WorkflowRunPatch];
      if (column === undefined) continue;
      values.push(value(raw));
      sets.push(`${column} = $${values.length}${JSONB_COLUMNS.has(column) ? "::jsonb" : ""}`);
    }

    values.push(this.storage.now().toISOString());
    sets.push(`updated_at = $${values.length}::timestamptz`);
    values.push(runId);

    await this.storage.client.query(
      `UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = $${values.length}`,
      values,
    );
  }
}

/** 需要显式 ::jsonb 转换的列（NULL 也要能写）。 */
const JSONB_COLUMNS = new Set(["input", "context", "error", "output", "patch", "wait_payload", "payload"]);

class PostgresStepRunStore implements StepRunStore {
  constructor(readonly storage: PostgresWorkflowStorage) {}

  async create(stepRun: StepRun): Promise<void> {
    await this.storage.client.query(
      `INSERT INTO workflow_step_runs (
         id, run_id, step_id, status, attempt, visit,
         input, output, patch, error, wait_for, wait_payload,
         idempotency_key, started_at, finished_at, wake_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12::jsonb,
         $13, $14::timestamptz, $15::timestamptz, $16::timestamptz, $17::timestamptz, $18::timestamptz
       )`,
      [
        stepRun.id,
        stepRun.runId,
        stepRun.stepId,
        stepRun.status,
        stepRun.attempt,
        stepRun.visit,
        JSON.stringify(value(stepRun.input)),
        JSON.stringify(value(stepRun.output)),
        JSON.stringify(value(stepRun.patch)),
        stepRun.error === null ? null : JSON.stringify(stepRun.error),
        stepRun.waitFor,
        JSON.stringify(value(stepRun.waitPayload)),
        stepRun.idempotencyKey,
        stepRun.startedAt,
        stepRun.finishedAt,
        stepRun.wakeAt,
        stepRun.createdAt,
        stepRun.updatedAt,
      ],
    );
  }

  async get(stepRunId: string): Promise<StepRun | null> {
    const result = await this.storage.client.query<StepRunRow>(
      `SELECT * FROM workflow_step_runs WHERE id = $1`,
      [stepRunId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toStepRun(row);
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<StepRun | null> {
    const result = await this.storage.client.query<StepRunRow>(
      `SELECT * FROM workflow_step_runs WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toStepRun(row);
  }

  async findLatest(runId: string, stepId: StepId): Promise<StepRun | null> {
    const result = await this.storage.client.query<StepRunRow>(
      `SELECT * FROM workflow_step_runs
        WHERE run_id = $1 AND step_id = $2
        ORDER BY visit DESC, seq DESC
        LIMIT 1`,
      [runId, stepId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toStepRun(row);
  }

  async listByRun(runId: string): Promise<StepRun[]> {
    const result = await this.storage.client.query<StepRunRow>(
      `SELECT * FROM workflow_step_runs WHERE run_id = $1 ORDER BY seq`,
      [runId],
    );
    return result.rows.map(toStepRun);
  }

  async listByStatus(runId: string, status: StepStatus): Promise<StepRun[]> {
    const result = await this.storage.client.query<StepRunRow>(
      `SELECT * FROM workflow_step_runs WHERE run_id = $1 AND status = $2 ORDER BY seq`,
      [runId, status],
    );
    return result.rows.map(toStepRun);
  }

  async update(stepRunId: string, patch: StepRunPatch): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, raw] of Object.entries(patch)) {
      const column = STEP_RUN_COLUMNS[key as keyof StepRunPatch];
      if (column === undefined) continue;
      values.push(value(raw));
      sets.push(`${column} = $${values.length}${JSONB_COLUMNS.has(column) ? "::jsonb" : ""}`);
    }

    values.push(this.storage.now().toISOString());
    sets.push(`updated_at = $${values.length}::timestamptz`);
    values.push(stepRunId);

    await this.storage.client.query(
      `UPDATE workflow_step_runs SET ${sets.join(", ")} WHERE id = $${values.length}`,
      values,
    );
  }

  async countByRun(runId: string): Promise<number> {
    const result = await this.storage.client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workflow_step_runs WHERE run_id = $1`,
      [runId],
    );
    return Number(result.rows[0]?.count ?? "0");
  }
}

class PostgresSignalStore implements SignalStore {
  constructor(readonly storage: PostgresWorkflowStorage) {}

  async append(signal: WorkflowSignal): Promise<void> {
    await this.storage.client.query(
      `INSERT INTO workflow_signals (id, run_id, name, payload, created_at, consumed_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)`,
      [
        signal.id,
        signal.runId,
        signal.name,
        JSON.stringify(value(signal.payload)),
        signal.createdAt,
        signal.consumedAt,
      ],
    );
  }

  async consumeNext(runId: string, name: string, now?: string): Promise<WorkflowSignal | null> {
    const at = now ?? this.storage.now().toISOString();
    const result = await this.storage.client.query<SignalRow>(CONSUME_SIGNAL_SQL, [runId, name, at]);
    const row = result.rows[0];
    return row === undefined ? null : toSignal(row);
  }

  async listByRun(runId: string): Promise<WorkflowSignal[]> {
    const result = await this.storage.client.query<SignalRow>(
      `SELECT * FROM workflow_signals WHERE run_id = $1 ORDER BY seq`,
      [runId],
    );
    return result.rows.map(toSignal);
  }

  async countPending(runId: string): Promise<number> {
    const result = await this.storage.client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workflow_signals WHERE run_id = $1 AND consumed_at IS NULL`,
      [runId],
    );
    return Number(result.rows[0]?.count ?? "0");
  }
}

class PostgresEventStore implements EventStore {
  constructor(readonly storage: PostgresWorkflowStorage) {}

  async append(event: WorkflowEvent): Promise<void> {
    await this.storage.client.query(
      `INSERT INTO workflow_events (id, run_id, step_id, type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
      [event.id, event.runId, event.stepId, event.type, JSON.stringify(event.payload), event.createdAt],
    );
  }

  async listByRun(runId: string, options: { limit?: number; after?: string } = {}): Promise<WorkflowEvent[]> {
    const result = await this.storage.client.query<EventRow>(
      `SELECT * FROM workflow_events
        WHERE run_id = $1
          AND ($2::text IS NULL OR seq > (SELECT seq FROM workflow_events WHERE id = $2))
        ORDER BY seq
        LIMIT $3`,
      [runId, options.after ?? null, options.limit ?? null],
    );
    return result.rows.map(toEvent);
  }
}
