# examples/intakeops

mwf 的第一个 dogfood 目标：**不重写 IntakeOps**，只是把现有 service 编排起来。

```
intake.received
      ↓
ai.triage ──────────┐
      ↓             │ confidence.low
      ├──→ manual-review ──┐
      ↓                    │
   human.approval ←────────┘
      ↓  (signal: approval)
  lead.create
      ↓
  email.send
      ↓
  COMPLETED
```

| 文件 | 内容 |
|---|---|
| `workflow.ts` | 纯 JSON definition：`defineWorkflow({...})` |
| `handlers.ts` | handler 表 + guard 表，`registry.register/guard` |

现有 `TriageService` / `LeadService` / `ResendService` 全部保留，Workflow 只负责编排。

## 触发不属于 Core

Email webhook / 表单 / Cron 最后都只做一件事：

```ts
await client.start("intake-to-action", { input: { intakeId: "INT-1024" } });
```

所以 Core 根本不需要知道什么是 Resend。

## 跑起来的写法

```ts
const storage = new MemoryWorkflowStorage();          // 或 PostgresWorkflowStorage
const engine = new WorkflowEngine({ storage, registry: registerIntakeOps() });
const client = new WorkflowClient(engine);
const worker = new WorkflowWorker({ engine, concurrency: 16 });
worker.start();

const run = await client.start(intakeToAction, { input: { intakeId: "INT-1024" } });

// 几天后，人类在 UI 上点 Approve —— 请求路径只写一条信号
await client.signal(run.id, "approval", { decision: "approve" });
```

## 状态

✅ **完整链路已经跑通**：分类 → 人工复核 → 审批 → 建 lead → 发邮件。

真正的可执行版本在 [`tests/examples.test.ts`](../../tests/examples.test.ts)：
那里断言了整条链路的**审计时间线**（23 条事件），包括两次挂起与两次恢复。
等 IntakeOps 真实接入时，只需把这里 handler 里的注释换成真实的 service 调用。
