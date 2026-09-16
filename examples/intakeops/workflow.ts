import { defineWorkflow } from "../../src/index.js";

/**
 * IntakeOps 的 intake-to-action 流程 —— mwf 的第一个 dogfood。
 *
 * 注意这里没有一个字提到 Resend / HubSpot / Slack / OpenAI。
 * Definition 只知道「下一步是什么」，怎么做是 handler 的事。
 *
 * 真实项目里 import 路径是：
 *
 * ```ts
 * import { defineWorkflow } from "@catease/workflow";
 * ```
 */
export const intakeToAction = defineWorkflow({
  id: "intake-to-action",
  version: 1,
  start: "triage",
  meta: {
    title: "IntakeOps：从收到请求到落地动作",
    description: "AI 分类 → 人工审批 → 建 lead → 发邮件",
    tags: ["intakeops", "dogfood"],
  },
  steps: {
    triage: {
      uses: "ai.triage",
      retry: { maxAttempts: 3, backoff: "exponential", initialDelayMs: 1_000 },
      timeoutMs: 30_000,
      next: [{ to: "manual-review", when: "confidence.low" }, { to: "approval" }],
    },

    "manual-review": {
      uses: "human.review",
      next: "approval",
    },

    approval: {
      uses: "human.approval",
      // 人类审批可能等几天 —— 不占进程、不挂 Promise，进程随便重启
      next: "create-lead",
    },

    "create-lead": {
      uses: "lead.create",
      retry: { maxAttempts: 2, initialDelayMs: 2_000 },
      next: "send-email",
    },

    // 没有 next = 终点步骤，跑完 run 就是 COMPLETED
    "send-email": {
      uses: "email.send",
      retry: { maxAttempts: 3, initialDelayMs: 5_000 },
    },
  },
});

export default intakeToAction;
