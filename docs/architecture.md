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

| Phase | 内容 | 目标 |
|---|---|---|
| **A** | Definition · Registry · Handler · Transition · MemoryStorage · Engine | `A → B → C` + 条件分支跑通 |
| **B** | PostgresStorage · Run/StepRun/Events · 版本化 | `kill -9` → 重启 → 继续 |
| **C** | Retry · Backoff · Timeout · Idempotency · Lease · Crash Recovery | 崩溃与重复都不出错 |
| **D** | Signal · Wait · Resume · Delay · Cancel | **Core V1 完成** |
| **E** | IntakeOps 集成（包装现有 service，不重写） | 第一次真实 dogfood |

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
