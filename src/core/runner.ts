import type { StepDefinition, StepId } from "../definition/step.js";
import { isJsonValue, type JsonObject, type JsonValue } from "../json.js";
import type { StepResume } from "../runtime/builtins.js";
import type { IsoTimestamp, WorkflowRun } from "../runtime/run.js";
import { buildIdempotencyKey, type StepRun, type StepStatus } from "../runtime/step-run.js";
import type { WorkflowStorage } from "../storage/interface.js";
import {
  ValidationError,
  WorkflowError,
  serializeError,
  toWorkflowError,
  type SerializedWorkflowError,
} from "./errors.js";
import type { Registry } from "./registry.js";

/**
 * Handler 契约 —— 整个系统最核心的抽象。
 *
 * Handler 只回答两个问题：
 *   1. 这一步怎么做？
 *   2. 做完之后 context 要怎么变？
 *
 * 它**不**回答：下一步去哪（transition 回答）、失败要不要重试（retry policy 回答）、
 * 状态怎么落库（storage 回答）。
 */
export interface StepExecutionContext {
  runId: string;
  stepRunId: string;
  stepId: StepId;

  /** 上一步的 output（start 步骤则为 run.input） */
  input: JsonValue | undefined;
  /** 到目前为止累积的 context */
  context: JsonObject;

  /** 1-based 尝试次数 */
  attempt: number;
  /** 第几次进入这个 step */
  visit: number;

  /**
   * 幂等键：同一次 step run 的所有 attempt 共用。
   * 调外部 API 时请带上（Stripe / Resend 等都支持 Idempotency-Key）。
   */
  idempotencyKey: string;

  /** 超时 / 取消信号，传给 fetch 之类的 API */
  signal: AbortSignal;

  /**
   * 上一轮挂起的信息 —— **只有被叫醒重新执行时才有值**。
   *
   * handler 的写法因此永远是「同样的代码跑两次」：
   *
   * ```ts
   * async execute(ctx) {
   *   if (ctx.resume === undefined) return { status: "waiting", waitFor: "approval" };
   *   return { status: "completed", output: ctx.resume.payload };
   * }
   * ```
   *
   * 这意味着 handler 必须是幂等的 —— 它可能因为崩溃恢复被多跑几次。
   */
  resume?: StepResume;
}

/**
 * Step 的结果只有三种形态。刻意不提供第四种。
 *
 * - `completed` —— 成功，可以带 output 与 context patch
 * - `waiting`   —— 挂起等信号（human-in-the-loop / delay），没有 Promise 挂在那里
 * - `failed`    —— 失败；是否重试由 retry policy 决定，不由 handler 决定
 */
export type StepResult<TOutput = unknown> =
  | { status: "completed"; output?: TOutput; patch?: JsonObject }
  | { status: "waiting"; waitFor: string; wakeAt?: IsoTimestamp }
  | { status: "failed"; error: WorkflowError };

/**
 * @typeParam TConfig 该 handler 期望的 config（definition 里的 `config` 字段）
 * @typeParam TOutput 输出
 *
 * 两个泛型都不做类型层约束 —— 因为 TypeScript 的 interface 没有隐式 index signature，
 * 强制 `extends JsonValue` 会逼使用者把 interface 改成 type 别名，那太烦人。
 * 「output / patch 必须是 JSON」由运行时守：StepRunner 拿到结果后会做 `isJsonValue` 检查。
 *
 * 边界刻意保持 **JSON in / JSON out**：这样将来 WASM handler 宿主（Phase F）不需要动 Core。
 */
export interface StepHandler<TConfig = unknown, TOutput = unknown> {
  execute(context: StepExecutionContext, config: TConfig): Promise<StepResult<TOutput>>;
}

export interface StepRunnerOptions {
  registry: Registry;
  storage: WorkflowStorage;
  now?: () => Date;
}

export interface StepExecutionArgs {
  run: WorkflowRun;
  stepId: StepId;
  step: StepDefinition;
  /** 本次访问序号（由 Engine 从已落库的记录推导） */
  visit: number;
  /** 本次 step run 的 id：由 Engine 决定，崩溃恢复时复用同一个 id */
  stepRunId: string;
  /** 被叫醒重新执行时带上挂起信息（首次执行/普通重试为 undefined） */
  resume?: StepResume;
  /** 上一步的 output；start 步骤为 run.input */
  input: JsonValue | undefined;
  /**
   * 已存在的 step run：重试 / 崩溃恢复时复用同一条记录，也就复用了同一个幂等键。
   * 新一轮访问（回边）应当传 null。
   */
  existing: StepRun | null;
}

export interface StepExecutionOutcome {
  stepRun: StepRun;
  status: StepStatus;
  output: JsonValue | undefined;
  patch: JsonObject | undefined;
}

/**
 * 执行单个 step：拼 context → 调 handler → 校验结果 → 落库。
 *
 * 它**不**决定下一步（那是 resolveNextStep 的事），也**不**决定要不要重试（那是 Engine 看
 * retry policy 的事）。它只负责「把一次尝试变成一条可以审计的记录」。
 *
 * 超时用 Promise.race 强制生效：即使 handler 不遵守 AbortSignal，Engine 也不会被它吊死。
 */
export class StepRunner {
  constructor(readonly options: StepRunnerOptions) {}

  async execute(args: StepExecutionArgs): Promise<StepExecutionOutcome> {
    const { run, stepId, step, visit, stepRunId, input, existing, resume } = args;
    const nowIso = (): IsoTimestamp => (this.options.now?.() ?? new Date()).toISOString();

    const attempt = (existing?.attempt ?? 0) + 1;
    const idempotencyKey = existing?.idempotencyKey ?? buildIdempotencyKey(run.id, stepId, visit);
    const startedAt = nowIso();

    const handler = this.options.registry.resolve(step.uses);
    const controller = new AbortController();
    const timer = startTimeout(step.timeoutMs, controller);

    let result: StepResult<unknown>;
    try {
      const context: StepExecutionContext = {
        runId: run.id,
        stepRunId,
        stepId,
        input,
        context: run.context,
        attempt,
        visit,
        idempotencyKey,
        signal: controller.signal,
        ...(resume === undefined ? {} : { resume }),
      };

      const execution = handler.execute(context, step.config);
      // race 之后原 promise 可能才 reject，先挂个空 catch，避免 unhandled rejection
      execution.catch(() => undefined);
      result = await Promise.race([execution, abortPromise(controller, stepId, step)]);
    } catch (error) {
      result = { status: "failed", error: toStepError(error, controller, stepId, step) };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    // 注意：这里**不要**再补一次「signal 已 abort 就算超时」。
    // 结果由上面的 race 决定：handler 先落定就信它的结果，abort 先落定就是超时。
    // 补那一下只会在边界毫秒上把已经成功的执行误判成超时（进而被重试 → 重复副作用）。

    try {
      return await this.#persist({
        run,
        stepId,
        step,
        existing,
        stepRunId,
        idempotencyKey,
        attempt,
        visit,
        input,
        startedAt,
        result,
      });
    } catch (error) {
      // 落库 / 校验阶段的任何异常都不许逃出引擎：它必须变成一条可审计的失败记录，
      // 否则 run 会卡在 RUNNING 且没有任何痕迹（静默活锁）。
      return this.#persistFailure(
        { run, stepId, step, existing, stepRunId, idempotencyKey, attempt, visit, input, startedAt },
        error,
      );
    }
  }

  /** 连「写失败记录」都失败时才会抛出去 —— 那种情况存储已经不可用了。 */
  async #persistFailure(
    args: {
      run: WorkflowRun;
      stepId: StepId;
      step: StepDefinition;
      existing: StepRun | null;
      stepRunId: string;
      idempotencyKey: string;
      attempt: number;
      visit: number;
      input: JsonValue | undefined;
      startedAt: IsoTimestamp;
    },
    cause: unknown,
  ): Promise<StepExecutionOutcome> {
    const { run, stepId, step, existing, stepRunId, idempotencyKey, attempt, visit, input, startedAt } = args;
    const error = serializeError(
      toWorkflowError(cause, { code: "VALIDATION_ERROR", message: `step "${step.uses}" 的结果无法落库` }),
    );
    const finishedAt = (this.options.now?.() ?? new Date()).toISOString();
    const fields = {
      status: "FAILED" as const,
      attempt,
      failures: (existing?.failures ?? 0) + 1,
      visit,
      input,
      output: undefined,
      patch: undefined,
      error,
      waitFor: existing?.waitFor ?? null,
      waitSinceSeq: existing?.waitSinceSeq ?? null,
      wakeAt: existing?.wakeAt ?? null,
      startedAt,
      finishedAt,
    };

    if (existing === null) {
      const created: StepRun = {
        id: stepRunId,
        runId: run.id,
        stepId,
        idempotencyKey,
        createdAt: startedAt,
        updatedAt: finishedAt,
        ...fields,
      };
      await this.options.storage.steps.create(created);
      return { stepRun: created, status: "FAILED", output: undefined, patch: undefined };
    }

    await this.options.storage.steps.update(stepRunId, fields);
    return {
      stepRun: { ...existing, ...fields, updatedAt: finishedAt },
      status: "FAILED",
      output: undefined,
      patch: undefined,
    };
  }

  async #persist(args: {
    run: WorkflowRun;
    stepId: StepId;
    step: StepDefinition;
    existing: StepRun | null;
    stepRunId: string;
    idempotencyKey: string;
    attempt: number;
    visit: number;
    input: JsonValue | undefined;
    startedAt: IsoTimestamp;
    result: StepResult<unknown>;
  }): Promise<StepExecutionOutcome> {
    const { run, stepId, step, existing, stepRunId, idempotencyKey, attempt, visit, input, startedAt, result } = args;

    let status: StepStatus;
    let failures = existing?.failures ?? 0;
    let output: JsonValue | undefined;
    let patch: JsonObject | undefined;
    let error: SerializedWorkflowError | null = null;
    // 挂起信息要在失败/成功之后**保留**：被信号叫醒的那次尝试如果失败了，
    // 重试时不能再要一次信号 —— 外部世界不会自己再来一遍。
    let waitFor: string | null = existing?.waitFor ?? null;
    let waitSinceSeq: number | null = existing?.waitSinceSeq ?? null;
    let wakeAt: IsoTimestamp | null = existing?.wakeAt ?? null;

    if (result.status === "completed") {
      const invalid = firstNonJson({ output: result.output ?? null, patch: result.patch ?? null });
      if (invalid !== null) {
        status = "FAILED";
        error = serializeError(
          new ValidationError(`handler "${step.uses}" 返回的 ${invalid} 不是 JSON，无法落库`, {
            details: { stepId, handler: step.uses, field: invalid },
          }),
        );
      } else {
        status = "COMPLETED";
        // 上面的 isJsonValue 已经确认过，这里只是把 unknown 收窄
        output = result.output as JsonValue | undefined;
        patch = result.patch as JsonObject | undefined;
      }
    } else if (result.status === "waiting") {
      status = "WAITING";
      waitFor = result.waitFor;
      wakeAt = result.wakeAt ?? null;
      // 水位线：此刻队列里已有多少条信号。之后到达的才允许唤醒这次等待。
      waitSinceSeq = await this.options.storage.signals.watermark(run.id);
    } else {
      error = serializeError(result.error);
      // UNKNOWN 必须是一等状态：外部可能已经成功，自动重试会造成重复副作用
      status = result.error.code === "UNKNOWN_OUTCOME" ? "UNKNOWN" : "FAILED";
      failures += 1;
    }

    const finishedAt = (this.options.now?.() ?? new Date()).toISOString();
    const fields = {
      status,
      attempt,
      failures,
      visit,
      input,
      output,
      patch,
      error,
      waitFor,
      waitSinceSeq,
      wakeAt,
      startedAt,
      finishedAt,
    };

    if (existing === null) {
      const created: StepRun = {
        id: stepRunId,
        runId: run.id,
        stepId,
        idempotencyKey,
        createdAt: startedAt,
        updatedAt: finishedAt,
        ...fields,
      };
      await this.options.storage.steps.create(created);
      return { stepRun: created, status, output, patch };
    }

    await this.options.storage.steps.update(stepRunId, fields);
    return { stepRun: { ...existing, ...fields, updatedAt: finishedAt }, status, output, patch };
  }
}

function startTimeout(timeoutMs: number | undefined, controller: AbortController): NodeJS.Timeout | null {
  if (timeoutMs === undefined) return null;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return timer;
}

function abortPromise(
  controller: AbortController,
  stepId: StepId,
  step: StepDefinition,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(timeoutError(stepId, step)), { once: true });
  });
}

function timeoutError(stepId: StepId, step: StepDefinition): WorkflowError {
  return new WorkflowError(`step "${stepId}" 执行超时（${step.timeoutMs ?? 0}ms）`, {
    code: "STEP_TIMEOUT",
    retryable: true,
    details: { stepId, handler: step.uses },
  });
}

function toStepError(
  error: unknown,
  controller: AbortController,
  stepId: StepId,
  step: StepDefinition,
): WorkflowError {
  if (controller.signal.aborted) return timeoutError(stepId, step);
  return toWorkflowError(error, { code: "STEP_FAILED" });
}

function firstNonJson(fields: Record<string, unknown>): string | null {
  for (const [name, value] of Object.entries(fields)) {
    if (!isJsonValue(value)) return name;
  }
  return null;
}
