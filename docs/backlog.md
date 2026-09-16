# Backlog

Review 之后**确认存在但这一轮没修**的东西。都有具体做法，不是「以后再说」。

## 运维 / 可靠性

### 1. 永久 FAILED 的 run 无法恢复

现在只有 `UNKNOWN` 走 `engine.reconcile()`。下游修好之后，一个 `FAILED` 的 run 只能手改数据库。

**做法**：让 `reconcile` 接受 `FAILED`（同一条 step run、同一个幂等键重跑），
并在事件里标明是人工重试。注意要和 `maxStepsPerTick`/`failures` 计数共存。

### 2. 审计数据无限增长

`workflow_events` 与 `workflow_step_runs` 只增不减。一个高频 workflow 跑一年就是几千万行。

**做法**：`engine.prune({ before, status })` + 可选的分区表；至少要有一份「保留策略」文档。

### 3. Postgres 每步的往返次数

一步 ≈ 8 次查询：`listByRun`（全历史扫描）、每步 `renewLease`、若干 `runs.update`、
每个事件一次 `insert`。3 步的 run 约 24 次往返。

**做法**：run 的历史只在循环外读一次并增量维护；事件按批写；`renewLease` 用心跳就够，
不必每步一次。

### 4. 内存实现的复杂度

`steps.create` 为了查幂等键冲突会**全表扫描**（O(n) per create → O(n²) per run）。
`findLatest` / `listByStatus` / `hasPendingSignalFor` 同样是线性的。

**做法**：维护 `Map<idempotencyKey, stepRunId>` 与 `Map<runId, stepRunId[]>` 索引。
只影响测试与 demo，但会让大 run 的测试变慢。

### 5. `start(definition)` 每次都重新发布

每次 `start` 都会跑一次 `definitions.save`（PG 上是 INSERT + 可能的 SELECT）加一次 hash。
高频起 run 时是纯浪费。

**做法**：engine 里按 `(workflowId, version, hash)` 缓存「已发布」，或让调用方显式 publish 一次。

## 语义 / 易用性

### 6. `context` 是浅合并

`patch: { user: { name } }` 会整体替换 `context.user`。Deep merge 有歧义（数组怎么办？），
所以**保持浅合并**是对的，但要在 README 里写明，并建议把 context 设计成扁平的。

### 7. `WorkerTickResult.processed` 命名误导

它统计的是「没抛错」，不是「成功」——handler 失败返回 `{status:"failed"}` 也算 processed。

**做法**：改名 `completed`/`handled`，或加 `succeeded` / `failedRuns` 两个计数。

### 8. 弱测试

conformance 里的「两个 worker 抢同一个 run」在 memory 上其实是顺序执行（单线程），
只有跑 Postgres 时才有意义。应该在名字里写清，或挪到 pg-only 套件。

## 代码卫生

### 9. 死代码 / 重复

- `StepRunner` 里超时后的二次 `signal.aborted` 转换：实际不可达（race 已经保证），
  但理论上会把已成功的结果误判成超时 —— 应该删掉，只信 race 的结果
- `runtime/step-run.ts` 的 `serializeStepError` / `stepRunError` 与 `core/errors.ts` 重复
- `runtime/builtins.ts` 里 `export { RESERVED_HANDLERS }` 是多余的中转
- `index.ts` 同时导出 `RESERVED_HANDLERS` 与 `BUILTIN_HANDLERS`（同一个东西两个名字）
- `MemoryWorkflowStorage` 把 `runsMap()` 等内部结构暴露成公开 API（测试在用它绕约束）

### 10. wasm 的内存隔离是「事后检查」

`maxMemoryBytes` 只能在下一次调用前发现超限；`memory.grow` 本身拦不住。
真正的硬隔离要跑在**独立进程**（不是 worker 线程，线程共享进程内存）并设 rlimit。

## 明确不做（V1 范围外，见 README）

并行 DAG · 子流程 · 循环 + compensation · expression language · Canvas · n8n import ·
RBAC · 多租户 · Connector 市场 · Redis · 分布式 scheduler · AI Agent framework
