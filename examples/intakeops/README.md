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

## 状态

Engine 还在 Phase A，这个例子目前只保证**能定义、能注册、能通过类型检查**，
还跑不起来。等 `WorkflowEngine.start/tick` 落地后，这里会变成可执行 demo。
