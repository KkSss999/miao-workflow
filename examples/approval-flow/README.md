# examples/approval-flow

一个「请求 → AI 分类 → 人工复核 → 审批 → 建记录 → 发通知」的完整示例。

```
request.received
      ↓
ai.classify ────────┐
      ↓             │ confidence.low
      ├──→ manual-review ──┐
      ↓                    │
   human.approval ←────────┘
      ↓  (signal: approval)
  record.create
      ↓
   email.send
      ↓
  COMPLETED
```

| 文件 | 内容 |
|---|---|
| `workflow.ts` | 纯 JSON definition：`defineWorkflow({...})` |
| `handlers.ts` | handler 表 + guard 表，`registry.register/guard` |

它同时是**引擎的端到端测试**（`tests/examples.test.ts`）：断言整条链路的 23 条审计事件，
包括两次挂起与两次恢复。所以这份示例不会跟实现漂移。

## 用法

```ts
const storage = new MemoryWorkflowStorage();          // 或 PostgresWorkflowStorage
const engine = new WorkflowEngine({ storage, registry: registerApprovalFlow() });
const client = new WorkflowClient(engine);
const worker = new WorkflowWorker({ engine, concurrency: 16 });
worker.start();

const run = await client.start(requestToAction, { input: { requestId: "REQ-1024" } });

// 几天后，人类在 UI 上点 Approve —— 请求路径只写一条信号，不执行任何业务
await client.signal(run.id, "approval", { decision: "approve" });
```

## 三个值得抄的写法

1. **首个 step 把后续要用的东西 patch 进 context。** `run.input` 只有首步看得到，
   后面的 step 拿到的 `input` 是上一步的 output —— 所以 `requestId` 在第一步入 context。
2. **挂起只有一种写法**：`if (ctx.resume === undefined) return { waiting }`，
   被叫醒时同一段代码再跑一次。没有第二套规则。
3. **副作用步骤带幂等键 + 区分 UNKNOWN**：超时代表「对方可能已经做了」，
   不该自动重试（会重复投递），要交给 `engine.reconcile`。

## 想看第三方扩展（wasm）怎么接？

见 [`examples/wasm-handler/`](../wasm-handler/)。

「包一层具体业务系统」的 dogfood 路线**已取消**（那会让 Core 沾上业务概念）——
「第三方怎么接进来」由 wasm 扩展来回答（Phase F），示例本身保持领域中立。
