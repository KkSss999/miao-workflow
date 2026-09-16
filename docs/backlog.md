# Backlog

Review + 后续修复的收尾。**这一轮已经修掉的**在下面第一节，**仍然没做的**在后面（都有具体做法）。

---

## 已修（2026-09 review 轮）

| 问题 | 结果 |
|---|---|
| 永久 FAILED 的 run 无法恢复 | `engine.reconcile(runId, "retry" \| "abandon")` 现在接受任意 FAILED；retry 复用同一条 step run 与幂等键，并把 `failures` 复位 |
| 审计数据无限增长 | `engine.prune({ before, limit })` → 只删**终态**且 `completedAt < before` 的 run（连带 step run / signal / event） |
| 内存实现 O(n²) 与内部结构泄漏 | 重写成「记录表 + 索引」（幂等键索引、run→step run/signal/event 顺序索引、水位线），并去掉 `runsMap()` 这类公开 accessor |
| 每步一次 `listByRun` 全量扫描 | tick 内只读一次历史，之后增量维护（`upsert`） |
| `start(definition)` 每次重复 publish | engine 缓存 `id@version → hash`；内容一致直接跳过；不一致仍然走库并报 `StorageConflictError` |
| definition 每次 tick 都查库 | engine 按 `id@version` 缓存 definition（依赖「发布即不可变」） |
| `WorkerTickResult.processed` 语义误导 | 拆成 `handled`（没抛错）与 `completed`（落到终态） |
| 弱测试 | conformance 的并发抢占用例注明「memory 上是顺序的，真并发见 pg 套件」 |

## 仍未做

### 1. 每步一次的 `renewLease`（**有意不优化**）

一步一次 `UPDATE ... WHERE id = $1 AND lease_owner = $2` 是**归属一致性检查**：
跑了别的 worker 抢走 lease 的情况要尽快发现。按 `leaseMs/3` 节流能省掉大部分写，
但会把发现窗口从「一步」拉长到「十几秒」—— 那段时间里两个 worker 可能同时推进同一个 run。

结论：一次按主键的 UPDATE 换「不会双跑」，这笔账划算，保持现状。
真要省，应该先在 `StepRun` 与事件上做批写（见下一条），而不是动它。

### 2. 事件逐条写

`#emit` 每个事件一次 insert（3 步的 run ≈ 9 次）。批写能省往返，但会引入
「崩溃时丢审计」的窗口 —— 审计是合规材料，不值得拿它换延迟。
如果将来要批，应该走「同一事务内批写 + 明确接受丢事件」的显式设计，而不是顺手缓冲。

### 3. `context` 是浅合并

`patch: { user: { name } }` 会整体替换 `context.user`。deep merge 有歧义（数组怎么办？
删除怎么表达？），所以**保持浅合并**是对的 —— 但要把 context 设计成扁平的，
这条已经写进 README。

### 4. wasm 的硬隔离

`maxMemoryBytes` 是事后检查（`memory.grow` 拦不住）；worker 线程与主进程共享内存。
真正的硬隔离要跑在**独立进程**（`child_process` + rlimit/cgroup），
协议不用改（本来就是 JSON 边界），但这是另一个执行模式，不是 v1 的事。

### 5. 保留策略的自动化

`engine.prune` 是 API，不是调度。生产上要自己在 cron / 启动钩子里调，
并考虑「先归档到冷存储再删」。

## 明确不做（V1 范围外，见 README）

并行 DAG · 子流程 · 循环 + compensation · expression language · Canvas · n8n import ·
RBAC · 多租户 · Connector 市场 · Redis · 分布式 scheduler · AI Agent framework
