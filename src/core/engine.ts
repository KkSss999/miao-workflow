import { randomUUID } from "node:crypto";

import { hashDefinition } from "../definition/validation.js";
import { defineWorkflow, type WorkflowDefinition, type WorkflowDefinitionInput } from "../definition/workflow.js";
import type { StepDefinition, StepId } from "../definition/step.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { WorkflowEventType } from "../runtime/events.js";
import { computeBackoffMs, normalizeRetryPolicy, shouldRetry } from "../runtime/retry.js";
import { isTerminalRunStatus, type RunStatus, type WorkflowRun, type WorkflowRunPatch } from "../runtime/run.js";
import type { StepRun } from "../runtime/step-run.js";
import type { WorkflowStorage } from "../storage/interface.js";
import {
  DefinitionNotFoundError,
  LeaseLostError,
  NotImplementedError,
  RunNotFoundError,
  ValidationError,
} from "./errors.js";
import { Registry, assertRegistryCoverage, createRegistry } from "./registry.js";
import { StepRunner } from "./runner.js";
import { resolveNextStep } from "./transitions.js";

export interface EngineLimits {
  /**
   * 一次 tick 最多推进多少个 step。
   *
   * 防的是 `A → B → A → B` 这种 bug 把 CPU 吃穿：撞到上限就重新排队，而不是死循环。
   */
  maxStepsPerTick: number;
}

export const DEFAULT_ENGINE_LIMITS: EngineLimits = {
  maxStepsPerTick: 32,
};

export interface WorkflowEngineOptions {
  storage: WorkflowStorage;
  registry?: Registry;
  limits?: Partial<EngineLimits>;
  /** 覆盖时钟，测试用 */
  now?: () => Date;
  /** 覆盖 id 生成，测试用 */
  newId?: () => string;
  /** 覆盖随机源（backoff jitter），测试用 */
  random?: () => number;
}

export interface StartRunOptions {
  input?: JsonValue;
  /** 指定 run id（重放 / 迁移用）；默认由 engine 生成 */
  runId?: string;
}

export interface TickOptions {
  /**
   * 持有该 run lease 的 worker 标识。
   *
   * - 传了：tick 前会确认 lease 还是自己的，撞上限时主动 release（交给别的 worker）
   * - 不传：不做 lease 管理（进程内直接跑 / 测试用）
   */
  owner?: string;
}

export interface TickResult {
  /** 本次真正执行了多少个 step */
  steps: number;
  status: RunStatus;
}

/**
 * 引擎 = Definition + Storage + Registry。
 *
 * 它只做四件事：发布定义、起 run、推进 run、处理信号。
 * 不认识 Intake / Lead / Slack / Email，也不认识 OpenAI。
 */
export class WorkflowEngine {
  readonly storage: WorkflowStorage;
  readonly registry: Registry;
  readonly limits: EngineLimits;

  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #random: () => number;
  readonly #runner: StepRunner;

  constructor(options: WorkflowEngineOptions) {
    this.storage = options.storage;
    this.registry = options.registry ?? createRegistry();
    this.limits = { ...DEFAULT_ENGINE_LIMITS, ...options.limits };
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => randomUUID());
    this.#random = options.random ?? (() => Math.random());
    this.#runner = new StepRunner({
      registry: this.registry,
      storage: this.storage,
      now: this.#now,
    });
  }

  /**
   * 发布 definition。
   *
   * - 同 version + 同内容 → 幂等，什么都不发生
   * - 同 version + 改内容 → StorageConflictError，逼你升版本
   * - 引用了没注册的 handler / guard → ValidationError（宁可启动时炸）
   *
   * 已发布版本不可修改，是「老 run 永远能跑完」的前提。
   */
  async publish(input: WorkflowDefinitionInput | WorkflowDefinition): Promise<WorkflowDefinition> {
    const definition = defineWorkflow(input);
    assertRegistryCoverage(definition, this.registry);

    await this.storage.definitions.save({
      definition,
      definitionHash: hashDefinition(definition),
    });
    return definition;
  }

  /**
   * 起一个 run。传 definition 对象会自动先 publish（幂等）。
   *
   * run 会绑死 definition 的版本：之后发布 v2 不影响它。
   */
  async start(workflow: string | WorkflowDefinition, options: StartRunOptions = {}): Promise<WorkflowRun> {
    const definition =
      typeof workflow === "string" ? await this.#requirePublished(workflow) : await this.publish(workflow);

    assertRegistryCoverage(definition, this.registry);

    const at = this.#nowIso();
    const run: WorkflowRun = {
      id: options.runId ?? this.#newId(),
      workflowId: definition.id,
      workflowVersion: definition.version,
      status: "CREATED",
      input: options.input,
      context: {},
      currentStepId: definition.start,
      currentStepRunId: null,
      wakeAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      error: null,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    };

    await this.storage.runs.create(run);
    await this.#emit(run.id, null, "workflow.created", {
      workflowId: definition.id,
      workflowVersion: definition.version,
      start: definition.start,
    });

    return run;
  }

  async get(runId: string): Promise<WorkflowRun> {
    return this.#requireRun(runId);
  }

  /**
   * 推进一个 run：
   *
   * ```
   * claim（由 Worker 负责）→ execute step → persist → patch context → transition → 继续
   * ```
   *
   * 直到 WAITING / 终态 / 撞到 maxStepsPerTick。
   *
   * 只做顺序 + 条件分支（V1 不支持并行与循环，回边只用于防死循环测试）。
   */
  async tick(runId: string, options: TickOptions = {}): Promise<TickResult> {
    let run = await this.#requireRun(runId);
    if (isTerminalRunStatus(run.status)) return { steps: 0, status: run.status };
    // Phase D 才会消费 signal；现在 WAITING 就是「等」
    if (run.status === "WAITING") return { steps: 0, status: run.status };

    const { owner } = options;
    if (owner !== undefined && run.leaseOwner !== null && run.leaseOwner !== owner) {
      throw new LeaseLostError(runId);
    }

    const definition = await this.#requireDefinitionVersion(run);

    if (run.status === "CREATED") {
      run = await this.#setRun(run, { status: "RUNNING" });
      await this.#emit(run.id, null, "workflow.started", { start: definition.start });
    }

    let steps = 0;
    while (steps < this.limits.maxStepsPerTick) {
      const stepId = run.currentStepId ?? definition.start;
      const step = definition.steps[stepId];
      if (step === undefined) {
        throw new ValidationError(`run "${run.id}" 指向不存在的 step "${stepId}"`, {
          details: { runId: run.id, stepId },
        });
      }

      const history = await this.storage.steps.listByRun(run.id);
      const active =
        run.currentStepRunId === null
          ? null
          : (history.find((item) => item.id === run.currentStepRunId) ?? null);
      const latest = lastOf(history.filter((item) => item.stepId === stepId));
      const previous = lastOf(
        history.filter((item) => item.status === "COMPLETED" && item.stepId !== stepId),
      );
      const input: JsonValue | undefined = previous === null ? run.input : previous.output;

      // 崩溃恢复：指针指向的这一步已经成功过 → 不重放副作用，只重放状态（patch 存在 step run 里）
      if (active !== null && active.status === "COMPLETED") {
        steps += 1;
        const advanced = await this.#advance({
          run,
          stepId,
          step,
          output: active.output,
          patch: active.patch,
        });
        if (isTerminalRunStatus(advanced.status)) return { steps, status: advanced.status };
        run = advanced;
        continue;
      }

      const resuming = active !== null;
      // visit 完全由已落库的记录推导：同一次访问内重试复用，回边则 +1
      const visit = resuming ? active.visit : (latest?.visit ?? 0) + 1;
      // 指针可能悬空（执行中崩过）—— 复用同一个 id，保证幂等键前后一致
      const stepRunId = resuming ? active.id : (run.currentStepRunId ?? this.#newId());

      if (run.currentStepRunId !== stepRunId) {
        // 先把「我正要做这个」写下来，这样崩在中间时恢复路径能识别出来
        run = await this.#setRun(run, { status: "RUNNING", currentStepRunId: stepRunId });
      }

      await this.#emit(run.id, stepId, "step.started", {
        visit,
        attempt: (resuming ? active.attempt : 0) + 1,
      });

      const outcome = await this.#runner.execute({
        run,
        stepId,
        step,
        visit,
        stepRunId,
        input,
        existing: resuming ? active : null,
      });
      steps += 1;

      switch (outcome.status) {
        case "COMPLETED": {
          await this.#emit(run.id, stepId, "step.completed", { visit, attempt: outcome.stepRun.attempt });
          const advanced = await this.#advance({
            run,
            stepId,
            step,
            output: outcome.output,
            patch: outcome.patch,
          });
          if (isTerminalRunStatus(advanced.status)) return { steps, status: advanced.status };
          run = advanced;
          continue;
        }

        case "WAITING": {
          run = await this.#setRun(run, {
            status: "WAITING",
            wakeAt: outcome.stepRun.wakeAt,
            currentStepId: stepId,
          });
          await this.#emit(run.id, stepId, "step.waiting", { visit, waitFor: outcome.stepRun.waitFor });
          await this.#emit(run.id, null, "workflow.waiting", { stepId, waitFor: outcome.stepRun.waitFor });
          return { steps, status: run.status };
        }

        case "UNKNOWN": {
          // 外部结果未知：不自动重试，等人工 / 系统 reconciliation
          run = await this.#fail(run, stepId, outcome.stepRun);
          await this.#emit(run.id, stepId, "step.unknown", { visit, attempt: outcome.stepRun.attempt });
          await this.#emit(run.id, null, "workflow.failed", {
            stepId,
            code: outcome.stepRun.error?.code ?? "UNKNOWN_OUTCOME",
          });
          return { steps, status: run.status };
        }

        case "FAILED": {
          const policy = normalizeRetryPolicy(step.retry);
          const retryable = outcome.stepRun.error?.retryable ?? false;

          if (retryable && shouldRetry(policy, outcome.stepRun.attempt)) {
            const delayMs = computeBackoffMs(policy, outcome.stepRun.attempt, this.#random);
            run = await this.#setRun(run, {
              status: "RETRYING",
              wakeAt: this.#isoAfter(delayMs),
              currentStepId: stepId,
            });
            await this.#emit(run.id, stepId, "step.retrying", { attempt: outcome.stepRun.attempt, delayMs });
            await this.#emit(run.id, null, "workflow.retrying", { stepId, attempt: outcome.stepRun.attempt, delayMs });
            return { steps, status: run.status };
          }

          run = await this.#fail(run, stepId, outcome.stepRun);
          await this.#emit(run.id, stepId, "step.failed", {
            visit,
            attempt: outcome.stepRun.attempt,
            code: outcome.stepRun.error?.code ?? "STEP_FAILED",
          });
          await this.#emit(run.id, null, "workflow.failed", {
            stepId,
            code: outcome.stepRun.error?.code ?? "STEP_FAILED",
          });
          return { steps, status: run.status };
        }
      }
    }

    // 撞上 maxStepsPerTick：交回队列，下一轮从 currentStepId 继续（这不是错误）
    if (owner !== undefined) await this.storage.runs.releaseLease(run.id, owner);
    return { steps, status: run.status };
  }

  /**
   * 送到外部信号（人类审批、webhook 回调…）。
   * 先落库再 wake，所以进程崩了也不丢。
   *
   * Phase D 实现。
   */
  async signal(_runId: string, _name: string, _payload?: JsonValue): Promise<void> {
    throw new NotImplementedError("WorkflowEngine.signal（Phase D）");
  }

  /** Phase D 实现。 */
  async cancel(_runId: string): Promise<void> {
    throw new NotImplementedError("WorkflowEngine.cancel（Phase D）");
  }

  /** 执行一步之后决定下一步：合并 patch → resolveNextStep → 落 run 状态。 */
  async #advance(args: {
    run: WorkflowRun;
    stepId: StepId;
    step: StepDefinition;
    output: JsonValue | undefined;
    patch: JsonObject | undefined;
  }): Promise<WorkflowRun> {
    const { run, stepId, step, output, patch } = args;
    const context: JsonObject = patch === undefined ? run.context : { ...run.context, ...patch };

    const next = resolveNextStep({
      runId: run.id,
      stepId,
      step,
      context,
      output,
      guards: this.registry,
    });

    if (next === null) {
      const at = this.#nowIso();
      const completed = await this.#setRun(run, {
        status: "COMPLETED",
        context,
        currentStepId: null,
        currentStepRunId: null,
        wakeAt: null,
        completedAt: at,
        error: null,
      });
      await this.#emit(run.id, null, "workflow.completed", { lastStepId: stepId });
      return completed;
    }

    return this.#setRun(run, {
      status: "RUNNING",
      context,
      currentStepId: next,
      // 清空指针 = 下一步是一次全新的访问（回边时 visit 自然 +1）
      currentStepRunId: null,
      wakeAt: null,
    });
  }

  async #fail(run: WorkflowRun, stepId: StepId, stepRun: StepRun): Promise<WorkflowRun> {
    return this.#setRun(run, {
      status: "FAILED",
      error: stepRun.error,
      currentStepId: stepId,
      wakeAt: null,
    });
  }

  async #setRun(run: WorkflowRun, patch: WorkflowRunPatch): Promise<WorkflowRun> {
    await this.storage.runs.update(run.id, patch);
    return { ...run, ...patch, updatedAt: this.#nowIso() };
  }

  async #requireRun(runId: string): Promise<WorkflowRun> {
    const run = await this.storage.runs.get(runId);
    if (run === null) throw new RunNotFoundError(runId);
    return run;
  }

  /** run 绑死的那个版本 —— 不是「最新版」。 */
  async #requireDefinitionVersion(run: WorkflowRun): Promise<WorkflowDefinition> {
    const definition = await this.storage.definitions.get(run.workflowId, run.workflowVersion);
    if (definition === null) throw new DefinitionNotFoundError(run.workflowId, run.workflowVersion);
    return definition;
  }

  async #requirePublished(workflowId: string): Promise<WorkflowDefinition> {
    const definition = await this.storage.definitions.getLatest(workflowId);
    if (definition === null) throw new DefinitionNotFoundError(workflowId);
    return definition;
  }

  async #emit(runId: string, stepId: StepId | null, type: WorkflowEventType, payload: JsonObject): Promise<void> {
    await this.storage.events.append({
      id: this.#newId(),
      runId,
      stepId,
      type,
      payload,
      createdAt: this.#nowIso(),
    });
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }

  #isoAfter(delayMs: number): string {
    return new Date(this.#now().getTime() + delayMs).toISOString();
  }
}

/**
 * 使用方（Web 后端、CLI、触发器）只需要认识这个门面。
 *
 * ```ts
 * const client = new WorkflowClient(engine);
 * const run = await client.start("intake-to-action", { input: { intakeId: "INT-1024" } });
 * await client.signal(run.id, "approval", { decision: "approve" });
 * ```
 */
export class WorkflowClient {
  readonly engine: WorkflowEngine;

  constructor(engine: WorkflowEngine) {
    this.engine = engine;
  }

  async start(workflow: string | WorkflowDefinition, options: StartRunOptions = {}): Promise<WorkflowRun> {
    return this.engine.start(workflow, options);
  }

  async signal(runId: string, name: string, payload?: JsonValue): Promise<void> {
    return this.engine.signal(runId, name, payload);
  }

  async cancel(runId: string): Promise<void> {
    return this.engine.cancel(runId);
  }

  async get(runId: string): Promise<WorkflowRun> {
    return this.engine.get(runId);
  }
}

function lastOf<T>(items: T[]): T | null {
  return items.length === 0 ? null : (items[items.length - 1] as T);
}
