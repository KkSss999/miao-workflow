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

**V1 的核心闭环已经跑通**（130 个测试；Postgres 部分需要 Docker，没有就自动跳过）。

已实现：

- `src/json.ts`、`src/definition/*`（归一化 / 校验 / hash / stableStringify）
- `src/core/*`：errors / registry（含 publish 前覆盖检查）/ transitions /
  runner（handler · JSON 校验 · 超时 · 挂起契约）/ engine（start · tick · signal · cancel ·
  reconcile · 事件流 · 内置 handler 注册）
- `src/runtime/*`：状态机与记录 · retry backoff · **builtins（`workflow.delay` / `workflow.complete` ·
  手搓 duration 解析）**
- `src/storage/*`：interface · memory · postgres · schema（DDL 权威来源）
- `src/worker/*`：worker（抢占 · 心跳 · drain · 失败隔离）· lease · scheduler

**没有桩了。** 下一步是 Phase F（WASM handler 宿主，独立扩展包）与 IntakeOps 真实接入验证。

## Phase A 定下来的语义（改之前先读懂，否则会破坏崩溃恢复）

1. **「我做到哪」= `run.currentStepId` + `run.currentStepRunId` 指针。**
   - 指针指向的 step run 是 COMPLETED → 恢复时**只重放 patch，不重放副作用**
   - 指针为空 → 下一步是一次全新的访问；回边的 visit 自然 +1
   - 指针悬空（写下指针后、step run 落库前崩了）→ 复用**同一个 step run id 与同一幂等键**
2. **执行前先写指针**，否则「已完成但没推进」这个窗口会变成重复副作用。
3. **visit 完全由已落库的记录推导**：`(latest?.visit ?? 0) + 1`。
4. **`input` = 上一个 COMPLETED 且 stepId 不同的 step run 的 output**；首步为 `run.input`。
   ⚠️ 推论：**`run.input` 只有首步看得到** —— 后面都要用的东西（比如 intakeId）由首步 patch 进 context。
5. **run 级事件（`workflow.*`）的 `stepId` 必须是 null**；`step.*` 才带 stepId。
6. **撞到 `maxStepsPerTick` 不是错误**：交回队列（release lease），下一轮从 `currentStepId` 继续。
7. **UNKNOWN 永不自动重试**；只有可重试的失败才写 RETRYING + wake_at。

## Phase B/C/D 定下来的约定

1. **status 只由 engine 写。** `claimDue` 只写 lease，**绝不改 status**。
   踩过两次：claim 顺手把 `CREATED` 改成 `RUNNING` 会吞掉 `workflow.started` 事件；
   把 `WAITING` 改成 `RUNNING` 会让 engine 再也看不到「这一步在等信号」。
2. **「是不是在挂起」看当前 step run 的 `status === 'WAITING'` + `waitFor`**，不要看 `run.status`。
3. **挂起信息（`waitFor` / `waitPayload` / `wakeAt`）在失败与成功之后都必须保留** ——
   被信号叫醒的那次尝试失败后重试，不能再要一次信号。
4. **signal 只写信号，不碰 run。** run 靠 `claimDue` 里的 EXISTS 条件变回可抢，
   所以不存在「信号记下了但 run 没被叫醒」的崩溃窗口。别为了「快一点」在这里加 run 更新。
5. **lease 的时钟必须和 engine 同源**（`WorkflowWorker` 默认 `engine.now`）。
   多个 engine 共享同一 storage 时，注入的 `newId` 必须全局唯一（默认 randomUUID；顺序 id 会撞车）。
6. **内存实现要守 Postgres 的约束**：外键（step run / signal / event 必须指向存在的 run）、
   主键唯一、`idempotency_key` 唯一。两边不一致 = conformance 白写。
7. **顺序 = 插入顺序**：三张表用自增 `seq`，查询 `ORDER BY seq`；**绝不用随机 id 做 tiebreak**。
8. **没有 `MWF_TEST_POSTGRES_URL` 就跳过**，不要假装测过；`pnpm test:postgres` 拉临时容器。

## 命令

```bash
pnpm install
pnpm check          # typecheck + 全部测试（memory conformance）
pnpm test:postgres  # 临时容器跑同一套 conformance
pnpm check:all      # 都要绿（提交前跑这个）
pnpm build          # tsc → dist/
pnpm schema:sync    # src/storage/schema.ts → docs/postgres-schema.sql
```

## 下一步（Phase F：WASM handler 宿主 + 真实接入）

- Phase F：独立扩展包（`@catease/workflow-wasm`），Core 不动 —— handler 边界已经是 JSON in/out
- IntakeOps 真实接入：`registry.register` 包住现有 service，触发层只调 `client.start`
- 想加功能之前先回看 README 的「明确不做」清单
