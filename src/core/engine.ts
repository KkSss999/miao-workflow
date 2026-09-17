import { randomUUID } from "node:crypto";

import { hashDefinition } from "../definition/validation.js";
import { defineWorkflow, type WorkflowDefinition, type WorkflowDefinitionInput } from "../definition/workflow.js";
import type { StepDefinition, StepId } from "../definition/step.js";
import type { JsonObject, JsonValue } from "../json.js";
import { createCompleteHandler, createDelayHandler, type StepResume } from "../runtime/builtins.js";
import type { WorkflowEventType } from "../runtime/events.js";
import { computeBackoffMs, normalizeRetryPolicy, shouldRetry } from "../runtime/retry.js";
import {
  isTerminalRunStatus,
  type IsoTimestamp,
  type RunStatus,
  type WorkflowRun,
  type WorkflowRunPatch,
} from "../runtime/run.js";
import type { StepRun } from "../runtime/step-run.js";
import type { SignalOptions } from "../runtime/signal.js";
import type { WorkflowStorage } from "../storage/interface.js";
import {
  DefinitionNotFoundError,
  LeaseLostError,
  RunNotFoundError,
  RunNotActiveError,
  ValidationError,
} from "./errors.js";
import { Registry, RESERVED_HANDLERS, assertRegistryCoverage, createRegistry } from "./registry.js";
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
   * 传了就会**每一步开始前续租**；续不动说明 lease 被别人抢走，立刻抛 LeaseLostError 停止推进。
   * 不传 = 不做 lease 管理（进程内直接跑 / 测试用）。
   *
   * 传 owner 必须同时传 leaseMs —— 否则续租的租期是多少？宁可不猜。
   */
  owner?: string;
  leaseMs?: number;
}

export interface TickResult {
  /** 本次真正执行了多少个 step */
  steps: number;
  status: RunStatus;
}

/** FAILED 的 run 的人工处置决定。 */
export type ReconcileDecision =
  /** 确认外部没成功（或对方能按幂等键去重）→ 用**同一个幂等键**重跑 */
  | "retry"
  /** 放弃这个 run */
  | "abandon";

interface WaitResolution {
  resume: StepResume;
  stepId: StepId;
  via: "signal" | "delay";
  /** 消费信号时会更新 step run（waitPayload），调用方要把这条记录同步进本地历史 */
  stepRun: StepRun | null;
}

/**
 * 引擎 = Definition + Storage + Registry。
 *
 * 它只做这些事：发布定义、起 run、推进 run、送到信号、取消、处理未知结果。
 * 它的词汇表里没有 CRM、工单、IM、邮件、模型服务这类业务概念 —— 那些都通过注册表接进来。
 */
export class WorkflowEngine {
  readonly storage: WorkflowStorage;
  readonly registry: Registry;
  readonly limits: EngineLimits;

  /** 引擎的时钟。注入它 = 时间在测试里可控；worker 的 lease 也用同一个时钟。 */
  readonly now: () => Date;

  readonly #newId: () => string;
  readonly #random: () => number;
  readonly #runner: StepRunner;

  /**
   * 已发布内容缓存：`workflowId@version` → hash。
   *
   * definition 一旦发布就不可变，所以同一个进程里重复 `start(definition)` 不必每次都打库。
   * 只省一次写 —— 内容不一致时仍然会走到 storage，由它抛 StorageConflictError。
   */
  readonly #publishedHashes = new Map<string, string>();

  /**
   * definition 缓存：`workflowId@version` → definition。
   *
   * 同样依赖「发布即不可变」这条不变量。一个进程见过的版本数有限（远小于 run 数），
   * 所以不需要 LRU。
   */
  readonly #definitions = new Map<string, WorkflowDefinition>();

  constructor(options: WorkflowEngineOptions) {
    this.storage = options.storage;
    this.registry = options.registry ?? createRegistry();
    this.limits = { ...DEFAULT_ENGINE_LIMITS, ...options.limits };
    if (!Number.isInteger(this.limits.maxStepsPerTick) || this.limits.maxStepsPerTick < 1) {
      // 0 / 负数会让 run 永远推不动，worker 还会空转 —— 启动时就该炸
      throw new ValidationError(`maxStepsPerTick 必须是 >= 1 的整数，收到 ${this.limits.maxStepsPerTick}`, {
        details: { maxStepsPerTick: this.limits.maxStepsPerTick },
      });
    }
    this.now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => randomUUID());
    this.#random = options.random ?? (() => Math.random());
    this.#runner = new StepRunner({
      registry: this.registry,
      storage: this.storage,
      now: this.now,
    });

    // 内置 handler：Runtime 自己的能力。业务想覆盖就覆盖（先注册者胜）。
    if (!this.registry.has(RESERVED_HANDLERS.delay)) {
      this.registry.register(RESERVED_HANDLERS.delay, createDelayHandler(this.now));
    }
    if (!this.registry.has(RESERVED_HANDLERS.complete)) {
      this.registry.register(RESERVED_HANDLERS.complete, createCompleteHandler());
    }
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

    const hash = hashDefinition(definition);
    const key = `${definition.id}@${definition.version}`;

    // 本进程已经发过完全一样的内容 → 不必再打库（发布不可变，重复写是纯浪费）
    if (this.#publishedHashes.get(key) === hash) return definition;

    await this.storage.definitions.save({ definition, definitionHash: hash });
    this.#publishedHashes.set(key, hash);
    this.#definitions.set(key, definition);
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
   * 送到外部信号 —— 人类审批、webhook 回调、别的系统通知，全都是这个。
   *
   * 只做一件事：**落库**（外加一条审计事件）。
   *
   * 刻意不在这里顺手推进 run：
   * - 落库是唯一的写操作 → 不存在「信号已记下但 run 没被叫醒」的崩溃窗口
   * - 执行永远发生在 worker 里，请求路径不干重活
   *
   * run 会被「有匹配的未消费信号」这个条件捞起来（见 storage 的 claimDue）。
   */
  async signal(
    runId: string,
    name: string,
    payload?: JsonValue,
    options: SignalOptions = {},
  ): Promise<void> {
    const run = await this.#requireRun(runId);
    if (isTerminalRunStatus(run.status)) throw new RunNotActiveError(runId, run.status);

    const stepId = options.stepId ?? null;
    if (stepId !== null) {
      // 定向就该校验：打错 step 名字和打错信号名字一样致命，而且更难查
      const definition = await this.#requireDefinitionVersion(run);
      if (!Object.hasOwn(definition.steps, stepId)) {
        throw new ValidationError(`run "${runId}" 的 workflow 里没有 step "${stepId}"`, {
          details: { runId, stepId, workflowId: run.workflowId, version: run.workflowVersion },
        });
      }
    }

    await this.storage.signals.append({
      id: this.#newId(),
      runId,
      name,
      stepId,
      payload,
      createdAt: this.#nowIso(),
      consumedAt: null,
    });

    await this.#emit(runId, null, "signal.received", {
      name,
      ...(stepId === null ? {} : { stepId }),
      ...(payload === undefined ? {} : { payload }),
    });
  }

  /**
   * 取消 run。
   *
   * 正在跑的 handler 不会被掐断（跨进程做不到）—— 这一点必须诚实：
   * 取消是**状态层面**的，副作用层面靠幂等键与 reconciliation 兜。
   */
  async cancel(runId: string): Promise<WorkflowRun> {
    const run = await this.#requireRun(runId);
    if (isTerminalRunStatus(run.status)) throw new RunNotActiveError(runId, run.status);

    const at = this.#nowIso();
    const cancelled = await this.#setRun(run, { status: "CANCELLED", wakeAt: null, completedAt: at });
    if (run.leaseOwner !== null) await this.storage.runs.releaseLease(runId, run.leaseOwner);

    await this.#emit(runId, null, "workflow.cancelled", {
      ...(run.currentStepId === null ? {} : { stepId: run.currentStepId }),
    });
    return cancelled;
  }

  /**
   * 人工 / 系统 reconciliation 入口 —— **FAILED 的 run 也能救回来**。
   *
   * 两类失败都从这里走：
   *
   * - `UNKNOWN_OUTCOME`：请求超时了，对方到底做没做不知道。自动重试会造成重复副作用，
   *   所以必须有人（或对账系统）看一眼再决定。
   * - 重试耗尽的 `STEP_FAILED`：下游修好了（服务恢复、配置改正），运维想再试一次。
   *
   * 决定：
   * - `"retry"`：同一条 step run、同一个 visit、**同一个幂等键**重跑 —— 幂等键不变是关键，
   *   下游才能去重。同时把 `failures` 复位为 0：人工重试意味着「从这一刻重新开始」，
   *   重试策略重新生效（否则 maxAttempts=1 的步骤再也不会被自动重试）。
   * - `"abandon"`：放弃，run 置为 CANCELLED（保留 error 供审计）
   */
  async reconcile(runId: string, decision: ReconcileDecision): Promise<WorkflowRun> {
    const run = await this.#requireRun(runId);
    if (run.status !== "FAILED") throw new RunNotActiveError(runId, run.status);

    if (decision === "abandon") {
      const at = this.#nowIso();
      const abandoned = await this.#setRun(run, { status: "CANCELLED", wakeAt: null, completedAt: at });
      await this.#emit(runId, null, "workflow.cancelled", {
        reason: "reconcile.abandon",
        ...(run.currentStepId === null ? {} : { stepId: run.currentStepId }),
        ...(run.error === null ? {} : { previousCode: run.error.code }),
      });
      return abandoned;
    }

    const active = await this.#activeStepRun(run);
    if (active !== null) {
      // 复位失败计数，让重试策略对这次人工重试重新生效
      await this.storage.steps.update(active.id, { failures: 0 });
    }

    const resumed = await this.#setRun(run, { status: "RUNNING", error: null, wakeAt: null, completedAt: null });
    await this.#emit(runId, null, "workflow.resumed", {
      reason: "reconcile.retry",
      ...(run.currentStepId === null ? {} : { stepId: run.currentStepId }),
      ...(run.error === null ? {} : { previousCode: run.error.code, previousRetryable: run.error.retryable }),
    });
    return resumed;
  }

  /**
   * 推进一个 run：
   *
   * ```
   * claim（由 Worker 负责）→ 解挂起（signal / delay）→ execute step → persist
   *   → patch context → transition → 继续
   * ```
   *
   * 直到 WAITING / 终态 / 撞到 maxStepsPerTick。
   */
  async tick(runId: string, options: TickOptions = {}): Promise<TickResult> {
    let run = await this.#requireRun(runId);
    if (isTerminalRunStatus(run.status)) return { steps: 0, status: run.status };

    const { owner, leaseMs } = options;
    if (owner !== undefined) {
      if (leaseMs === undefined) {
        throw new ValidationError("tick 传了 owner 就必须同时传 leaseMs（续租要用）");
      }
      if (run.leaseOwner !== null && run.leaseOwner !== owner) throw new LeaseLostError(runId);
    }

    const definition = await this.#requireDefinitionVersion(run);

    try {
      return await this.#runLoop(run, definition, owner, leaseMs);
    } finally {
      // 所有出口统一释放：WAITING / 终态 / 撞上限 / 抛错都一样。
      // 释放用的是 owner，别人抢不走的前提下这永远是幂等的。
      if (owner !== undefined) await this.storage.runs.releaseLease(run.id, owner);
    }
  }

  async #runLoop(
    initialRun: WorkflowRun,
    definition: WorkflowDefinition,
    owner: string | undefined,
    leaseMs: number | undefined,
  ): Promise<TickResult> {
    let run = initialRun;

    // 历史只读一次，之后增量维护 —— 原来每一步都 listByRun（长 run 上是 O(步数²) 的行数）
    const history = await this.storage.steps.listByRun(run.id);

    // 挂起解不解得开？
    //
    // 注意：判断依据是**当前 step run 的状态**，不是 run.status ——
    // 因为 claim 会把 WAITING 改写成 RUNNING（「这个 run 现在归我处理」），
    // 如果看 run.status，就永远发现不了「这一步其实在等信号」。
    let pendingResume: StepResume | undefined;
    const waitingStep = await this.#activeStepRun(run);

    if (waitingStep !== null && waitingStep.status === "WAITING" && waitingStep.waitFor !== null) {
      const resolution = await this.#resolveWait(run, waitingStep);
      if (resolution === null) {
        // 还没等到（比如信号被别人先消费了）→ 放回 WAITING，交还 lease，不空转
        if (run.status !== "WAITING") {
          run = await this.#setRun(run, { status: "WAITING", wakeAt: waitingStep.wakeAt });
        }
        return { steps: 0, status: "WAITING" };
      }

      if (resolution.stepRun !== null) upsert(history, resolution.stepRun);
      pendingResume = resolution.resume;
      run = await this.#setRun(run, { status: "RUNNING", wakeAt: null });
      await this.#emit(run.id, null, "workflow.resumed", {
        stepId: resolution.stepId,
        waitFor: resolution.resume.waitFor,
        via: resolution.via,
      });
    } else if (run.status === "CREATED") {
      run = await this.#setRun(run, { status: "RUNNING" });
      await this.#emit(run.id, null, "workflow.started", { start: definition.start });
    }

    let steps = 0;
    while (steps < this.limits.maxStepsPerTick) {
      // 非终态的 run 必须有明确的当前步骤。这里**不能** fallback 到 definition.start ——
      // 那等于把整个 workflow 从头重跑一遍（重复副作用），比直接报错危险得多。
      if (run.currentStepId === null) {
        throw new ValidationError(`run "${run.id}" 状态是 ${run.status}，但没有 currentStepId`, {
          details: { runId: run.id, status: run.status },
        });
      }
      const stepId = run.currentStepId;
      const step = definition.steps[stepId];
      if (step === undefined) {
        throw new ValidationError(`run "${run.id}" 指向不存在的 step "${stepId}"`, {
          details: { runId: run.id, stepId },
        });
      }

      // lease 还握在自己手里吗？（长 handler 由心跳兜，这里负责「边界处」的一致性检查）
      if (owner !== undefined && leaseMs !== undefined) {
        const renewed = await this.storage.runs.renewLease(run.id, owner, leaseMs);
        if (!renewed) throw new LeaseLostError(run.id);
      }

      const active =
        run.currentStepRunId === null
          ? null
          : (history.find((item) => item.id === run.currentStepRunId) ?? null);
      const latest = lastOf(history.filter((item) => item.stepId === stepId));
      const previous = lastOf(
        history.filter((item) => item.status === "COMPLETED" && item.stepId !== stepId),
      );
      const input: JsonValue | undefined = previous === null ? run.input : previous.output;

      // 崩溃恢复：指针指向的这一步已经成功过 → 不重放副作用，只重放状态（patch）
      if (active !== null && active.status === "COMPLETED") {
        steps += 1;
        const advanced = await this.#advance({ run, stepId, step, output: active.output, patch: active.patch });
        if (isTerminalRunStatus(advanced.status)) return { steps, status: advanced.status };
        run = advanced;
        continue;
      }

      const resuming = active !== null;
      const visit = resuming ? active.visit : (latest?.visit ?? 0) + 1;
      const stepRunId = resuming ? active.id : (run.currentStepRunId ?? this.#newId());

      // 解挂起只对「当前这一步」生效；之后的步骤回到正常状态
      const resume = pendingResume ?? reconstructResume(active);
      pendingResume = undefined;

      if (run.currentStepRunId !== stepRunId) {
        // 先把「我正要做这个」写下来，崩在中间时恢复路径才认得出来
        run = await this.#setRun(run, { status: "RUNNING", currentStepRunId: stepRunId });
      }

      await this.#emit(run.id, stepId, "step.started", {
        visit,
        attempt: (resuming ? active.attempt : 0) + 1,
        ...(resume === undefined ? {} : { resumed: true }),
      });

      const outcome = await this.#runner.execute({
        run,
        stepId,
        step,
        visit,
        stepRunId,
        input,
        existing: resuming ? active : null,
        ...(resume === undefined ? {} : { resume }),
      });
      upsert(history, outcome.stepRun);
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
          await this.#emit(run.id, null, "workflow.waiting", {
            stepId,
            waitFor: outcome.stepRun.waitFor,
          });
          return { steps, status: run.status };
        }

        case "UNKNOWN": {
          // 外部结果未知：不自动重试，等人工 / 系统 reconciliation（engine.reconcile）
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

          // 用 failures 而不是 attempt：等待被唤醒重新执行不该吃掉重试预算
          if (retryable && shouldRetry(policy, outcome.stepRun.failures)) {
            const delayMs = computeBackoffMs(policy, outcome.stepRun.failures, this.#random);
            run = await this.#setRun(run, {
              status: "RETRYING",
              wakeAt: this.#isoAfter(delayMs),
              currentStepId: stepId,
            });
            await this.#emit(run.id, stepId, "step.retrying", { attempt: outcome.stepRun.attempt, delayMs });
            await this.#emit(run.id, null, "workflow.retrying", {
              stepId,
              attempt: outcome.stepRun.attempt,
              delayMs,
            });
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
    return { steps, status: run.status };
  }

  /**
   * 挂起解不解得开？
   *
   * 两个条件，先到先得：
   *   1. 有匹配的未消费信号 → 消费掉（落进 step run 的 waitPayload，重试时还能拿到）
   *   2. `wake_at` 到点（delay / 等待超时）
   */
  async #resolveWait(run: WorkflowRun, active: StepRun): Promise<WaitResolution | null> {
    const at = this.#nowIso();
    const waitFor = active.waitFor;

    if (waitFor !== null) {
      const signal = await this.storage.signals.consumeNext({
        runId: run.id,
        name: waitFor,
        stepId: active.stepId,
        sinceSeq: active.waitSinceSeq ?? 0,
        now: at,
      });
      if (signal !== null) {
        // 落库：万一接下来这一步失败重试，信号还在
        await this.storage.steps.update(active.id, { waitPayload: signal.payload });
        return {
          stepId: active.stepId,
          via: "signal",
          stepRun: { ...active, waitPayload: signal.payload },
          resume: {
            waitFor,
            ...(signal.payload === undefined ? {} : { payload: signal.payload }),
          },
        };
      }

      if (active.wakeAt !== null && active.wakeAt <= at) {
        return {
          stepId: active.stepId,
          via: "delay",
          stepRun: null,
          resume: { waitFor, wakeAt: active.wakeAt },
        };
      }
      return null;
    }

    // 没有 waitFor 的挂起（正常不会出现）：run 的 wake_at 到点就往前推
    if (run.wakeAt !== null && run.wakeAt <= at) {
      return {
        stepId: run.currentStepId ?? "",
        via: "delay",
        stepRun: null,
        resume: { waitFor: "unknown", wakeAt: run.wakeAt },
      };
    }
    return null;
  }

  /** run 指针指向的那条 step run（没有就是 null）。 */
  async #activeStepRun(run: WorkflowRun): Promise<StepRun | null> {
    if (run.currentStepRunId === null) return null;
    return this.storage.steps.get(run.currentStepRunId);
  }

  /**
   * 保留策略：删掉已经结束且结束时间早于 `before` 的 run（连带它的 step run / signal / event）。
   *
   * 审计数据只增不减，一个高频 workflow 跑一年就是几千万行 —— 定期调用它，或者在外面挂个 cron。
   * 只删终态：RUNNING / WAITING 的 run 可能正被别的 worker 处理。
   *
   * @example 只保留最近 30 天
   * ```ts
   * await engine.prune({ before: new Date(Date.now() - 30 * 86_400_000).toISOString() });
   * ```
   */
  async prune(input: { before: IsoTimestamp; limit?: number }): Promise<{ deletedRuns: number }> {
    const deletedRuns = await this.storage.runs.deleteTerminalBefore(input.before, input.limit);
    return { deletedRuns };
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
    const key = `${run.workflowId}@${run.workflowVersion}`;
    const cached = this.#definitions.get(key);
    if (cached !== undefined) return cached;

    const definition = await this.storage.definitions.get(run.workflowId, run.workflowVersion);
    if (definition === null) throw new DefinitionNotFoundError(run.workflowId, run.workflowVersion);
    this.#definitions.set(key, definition);
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
    return this.now().toISOString();
  }

  #isoAfter(delayMs: number): string {
    return new Date(this.now().getTime() + delayMs).toISOString();
  }
}

/**
 * 使用方（Web 后端、CLI、触发器）只需要认识这个门面。
 *
 * ```ts
 * const client = new WorkflowClient(engine);
 * const run = await client.start("order-to-delivery", { input: { orderId: "ORD-1024" } });
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

  async signal(runId: string, name: string, payload?: JsonValue, options?: SignalOptions): Promise<void> {
    return this.engine.signal(runId, name, payload, options);
  }

  async cancel(runId: string): Promise<WorkflowRun> {
    return this.engine.cancel(runId);
  }

  async reconcile(runId: string, decision: ReconcileDecision): Promise<WorkflowRun> {
    return this.engine.reconcile(runId, decision);
  }

  async get(runId: string): Promise<WorkflowRun> {
    return this.engine.get(runId);
  }
}

function lastOf<T>(items: T[]): T | null {
  return items.length === 0 ? null : (items[items.length - 1] as T);
}

/** 把一条 step run 同步进本地历史（有就替换，没有就追加 —— 顺序仍然是插入顺序） */
function upsert(history: StepRun[], stepRun: StepRun): void {
  const index = history.findIndex((item) => item.id === stepRun.id);
  if (index === -1) history.push(stepRun);
  else history[index] = stepRun;
}

/**
 * 重试 / 恢复时把上一轮挂起的信息还给 handler。
 *
 * 这一步很关键：假如下游在「被叫醒之后」失败了，重试时不能再要一次信号 ——
 * 信号是外部世界给的，不会自己再来一遍。所以 payload 存在 step run 上。
 */
function reconstructResume(active: StepRun | null): StepResume | undefined {
  // 只要这一步「等过东西」，之后的每次尝试都应该拿到同样的 resume 信息
  if (active === null || active.waitFor === null) return undefined;

  return {
    waitFor: active.waitFor,
    ...(active.wakeAt === null ? {} : { wakeAt: active.wakeAt }),
    ...(active.waitPayload === undefined ? {} : { payload: active.waitPayload }),
  };
}
