-- miao-workflow (@catease/workflow) —— PostgreSQL schema
--
-- 五张表。没有 Redis，没有独立 scheduler，没有消息队列。
-- 并发抢占靠 workflow_runs 上的 FOR UPDATE SKIP LOCKED。
--
-- 时间戳统一 timestamptz（应用侧写 UTC ISO 字符串，可直接字符串比较）。
-- jsonb 只存「已经是 JSON」的东西 —— Definition / context / input / output / payload。

BEGIN;

-- ── 1. workflow_definitions ────────────────────────────────────
-- 发布后不可修改：同 (workflow_id, version) 内容变了就是 definition_hash 变了，
-- 应用层直接拒绝，逼你发新版本。老 run 因此永远能按原样跑完。
CREATE TABLE IF NOT EXISTS workflow_definitions (
    workflow_id     text        NOT NULL,
    version         integer     NOT NULL CHECK (version >= 1),
    definition      jsonb       NOT NULL,
    definition_hash text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workflow_id, version)
);

-- ── 2. workflow_runs ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_runs (
    id               text        PRIMARY KEY,
    workflow_id      text        NOT NULL,
    workflow_version integer     NOT NULL,

    status           text        NOT NULL
        CHECK (status IN ('CREATED','RUNNING','WAITING','RETRYING','COMPLETED','FAILED','CANCELLED')),

    input            jsonb,
    context          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    current_step_id  text,

    -- WAITING / RETRYING 的到点时间；等信号的 WAITING 为 NULL（抢了也没信号可消费）
    wake_at          timestamptz,

    -- lease：没有 Redis，靠它保证一个 run 同时只被一个 worker 推进
    lease_owner      text,
    lease_expires_at timestamptz,

    -- 终止原因（SerializedWorkflowError）
    error            jsonb,

    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    completed_at     timestamptz,

    FOREIGN KEY (workflow_id, workflow_version)
        REFERENCES workflow_definitions (workflow_id, version)
);

-- 抢占查询走这个索引（部分索引，终态 run 不进索引）
CREATE INDEX IF NOT EXISTS workflow_runs_claimable_idx
    ON workflow_runs (status, wake_at, created_at)
    WHERE status IN ('CREATED','RUNNING','RETRYING','WAITING');

CREATE INDEX IF NOT EXISTS workflow_runs_lease_idx
    ON workflow_runs (lease_expires_at)
    WHERE lease_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS workflow_runs_workflow_idx
    ON workflow_runs (workflow_id, workflow_version, created_at DESC);

-- ── 3. workflow_step_runs ─────────────────────────────────────
-- 每一次 step 执行（含每次重试前后的状态）都在这里。
-- idempotency_key = {run_id}:{step_id}:{visit}，唯一约束是「重复副作用」的最后一道闸。
CREATE TABLE IF NOT EXISTS workflow_step_runs (
    id              text        PRIMARY KEY,
    run_id          text        NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    step_id         text        NOT NULL,

    status          text        NOT NULL
        CHECK (status IN ('PENDING','RUNNING','WAITING','RETRYING','COMPLETED','FAILED','UNKNOWN')),

    attempt         integer     NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    visit           integer     NOT NULL DEFAULT 1 CHECK (visit >= 1),

    input           jsonb,
    output          jsonb,
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
    ON workflow_step_runs (run_id, created_at);

CREATE INDEX IF NOT EXISTS workflow_step_runs_step_idx
    ON workflow_step_runs (run_id, step_id, visit DESC);

-- ── 4. workflow_signals ───────────────────────────────────────
-- 外部叫醒 workflow 的唯一方式：人类审批、webhook 回调、别的系统通知。
-- 先落库再 wake —— 进程崩了信号也不会丢。consumed_at 保证同一条只消费一次。
CREATE TABLE IF NOT EXISTS workflow_signals (
    id          text        PRIMARY KEY,
    run_id      text        NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    name        text        NOT NULL,
    payload     jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS workflow_signals_pending_idx
    ON workflow_signals (run_id, name, created_at)
    WHERE consumed_at IS NULL;

-- ── 5. workflow_events ────────────────────────────────────────
-- 只追加、永不修改的审计日志。UI timeline、排障、合规都读它。
CREATE TABLE IF NOT EXISTS workflow_events (
    id         text        PRIMARY KEY,
    run_id     text        NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    step_id    text,
    type       text        NOT NULL,
    payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_events_run_idx
    ON workflow_events (run_id, created_at, id);

COMMIT;

-- 抢占查询（Worker 每次 tick 都跑这条）：
--
-- SELECT id FROM workflow_runs
--  WHERE status IN ('CREATED','RUNNING','RETRYING','WAITING')
--    AND (status <> 'WAITING' OR wake_at IS NOT NULL)
--    AND (wake_at IS NULL OR wake_at <= NOW())
--    AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
--  ORDER BY created_at
--  FOR UPDATE SKIP LOCKED
--  LIMIT $1;
