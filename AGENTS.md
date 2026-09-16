# AGENTS.md

## 项目

- 名称：miao-workflow（内部简称 **mwf**：代码 / 包名 / CLI / 分支名前缀统一 `mwf`）
- npm 包名：`@catease/workflow`。**不发布 npm**：`private: true` 保持不变，复用走本地 `file:` / `link`（见 README）。
- License：Apache-2.0，版权人 WenTao Ge（`LICENSE` + `NOTICE`，不要改成别的）
- 仓库根：`~/Codes/5k2m/miao-workflow`，公开仓库 https://github.com/KkSss999/miao-workflow
- 语言：TypeScript（ESM-only，Node >= 20），包管理器 **pnpm**（不要用 npm/yarn）
- 运行时依赖：**零**。devDeps 只有 typescript / vitest / @types/node

## 定位（不要漂移）

> 一个可嵌入任意 Node/TS 后端的轻量 Durable Workflow Runtime。
> Embedded + Typed + Durable + Human-in-the-loop + AI-native。

一句话原则：

> Definition 描述「下一步是什么」；Handler 描述「这一步怎么做」；
> Storage 保证「死了以后还记得做到哪」；Worker 保证「它最终还会继续做」。

**不是** n8n 替代品：不做 Connector 市场、不做 Canvas、不做并行 DAG。
冒出「要不顺便……」就杀掉。

## 硬约束（改动前先想清楚）

1. **Definition 必须 JSON serializable**（`assertJsonSerializable` 守着）。
   不允许 function / Date / Map / class 实例进 definition。
2. **条件不是表达式**：`when: "confidence.low"` + `registry.guard(...)`。
   禁止引入 expression language / JS sandbox。
3. **已发布 Definition 版本不可修改**：同 version 不同 hash → `StorageConflictError`。改动 = 升版本。
4. **不宣称 exactly-once**：at-least-once + 幂等副作用。
   幂等键 `{runId}:{stepId}:{visit}`；外部结果未知 → `UNKNOWN`，**永不自动重试**。
5. **Core 不认识业务**：`src/` 里不得出现 Intake / Lead / Slack / Email / OpenAI / Resend / HubSpot。
6. **不需要 Redis**：并发只靠 `FOR UPDATE SKIP LOCKED` + lease 字段。
7. **StepResult 只有三种**：`completed` / `waiting` / `failed`。不要加第四种。
8. **失败是否重试由 retry policy 决定**，不由 handler 决定。
9. **终态判断走 helper**（`isTerminalRunStatus` / `isRunDue` / `isClaimableRunStatus`），
   不要在业务代码里手写 `wakeAt` 比较 —— WAITING 的语义有坑（等信号的 wakeAt 为 null，不能被抢）。
10. **Core 不感知 Trigger**：webhook / cron / 表单最后都只调 `client.start(...)`。

## 代码约定

- 注释与文档：中文；标识符、commit message：英文。
- commit message 前缀 `mwf:`。
- Import 相对路径必须带 `.js` 扩展名（NodeNext）；类型导入用 `import type`（verbatimModuleSyntax）。
- 时间戳统一 UTC ISO 字符串（`new Date().toISOString()`），可直接字符串比较，可直接进 timestamptz。
- 新增公开 API 必须同时从 `src/index.ts` 导出，并在 README 状态表里更新状态。
- 内部实现细节不进 `src/index.ts`。

## 命令

```bash
pnpm install
pnpm check      # tsc --noEmit + vitest run（提交前必须绿）
pnpm test
pnpm build      # tsc → dist/
```

## 当前进度（新增功能时同步更新）

Phase A 之前。**已实现并有测试**：

- `src/json.ts`、`src/definition/*`（归一化 / 校验 / hash / stableStringify）
- `src/core/errors.ts`、`registry.ts`、`transitions.ts`
- `src/runtime/*`（状态机与记录类型、retry backoff 计算）
- `src/storage/memory.ts`（五类 Store 全部实现）

**是桩，不要当已实现来用**：

| 桩 | 抛什么 | Phase |
|---|---|---|
| `WorkflowEngine.start` / `tick` | `NotImplementedError` | A |
| `StepRunner.executeStep` | `NotImplementedError` | A |
| `PostgresWorkflowStorage.*` | `NotImplementedError` | B |
| `WorkflowWorker.tick` | `NotImplementedError` | C |
| `WorkflowEngine.signal` / `cancel` | `NotImplementedError` | D |

`Scheduler` / `LeaseManager` 已可用（调度循环与 lease 心跳是真的）。

## 下一步（Phase A）

`engine.start()`：publish definition → 建 `WorkflowRun`（CREATED）+ 首个 `StepRun`(PENDING) →
写 `workflow.created` 事件。
`engine.tick(runId)`：claim → `StepRunner.executeStep` → handler → 落 step_run →
合并 patch → `resolveNextStep` → 下一步；撞 `maxStepsPerTick` 就 requeue。

对应的测试（先写测试再实现，见 `docs/architecture.md` 的「测试即规格」）：
`A → B → C`、条件分支、`maxStepsPerTick` 防死循环。
