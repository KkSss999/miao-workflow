# miao-workflow

> 内部简称 **mwf** · npm 包名 `@catease/workflow` · Apache-2.0
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

**Phase A 已完成**：`engine.start` / `engine.tick` / `StepRunner.execute` 是真的 ——
顺序执行、条件分支、崩溃恢复（不重放副作用）、版本绑定、防死循环都跑通了。

**Phase B 已完成**：`PostgresWorkflowStorage` 五个 Store 全部实现，`migrate()` 幂等建表，
`claimDue` 用一条 `FOR UPDATE SKIP LOCKED` 的 `UPDATE ... RETURNING` 完成抢锁 + 写 lease。
Memory 与 Postgres 跑**同一套 conformance 断言**（101 个测试），所以「内存测、Postgres 上生产」不是空话。

Worker 抢占循环、signal/delay 仍是桩，按 Phase 填充。

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
| `WorkflowEngine.start / tick`（顺序执行 · 条件分支 · 事件流） | ✅ 实现 | A |
| `StepRunner.execute`（handler 调用 · 结果校验 · 超时 · 落库） | ✅ 实现 | A |
| 崩溃恢复：不重放副作用，patch 从 step run 重放 | ✅ 实现 | A |
| 版本绑定（老 run 永远跑它绑定的版本） | ✅ 实现 | A |
| `maxStepsPerTick` 防死循环 | ✅ 实现 | A |
| Retry 决策（可重试 → RETRYING + wake_at） | ✅ 实现（策略层测试在 C） | A |
| `PostgresWorkflowStorage`（五表 · JSONB 映射 · `SKIP LOCKED` 抢占） | ✅ 实现 | A/B |
| Storage conformance：Memory 与 Postgres 同一套断言 | ✅ 实现 | B |
| `WorkflowWorker.tick` | 🚧 桩 | C |
| signal / cancel / delay | 🚧 桩 | D |
| WASM handler 宿主（第三方扩展） | 💡 设计已定 | F |
| IntakeOps 集成示例 | ✅ 走到人工审批挂起；signal 待 D | — |

```bash
pnpm install
pnpm check          # typecheck + 全部测试（含 memory conformance）
pnpm test:postgres  # 拉一个临时 Postgres 容器，跑同一套 conformance（用完即删）
pnpm check:all      # 上面两个都跑
pnpm build          # tsc → dist/（ESM + .d.ts）
pnpm schema:sync    # 把 schema.ts 同步到 docs/postgres-schema.sql
```

没有 Docker 也没关系：postgres 那部分会 `describe.skipIf` 跳过（**不会假装测过**）。

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
    postgres.ts        PostgreSQL 适配器（五表 · JSONB · SKIP LOCKED）
    schema.ts          DDL（权威来源；docs/*.sql 是它的副本）
  worker/
    worker.ts          WorkflowWorker
    lease.ts           LeaseManager（lease + 心跳）
    scheduler.ts       轮询调度（不用分布式 scheduler）
tests/
  support/             共用的 storage 夹具 + conformance 套件
examples/intakeops/    第一个 dogfood 目标
docs/
  architecture.md      设计取舍、执行语义、状态机、与三家的关系
  postgres-schema.sql  五张表（由 src/storage/schema.ts 生成，别手改）
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
| **A** | Engine + StepRunner + 事件流 | ✅ **已完成**：`A → B → C`、条件分支、崩溃恢复、防死循环 |
| **B** | PostgresStorage + 版本化 + events | ✅ **已完成**：与 memory 同一套 conformance 全绿（真容器） |
| **C** | Retry 端到端 / Lease 接入 / Crash Recovery / UNKNOWN 语义 | 崩溃与重复都不出错 |
| **D** | Signal / Wait / Resume / Delay / Cancel | **Core V1 完成** |
| **F** | WASM handler 宿主（独立扩展包） | 第三方打包一个 wasm 就能接进来 |

E（包住 IntakeOps）不再单独成阶段 —— 它退化成 D 完成后的顺手验证。

**为什么 wasm 是 extension 而不是 Core**：Core 只认 `StepHandler` 接口，wasm 只是它的一个宿主实现，
所以「Core 不认识业务」这条规矩不用破；沙箱里的 IO 必须由宿主中介（capability 白名单），
V1 的 wasm handler 建议只做纯计算（提取 / 校验 / 规则判定 / 模板渲染）。
handler 边界刻意保持 **JSON in / JSON out**，就是为了这一天不用改 Core。

详见 [docs/architecture.md](docs/architecture.md)。

## 本地复用（不发布 npm）

mwf **不发布到 npm**，只在本机 / 本组织内复用（`private: true` 保持不变）。
npm 上的 `@catease/workflow` 是空的，别去那儿找。

```bash
# 在消费方项目里
pnpm add file:../5k2m/miao-workflow
# 或者
pnpm link ../5k2m/miao-workflow
```

消费方 import 时照旧写包名（`@catease/workflow`）—— `file:` / `link` 会按 `package.json` 的 `name` 解析。

⚠️ 引用的是构建产物：改完 mwf 记得 `pnpm build`（或 `pnpm check`），消费方才能拿到新代码。
IntakeOps（Case 01）接入时就用这个方式，不需要任何发布流程。

## License

[Apache-2.0](LICENSE) © 2026 WenTao Ge

不发布 npm 包，只做本地复用（见上）。
