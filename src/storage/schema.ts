/**
 * PostgreSQL schema —— 五张表。
 *
 * 这里是**唯一权威来源**：`docs/postgres-schema.sql` 是给人看的副本，
 * `tests/schema.test.ts` 会断言两者一致（改一边不改另一边就会红）。
 *
 * 为什么放进 TS 而不是运行时读 .sql 文件：
 * 包对外只发布 `dist/`，读文件在消费方那边随时会失效；内联字符串永远可用。
 */

export const SCHEMA_SQL = `-- miao-workflow (@catease/workflow) —— PostgreSQL schema
--
-- 五张表。没有 Redis，没有独立 scheduler，没有消息队列。
-- 并发抢占靠 workflow_runs 上的 FOR UPDATE SKIP LOCKED。
--
-- 时间戳统一 timestamptz；jsonb 只存「已经是 JSON」的东西
-- （definition / input / context / output / patch / payload / error）。
--
-- 注意：表名不做 schema 限定，走连接的 search_path。

CREATE TABLE IF NOT EXISTS workflow_definitions (
    workflow_id     text        NOT NULL,
    version         integer     NOT NULL CHECK (version >= 1),
    definition      jsonb       NOT NULL,
    definition_hash text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workflow_id, version)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
    id               text        PRIMARY KEY,
    -- 插入顺序。内存实现里「时间」就是 Map 的插入顺序，这里需要显式等价物：
    -- created_at 可能并列，而 id 是随机 UUID —— 拿它做 tiebreak 顺序就没意义了。
    seq              bigint      GENERATED ALWAYS AS IDENTITY,
    workflow_id      text        NOT NULL,
    workflow_version integer     NOT NULL,

    status           text        NOT NULL
        CHECK (status IN ('CREATED','RUNNING','WAITING','RETRYING','COMPLETED','FAILED','CANCELLED')),

    input            jsonb,
    context          jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- 「我做到哪」= 这一对指针：
    --   指针指向一条 COMPLETED 的 step run → 恢复时只重放 patch，不重放副作用
    --   指针为空 → 下一步是一次全新的访问（回边时 visit 自然 +1）
    --   指针悬空 → 复用同一个 step run id 与幂等键
    current_step_id     text,
    current_step_run_id text,

    -- WAITING / RETRYING 的到点时间；等信号的 WAITING 为 NULL（抢了也没信号可消费）
    wake_at          timestamptz,

    lease_owner      text,
    lease_expires_at timestamptz,

    error            jsonb,

    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    completed_at     timestamptz,

    FOREIGN KEY (workflow_id, workflow_version)
        REFERENCES workflow_definitions (workflow_id, version)
);

CREATE INDEX IF NOT EXISTS workflow_runs_claimable_idx
    ON workflow_runs (status, wake_at, created_at, seq)
    WHERE status IN ('CREATED','RUNNING','RETRYING','WAITING');

CREATE INDEX IF NOT EXISTS workflow_runs_lease_idx
    ON workflow_runs (lease_expires_at)
    WHERE lease_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS workflow_runs_workflow_idx
    ON workflow_runs (workflow_id, workflow_version, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_step_runs (
    id              text        PRIMARY KEY,
    seq             bigint      GENERATED ALWAYS AS IDENTITY,
    run_id          text        NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    step_id         text        NOT NULL,

    status          text        NOT NULL
        CHECK (status IN ('PENDING','RUNNING','WAITING','RETRYING','COMPLETED','FAILED','UNKNOWN')),

    attempt         integer     NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    visit           integer     NOT NULL DEFAULT 1 CHECK (visit >= 1),

    input           jsonb,
    output          jsonb,
    -- 这一步对 context 的贡献：崩溃恢复时不必重跑 handler 就能重建 context
    patch           jsonb,
    error           jsonb,

    wait_for        text,
    wait_payload    jsonb,

    idempotency_key text        NOT NULL UNIQUE,

    started_at      timestamptz,
    finished_at     timestamptz,
    wake_at         timestamptz,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_step_runs_run_idx
    ON workflow_step_runs (run_id, seq);

CREATE INDEX IF NOT EXISTS workflow_step_runs_step_idx
    ON workflow_step_runs (run_id, step_id, visit DESC);

CREATE TABLE IF NOT EXISTS workflow_signals (
    id          text        PRIMARY KEY,
    seq         bigint      GENERATED ALWAYS AS IDENTITY,
    run_id      text        NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    name        text        NOT NULL,
    payload     jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS workflow_signals_pending_idx
    ON workflow_signals (run_id, name, created_at, seq)
    WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS workflow_events (
    id         text        PRIMARY KEY,
    seq        bigint      GENERATED ALWAYS AS IDENTITY,
    run_id     text        NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    step_id    text,
    type       text        NOT NULL,
    payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_events_run_idx
    ON workflow_events (run_id, seq);
`;

/**
 * Worker 每次 tick 都跑这条（`FOR UPDATE SKIP LOCKED`，一条语句里完成抢锁 + 写 lease）。
 *
 * 关键细节：`status = 'WAITING'` 的 run 只有在 `wake_at` 到点后才会被抢 ——
 * 等信号的 WAITING（wake_at IS NULL）抢了也没信号可消费，只会空转。
 */
export const CLAIM_DUE_SQL = `WITH due AS (
    SELECT id
      FROM workflow_runs
     WHERE status = ANY($1::text[])
       AND (status <> 'WAITING' OR wake_at IS NOT NULL)
       AND (wake_at IS NULL OR wake_at <= $2::timestamptz)
       AND (lease_expires_at IS NULL OR lease_expires_at < $2::timestamptz)
     ORDER BY created_at, seq
     FOR UPDATE SKIP LOCKED
     LIMIT $3
)
UPDATE workflow_runs r
   SET status          = 'RUNNING',
       lease_owner     = $4,
       lease_expires_at = $5::timestamptz,
       updated_at      = $2::timestamptz
  FROM due
 WHERE r.id = due.id
RETURNING r.*`;

/** 消费一条信号：原子地挑出最老的一条未消费信号并打上 consumed_at。 */
export const CONSUME_SIGNAL_SQL = `UPDATE workflow_signals
    SET consumed_at = $3::timestamptz
  WHERE id = (
        SELECT id
          FROM workflow_signals
         WHERE run_id = $1
           AND name = $2
           AND consumed_at IS NULL
         ORDER BY created_at, seq
         LIMIT 1
         FOR UPDATE SKIP LOCKED
  )
RETURNING *`;
