# Architecture

## 定位

> **Workflow System = 一个可嵌入任意 Node/TS 后端的轻量 Durable Workflow Runtime。**

不是 n8n 替代品，不做 Connector 市场，不做拖拽 UI。卖点是：

**Embedded + Typed + Durable + Human-in-the-loop + AI-native。**

Temporal 证明了 Durable Execution 有价值，但它是一整套独立平台；
BullMQ 擅长 job / retry / delay / worker；XState 擅长状态机与 Actor。
我们取它们的思想，做成 **`pnpm add` 就能嵌进业务系统** 的东西。

## 一句话原则

> **Definition 描述「下一步是什么」；Handler 描述「这一步怎么做」；
> Storage 保证「死了以后还记得做到哪」；Worker 保证「它最终还会继续做」。**

这四层干净，包就站住了。

```
┌─────────────────────────────────────┐
│      Consumer Application           │   IntakeOps / DocumentOps / …
│  Email / API / UI / Domain Logic    │
└─────────────────┬───────────────────┘
                  │  registry.register("email.send", handler)
                  ↓
┌─────────────────────────────────────┐
│         @catease/workflow           │
│  Definition · Engine · Registry     │
│  Guards · Signals · Retry · Delay   │
│  Worker · Lease                     │
└─────────────────┬───────────────────┘
                  │  Storage Adapter
        ┌─────────┴─────────┐
        ↓                   ↓
     Memory             PostgreSQL
```

以后真的需要了，才加 Worker Adapter（BullMQ / Kafka）—— 但绝不进 Core。

## 第一原则：Core 不认识业务

Core 的词汇表只有：

```
Workflow · Run · Step · Transition · Handler · Signal · Retry · Wait
```

不存在 `Intake` / `Lead` / `Slack` / `Email` / `OpenAI` / `HubSpot`。
业务通过注册表接进来：

```ts
registry.register("ai.triage", triageHandler);
registry.register("lead.create", leadHandler);
registry.register("email.send", emailHandler);
```

同一个 Runtime 之后会被 Case 02（DocumentOps）、Case 03（KnowledgeOps）复用。
这就是把它抽出来的理由。

## Definition 层

**JSON serializable 是硬约束**，因为将来要：落库 / 版本化 / 后台编辑 / Canvas / 导入导出 / API 创建。

所以：

```ts
// ❌ function 存不进数据库
next: (ctx) => (ctx.confidence < 0.75 ? "manual-review" : "approval"),

// ✅ 名字进数据库，实现注册在应用里
next: [{ to: "manual-review", when: "confidence.low" }, { to: "approval" }],
```

```ts
registry.guard("confidence.low", ({ context }) => Number(context.confidence) < 0.75);
```

**我们不做 Expression Language。** 一旦允许 `context.ai.result.confidence < 0.75 && ...`，
下一步就是自己写 JavaScript sandbox —— 不值得。

校验规则（`validateDefinition`）刻意保持机器可判定：

- `start` 必须存在
- transition 目标必须存在
- 无条件兜底分支必须放在 `next` 数组最后
- 不存在不可达步骤
- 整体 JSON serializable（含 detect 循环引用）

### 版本不可变

```text
run 绑死 (workflow_id, version)
v1 的 run 永远跑 v1；改动 = 发布 v2
同 version 写不同内容 → StorageConflictError
```

这是「老 run 永远能跑完」的前提，也是 `definition_hash` 存在的原因。

## 状态机

Run：

```
CREATED ─→ RUNNING ─┬─→ WAITING ─→ RUNNING
                    ├─→ RETRYING ─→ RUNNING
                    ├─→ COMPLETED
                    ├─→ FAILED
                    └─→ CANCELLED
```

Step：

```
PENDING ─→ RUNNING ─┬─→ COMPLETED
                    ├─→ WAITING
                    ├─→ RETRYING
                    ├─→ FAILED
                    └─→ UNKNOWN
```

`UNKNOWN` 是刻意保留的一等状态，不是装饰。

## 执行语义：绝不宣称 exactly-once

正确承诺是：

> **At-least-once execution + idempotent side effects.**

经典事故：

```
Send Email → Resend 成功 → 我们写 DB 之前进程 crash 💥
重启 → step 还是 RUNNING → 不知道邮件发没发 → 再跑一次 = 重复邮件
```

应对：

1. `idempotencyKey = {runId}:{stepId}:{visit}`，同一次 step run 的所有 attempt 共用；
   外部服务支持 idempotency key 就直接用。
2. 不支持幂等的下游，由业务自己做 dedup / outbox / reconciliation。
3. 请求超时这种「不知道对方做没做」的情况返回 `UNKNOWN`，**永不自动重试**。

## 并发模型：不要 Redis

worker 抢活就一条 SQL：

```sql
SELECT id FROM workflow_runs
 WHERE status IN ('CREATED','RUNNING','RETRYING','WAITING')
   AND (status <> 'WAITING' OR wake_at IS NOT NULL)
   AND (wake_at IS NULL OR wake_at <= NOW())
   AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
 ORDER BY created_at
 FOR UPDATE SKIP LOCKED
 LIMIT $1;
```

- **lease**：抢到的立刻写 `lease_owner` / `lease_expires_at`；处理期间心跳续租
- **crash recovery**：进程被 `kill -9` 也不 release，租期一过别人自然接手
- **没有分布式 scheduler**：每个 worker 自己轮询，`SKIP LOCKED` 天然分活

`status = 'WAITING' AND wake_at IS NOT NULL` 这个条件很关键：
等信号的 WAITING（`wake_at IS NULL`）不能抢 —— 抢了也没信号可消费，只会空转。

## Worker 循环

```
claim run → execute step → persist → transition → execute next step → …
```

但一次 tick 有上限：

```ts
maxStepsPerTick: 32
```

防的是 `A → B → A → B` 这种 bug 把 CPU 吃穿。撞上限就 requeue，而不是死循环。

## Human-in-the-loop 与 Delay 是同一个机制

```ts
// 人类审批
return { status: "waiting", waitFor: "approval" };

// 等两天
{ uses: "workflow.delay", config: { duration: "2d" } }
```

两者都只是：

```
run.status = WAITING
wake_at   = 信号：null / 延迟：到点时间
```

**没有 Promise 挂在那里。** 进程 `kill -9`，三天后重启，用户点 Approve：

```ts
await client.signal(runId, "approval", { decision: "approve" });
// WAITING → RUNNING → 下一步
```

这才叫 durable。

## Trigger 不属于 Core

Email webhook、表单、Cron、Kafka、HTTP 最终都只做一件事：

```ts
await client.start(workflowId, input);
```

所以 Core 不需要知道什么叫 Resend：

```
Resend → IntakeOps → WorkflowClient.start() → Workflow System
```

## 与三家的关系

| | 借什么 | 不借什么 |
|---|---|---|
| **Temporal** | Durable Execution 的价值 | server cluster / history replay / deterministic workflow code / task queue |
| **BullMQ** | retry / backoff / delay 语义 | 作为 Core 的硬依赖；将来只做可选 Worker Adapter |
| **XState** | 状态机设计 | 建立在它之上（否则 runtime semantics 被绑死） |

我们走的是**Persistent State Machine** 这条路：每完成一步，DB 就是真相，不做 deterministic replay。
所以它比 Temporal 小得多。

## V1 范围

**必须有**：TypeScript · JSON definition · Handler Registry · 顺序执行 · 条件分支 ·
持久化 run / step run · Postgres + Memory adapter · 版本化 · Retry + backoff · Timeout ·
幂等键 · Worker lease · crash recovery · Wait · Signal/Resume · Delay · Cancel ·
Audit events · UNKNOWN · IntakeOps 集成示例 · 完整测试

**明确不做**：Canvas · n8n import · 并行 DAG · 循环 · 子流程 · Expression Language ·
RBAC · 多租户 · Connector 市场 · Redis 依赖 · Kubernetes · 分布式 scheduler · AI Agent framework

冒出「要不顺便……」就杀掉。

## 阶段

| Phase | 内容 | 目标 | 状态 |
|---|---|---|---|
| **A** | Definition · Registry · Handler · Transition · Engine · 事件流 | `A → B → C` + 条件分支 + 崩溃不重放副作用 | ✅ 完成 |
| **B** | PostgresStorage · Run/StepRun/Events · 版本化 | `kill -9` → 重启 → 继续 | ✅ 完成 |
| **C** | Retry 端到端 · Lease · Crash Recovery · UNKNOWN | 崩溃与重复都不出错 | ✅ 完成 |
| **D** | Signal · Wait · Resume · Delay · Cancel | **Core V1 完成** | ✅ 完成 |
| **F** | WASM handler 宿主（`@catease/workflow/wasm`） | 第三方打包一个 wasm 就接进来 | ✅ 完成 |
| **F.1** | worker_threads 执行模式 | 不可信模块可被 terminate | — |

E（包住 IntakeOps）不再作为阶段 —— D 完成之后顺手验证即可。

## 两个适配器，一套断言

Memory 和 Postgres 跑的是**同一份 conformance 套件**（`tests/support/storage-conformance.ts`）：
definition 版本不可变、lease 独占与过期、`wake_at` 门控、signal 只消费一次、
幂等键唯一、事件顺序、以及「重启一个全新 engine 从指针继续」的端到端恢复。

这不是为了凑覆盖率，而是为了让一句话成立：**用内存跑测试、用 Postgres 上生产，行为一致。**

Postgres 侧另外两条只属于它自己的保证：

- `claimDue` 是**一条**语句：`WITH due AS (SELECT ... FOR UPDATE SKIP LOCKED) UPDATE ... RETURNING`。
  抢锁和写 lease 一旦分成两条事务，就会出现「两个 worker 都以为抢到了」。
- 顺序用自增 `seq`，不用随机 id 做 tiebreak（`ORDER BY created_at` 会并列，`id` 会乱序）。

## 崩溃恢复：指针 + 重放（Phase A 定死）

「进程随时可以被 kill -9」要能成立，必须回答一个问题：**我怎么知道做到哪了？**

答案是 run 上的一对指针：

```
current_step_id     我在哪一步
current_step_run_id 我正在处理哪一条 step run 记录
```

三种窗口的处理方式：

| 崩在哪 | 恢复时看到 | 行为 |
|---|---|---|
| 执行中（step run 还没落库） | 指针悬空，记录不存在 | 复用**同一个 id 与同一个幂等键**重来 —— 外部服务认得出这是同一次动作 |
| step run 已落库 COMPLETED，run 还没推进 | 指针指向一条 COMPLETED | **不重放副作用**，只把 `patch` 重放回 context 然后前移 |
| run 已推进 | 指针为空 | 下一步是一次全新访问 |

这就是为什么要：

1. **执行前先写指针** —— 否则「已完成但没推进」会退化成重复副作用
2. **把 `patch` 单独存进 step run** —— 这样恢复不需要重跑 handler 就能重建 context
3. **不做 deterministic replay** —— 我们重放的是**状态**，不是代码

`visit` 完全由已落库的记录推导（`(latest?.visit ?? 0) + 1`），所以同一个 visit 内的重试复用同一条记录，
回边（A→B→A）则自然得到新的 visit，幂等键不会撞车。

## 挂起与恢复（Phase D）

### 信号只有一个写操作

`engine.signal()` 只做一件事：**append 一条 signal**（外加一条审计事件）。它不碰 run。

那 run 怎么被叫醒？靠 `claimDue` 里的一个 EXISTS 条件：

```sql
OR (status = 'WAITING' AND (
     (wake_at IS NOT NULL AND wake_at <= NOW())          -- delay / 等待超时
  OR EXISTS (SELECT 1 FROM workflow_signals s            -- 人类点了 Approve
               JOIN workflow_step_runs sr ON sr.id = workflow_runs.current_step_run_id
              WHERE s.run_id = workflow_runs.id
                AND s.name = sr.wait_for
                AND s.consumed_at IS NULL)
))
```

这样做的好处：**不存在「信号记下了但 run 没被叫醒」的半完成状态**。
如果反过来（先改 run 状态再写信号，或分两个事务），崩溃点就会丢信号或丢唤醒。
代价是最多一个轮询周期的延迟（默认 1s）。

### 恢复契约：同样的代码跑两次

handler 只有一种写法：

```ts
async execute(ctx) {
  if (ctx.resume === undefined) return { status: "waiting", waitFor: "approval" };
  return { status: "completed", output: ctx.resume.payload };
}
```

`ctx.resume` 只有「被叫醒重新执行」时才有值，所以 handler 必须幂等 ——
这跟整个引擎的 at-least-once 语义是一致的，没有第二套规则。

### 两个容易踩的坑（都踩过了）

1. **挂起信息要在失败之后保留。** 被信号叫醒的那次尝试如果失败了，重试时不能再要一次信号 ——
   外部世界不会自己再来一遍。所以 `waitFor` / `waitPayload` / `wakeAt` 会跟着 step run 走，
   每次尝试都能重建出 `ctx.resume`。
2. **别用 `run.status` 判断「是不是在挂起」。** claim 会把状态改成 RUNNING（那是「归我处理」的意思），
   判断依据应该是**当前 step run 的 `status === 'WAITING'` + `waitFor`**。

### 取消是状态层面的

`cancel()` 把 run 置为 CANCELLED 并释放 lease。正在跑的 handler **不会被掐断**（跨进程做不到）——
这一点必须诚实：取消保证「不再有新步骤被推进」，副作用层面靠幂等键与 reconciliation 兜。

### UNKNOWN 的人工入口

`engine.reconcile(runId, "retry" | "abandon")`：

- `retry`：同一条 step run、同一个 visit、**同一个幂等键**重跑 —— 幂等键不变是关键，下游才能去重
- `abandon`：放弃，置为 CANCELLED（保留 error 供审计）

## 扩展：WASM handler 宿主（Phase F）

目标：第三方**打包一个 wasm 模块、注册一个名字**就接进来。

三条约束，保证它不污染 Core（`tests/boundary.test.ts` 盯着前两条）：

1. **它是 extension，不是 Core。** Core 只认 `StepHandler` 接口；wasm 只是它的一个宿主实现
   （独立包 `@catease/workflow-wasm`）。「Core 不认识业务」这条规矩不用破。
2. **IO 必须由宿主中介。** 沙箱里没有 `fetch`：要么走 `wasi:http` + 白名单，要么由宿主提供受限
   capability 函数。**V1 的 wasm handler 只做纯计算**（提取 / 校验 / 规则判定 / 模板渲染），
   天然幂等；有 IO 的继续用 TS handler。
3. **边界保持 JSON in / JSON out。** `input` / `context` / `output` / `patch` / `error` 全是 JSON，
   `idempotencyKey` 由宿主提供 —— 这样 ABI 落地时不用动 Core。

已经落地的部分：ABI v1（长度前缀响应、错误码白名单、可选 `mwf_reset`）、
模块加载校验、内存越界与响应上限护栏、能力白名单（默认什么都不给）、
以及一个**手搓的 wasm 二进制编码器**作为测试夹具 —— 机器上没有可用的 wasm 工具链，
所以夹具是直接按 spec 写字节生成的（顺便成了 ABI 的可执行文档）。

**已知限制（不藏）**：同步 wasm 无法被中断，死循环会阻塞事件循环，
所以要跑不可信模块必须走 F.1（worker_threads）。

## 测试即规格

V1 要求的测试（现在已有一部分跑通）：

```
A → B → C                      ✅ 基础
branch                         ✅ 条件分支
retry: fail fail success       ✅ 重试
maxAttempts → FAILED           ✅ 永久失败
wait → restart → signal → resume
delay: wait until T
crash recovery（lease 过期换人接手）
double worker（同一 run 只有一个 owner）   ✅
duplicate signal（只消费一次）              ✅
idempotency（重试共用同一个 key）           ✅
versioning（老 run 继续跑 v1）
infinite loop protection（maxStepsPerTick）
```

没有这些测试，这个包就还不配叫 Workflow System。
