import { defineWorkflow } from "../../src/index.js";

/**
 * 一个「请求 → 分类 → 人工复核 → 审批 → 落库 → 通知」的示例流程。
 *
 * 它演示的是**引擎的全部关键能力**（这也是它同时充当端到端测试的原因）：
 * 条件分支、人工挂起与恢复、重试、以及「首个 step 把后续都要用的东西 patch 进 context」。
 *
 * 注意这里没有一个字提到具体厂商或产品：Definition 只知道「下一步是什么」，
 * 怎么做是 handler 的事，由使用方自己注册。
 *
 * 真实项目里 import 路径是：
 *
 * ```ts
 * import { defineWorkflow } from "@catease/workflow";
 * ```
 */
export const requestToAction = defineWorkflow({
  id: "request-to-action",
  version: 1,
  start: "classify",
  meta: {
    title: "请求分类到落地动作",
    description: "AI 分类 → 人工复核 → 审批 → 建记录 → 发通知",
    tags: ["example"],
  },
  steps: {
    classify: {
      uses: "ai.classify",
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
      next: "create-record",
    },

    "create-record": {
      uses: "record.create",
      retry: { maxAttempts: 2, initialDelayMs: 2_000 },
      next: "notify",
    },

    // 没有 next = 终点步骤，跑完 run 就是 COMPLETED
    notify: {
      uses: "email.send",
      retry: { maxAttempts: 3, initialDelayMs: 5_000 },
    },
  },
});

export default requestToAction;
