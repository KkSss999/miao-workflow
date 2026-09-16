# miaoworkflow

> 内部简称 **mwf** · npm 包名 `@catease/workflow`
>
> **Embedded durable workflow runtime for TypeScript.**

**Embedded + Typed + Durable + Human-in-the-loop + AI-native.**

不是 n8n 替代品：不做 500 个 Connector，不做拖拽 Canvas。
目标是取 Temporal / BullMQ / XState 的核心思想，做成 `pnpm add` 就能嵌进业务系统的东西 ——
**零重型基础设施依赖，PostgreSQL 之外什么都不用装（连 Redis 都不要）。**

```text
Definition 描述「下一步是什么」
Handler    描述「这一步怎么做」
Storage    保证「死了以后还记得做到哪」
Worker     保证「它最终还会继续做」
```

## Quickstart（目标 UX）

```ts
import {
  WorkflowClient,
  WorkflowEngine,
  WorkflowWorker,
  MemoryWorkflowStorage,
  defineWorkflow,
} from "@catease/workflow";

const workflow = defineWorkflow({
  id: "intake-to-action",
  version: 1,
  start: "triage",
  steps: {
    triage: {
      uses: "ai.triage",
      next: [{ to: "manual-review", when: "confidence.low" }, { to: "approval" }],
    },
    "manual-review": { uses: "human.review", next: "approval" },
    approval: { uses: "human.approval", next: "create-lead" },
    "create-lead": { uses: "lead.create", next: "send-email" },
    "send-email": { uses: "email.send" }, // 没有 next = 终点
  },
});

const storage = new MemoryWorkflowStorage();
const engine = new WorkflowEngine({ storage });

engine.registry
  .register({
    "ai.triage": triageHandler,
    "human.review": reviewHandler,
    "human.approval": approvalHandler,
    "lead.create": leadHandler,
    "email.send": emailHandler,
  })
  .guard("confidence.low", ({ context }) => Number(context["confidence"] ?? 1) < 0.75);

const client = new WorkflowClient(engine);

await client.start(workflow, { input: { intakeId: "INT-1024" } });
await client.signal(runId, "approval", { decision: "approve" });
```

定义里**没有一个字**提到 Resend / HubSpot / Slack / OpenAI。
Core 只知道 `Workflow · Run · Step · Transition · Handler · Signal · Retry · Wait`。

## 状态

骨架已落地：类型层、校验层、注册表、转移解析、重试策略、内存 storage **已经实现并有测试**；
Engine / Worker / PostgreSQL 是**有完整形状的桩**，按 Phase 逐步填充。

| 模块 | 状态 | Phase |
|---|---|---|
| JSON definition + 归一化 | ✅ 实现 | — |
| `validateDefinition`（含不可达检测 / 循环引用检测） | ✅ 实现 | — |
| `hashDefinition` / `stableStringify` | ✅ 实现 | — |
| Handler / Guard Registry | ✅ 实现 | — |
| `resolveNextStep`（条件转移，纯函数） | ✅ 实现 | — |
| Retry 策略（fixed / exponential / jitter / cap） | ✅ 实现 | — |
| `MemoryWorkflowStorage`（definition / run / step / signal / event） | ✅ 实现 | — |
| Run / Step 状态机与记录类型 | ✅ 实现 | — |
| `WorkflowEngine.start / tick` | 🚧 桩 | A |
| `StepRunner.executeStep` | 🚧 桩 | A |
| `PostgresWorkflowStorage` | 🚧 桩 | B |
| `WorkflowWorker.tick` | 🚧 桩 | C |
| signal / cancel / delay | 🚧 桩 | D |
| IntakeOps 集成示例 | 🚧 只能定义与注册 | E |

```bash
pnpm install
pnpm check     # typecheck + 55 个测试
pnpm build     # tsc → dist/（ESM + .d.ts）
```

## 目录

```text
src/
  json.ts              JSON 值类型（Definition 的地基）
  core/
    errors.ts          错误分类 + retryable 语义 + 可序列化错误
    registry.ts        handler / guard 注册表（Core 不认识业务）
    runner.ts          StepHandler / StepResult / StepExecutionContext 契约
    transitions.ts     条件转移解析（纯函数）
    engine.ts          WorkflowEngine + WorkflowClient
  definition/
    step.ts            Step / Transition / RetryPolicy 类型
    workflow.ts        defineWorkflow()
    validation.ts      归一化 · 校验 · stableStringify · hash
  runtime/
    run.ts             Run 状态机 + WorkflowRun
    step-run.ts        Step 状态机 + StepRun + 幂等键
    signal.ts          Signal
    events.ts          审计事件
    retry.ts           backoff 计算
  storage/
    interface.ts       五个 Store 的接口
    memory.ts          内存实现（tests / dev / demo）
    postgres.ts        PostgreSQL 适配器（Phase B）
  worker/
    worker.ts          WorkflowWorker
    lease.ts           LeaseManager（lease + 心跳）
    scheduler.ts       轮询调度（不用分布式 scheduler）
tests/
examples/intakeops/    第一个 dogfood 目标
docs/
  architecture.md      设计取舍、执行语义、状态机、与三家的关系
  postgres-schema.sql  五张表
```

## 三条不能破的规矩

1. **Definition 必须 JSON serializable。** 不允许 function / Date / Map。
   条件判断写 guard 名字（`when: "confidence.low"`），不写 JS 表达式 —— 我们不做 expression sandbox。
2. **不宣称 exactly-once。** 承诺是 *at-least-once execution + idempotent side effects*：
   幂等键 `{runId}:{stepId}:{visit}`，外部结果未知时进入 `UNKNOWN`，**永不自动重试**。
3. **已发布的 Definition 版本不可修改。** 内容变了就是新版本；老 run 永远跑老版本。

## 明确不做（V1）

Canvas · n8n import · 并行 DAG · 循环 · 子流程 · Expression Language · RBAC · 多租户 ·
Connector 市场 · Redis 依赖 · Kubernetes · 分布式 scheduler · AI Agent framework

## 路线

| Phase | 内容 | 完成标志 |
|---|---|---|
| **A** | Engine + StepRunner + MemoryStorage 打通 | `A → B → C` 与条件分支跑通 |
| **B** | PostgresStorage + 版本化 + events | `kill -9` → 重启 → 继续 |
| **C** | Retry / Timeout / Idempotency / Lease / Crash Recovery | 崩溃与重复都不出错 |
| **D** | Signal / Wait / Resume / Delay / Cancel | **Core V1 完成** |
| **E** | 包住 IntakeOps 现有 service（不重写） | 第一个真实 dogfood |

详见 [docs/architecture.md](docs/architecture.md)。

## License

未定（当前 `package.json` 为 `UNLICENSED`，npm 上并未发布）。
