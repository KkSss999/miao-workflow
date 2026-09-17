import {
  Registry,
  UnknownOutcomeError,
  toWorkflowError,
  type JsonValue,
  type StepHandler,
  type StepResult,
} from "../../src/index.js";

/**
 * 业务 handler —— 全部注册在 Registry 上，Core 对它们一无所知。
 *
 * 每个 handler 只回答两件事：
 *   1. 这一步怎么做（可以是包一层现有 service，不需要重写业务）
 *   2. 做完之后 context 怎么变（通过 patch）
 */

export interface ClassifyOutput {
  confidence: number;
  priority: "high" | "normal";
  summary: string;
}

/**
 * 分类。带重试的步骤必须幂等（这里只是读输入 + 写 context，天然幂等）。
 *
 * 注意一个约定：**run.input 只有首个 step 看得到**（后面的 step，input 是上一步的 output）。
 * 所以首个 step 应该把「后面都要用的东西」patch 进 context —— 这里就是 requestId。
 */
export const classifyHandler: StepHandler<{ model?: string }, ClassifyOutput> = {
  async execute(context, config) {
    const requestId = readRequestId(context.input);

    // 真实实现：await classifyService.run({ requestId, model: config?.model })
    // 示例里假装模型只给了 0.62 的置信度 → 会被 "confidence.low" 这个 guard 分流到人工复核
    const confidence = config?.model === "precise" ? 0.91 : 0.62;
    const priority = confidence > 0.8 ? "normal" : "high";

    return {
      status: "completed",
      output: { confidence, priority, summary: `${requestId} 已完成分类` },
      // patch 会合并进 context，供后续 guard 与 step 读取
      patch: { requestId, confidence, priority },
    };
  },
};

/**
 * 人工复核：挂起，等 "review" 信号。
 *
 * 没有 Promise 挂在那里，进程可以随便重启 —— 几天后人类点一下，
 * run 会被重新执行一遍，这次 `context.resume` 有值。
 */
export const manualReviewHandler: StepHandler = {
  async execute(context): Promise<StepResult> {
    if (context.resume === undefined) return { status: "waiting", waitFor: "review" };
    return {
      status: "completed",
      output: context.resume.payload ?? null,
      patch: { reviewedBy: reviewerOf(context.resume.payload) },
    };
  },
};

/** 人工审批：等 "approval" 信号。 */
export const approvalHandler: StepHandler = {
  async execute(context): Promise<StepResult> {
    if (context.resume === undefined) return { status: "waiting", waitFor: "approval" };
    return {
      status: "completed",
      output: context.resume.payload ?? null,
      patch: { approved: true },
    };
  },
};

/** 建记录：把现有 service 包一层，不重写业务逻辑。 */
export const recordHandler: StepHandler<{ source: string }> = {
  async execute(ctx, config) {
    // requestId 是首个 step patch 进 context 的（不是从 input 来的，input 是上一步的 output）
    const requestId = typeof ctx.context["requestId"] === "string" ? ctx.context["requestId"] : "unknown";

    // 真实实现：const record = await recordService.create({ requestId, source: config.source })
    const recordId = `rec_${requestId}`;

    return {
      status: "completed",
      output: { recordId },
      patch: { recordId, source: config?.source ?? "example" },
    };
  },
};

/** 发通知：副作用步骤的教科书做法 —— 幂等键 + UNKNOWN。 */
export const emailHandler: StepHandler<{ to: string; subject?: string }> = {
  async execute(context, config) {
    try {
      // 真实实现：await emailClient.send(payload, { idempotencyKey: context.idempotencyKey })
      // 同一次 step run 的所有 attempt 共用同一个 key，重试不会重复投递
      const emailId = `email_${context.idempotencyKey}`;
      return { status: "completed", output: { emailId, to: config?.to ?? "ops@example.com" } };
    } catch (error) {
      if (isTimeout(error)) {
        // 超时 ≠ 失败：对方可能已经发出去了。
        // 自动重试会造成重复投递，所以走 reconciliation，而不是 retry。
        return { status: "failed", error: new UnknownOutcomeError("通知投递结果未知", { cause: error }) };
      }
      // 明确失败 → 允许按 retry policy 重试
      return { status: "failed", error: toWorkflowError(error, { code: "STEP_FAILED", retryable: true }) };
    }
  },
};

/**
 * 接入入口 —— 应用启动时调一次。
 *
 * 这就是 Core 与应用的全部接缝：一个 handler 表 + 一个 guard 表。
 */
export function registerApprovalFlow(registry: Registry = new Registry()): Registry {
  return registry
    .register({
      "ai.classify": classifyHandler,
      "human.review": manualReviewHandler,
      "human.approval": approvalHandler,
      "record.create": recordHandler,
      "email.send": emailHandler,
    })
    .guard({
      // Definition 里只能写 "confidence.low"，不能写 JS 表达式 —— 避免造一个 sandbox
      "confidence.low": ({ context }) => Number(context["confidence"] ?? 1) < 0.75,
    });
}

function reviewerOf(payload: JsonValue | undefined): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "unknown";
  const reviewer = payload["reviewer"];
  return typeof reviewer === "string" ? reviewer : "unknown";
}

function readRequestId(input: JsonValue | undefined): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "unknown-request";
  const requestId = input["requestId"];
  return typeof requestId === "string" ? requestId : "unknown-request";
}

function isTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return name === "AbortError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT";
}
