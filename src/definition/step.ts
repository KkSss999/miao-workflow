import type { JsonObject } from "../json.js";

/**
 * Step / Transition 的定义形态。
 *
 * 这里出现的每个值都必须能 JSON.stringify 之后无损还原：
 * 不允许 function / class / Date / RegExp / Symbol / undefined。
 * 条件判断不是 JS 表达式，而是注册在 Registry 上的 guard 名字。
 */

export type StepId = string;
export type HandlerName = string;
export type GuardName = string;

export type RetryBackoff = "fixed" | "exponential";

export interface RetryPolicy {
  /** 总尝试次数（含首次执行），>= 1。1 表示不重试。 */
  maxAttempts: number;
  backoff?: RetryBackoff;
  /** 第一次重试前等待多久 */
  initialDelayMs?: number;
  /** 单次退避上限 */
  maxDelayMs?: number;
  /** exponential 的倍数 */
  multiplier?: number;
  /** ±20% 抖动，避免一批 run 同时重试打爆下游 */
  jitter?: boolean;
}

export interface Transition {
  to: StepId;
  /** 注册在 Registry 上的 guard 名；省略 = 无条件兜底分支（必须放在数组最后） */
  when?: GuardName;
}

/** 手写形态，允许简写 */
export type TransitionInput = StepId | Transition;

export interface StepMeta {
  title?: string;
  description?: string;
}

/** 作者手写的 step */
export interface StepDefinitionInput {
  /** handler 名，例如 "ai.classify" / "human.approval" */
  uses: HandlerName;
  config?: JsonObject;
  next?: TransitionInput | TransitionInput[] | null;
  retry?: RetryPolicy;
  timeoutMs?: number;
  meta?: StepMeta;
}

/** 归一化之后的 step（`defineWorkflow` 的产物）。step id 就是 steps 对象里的 key。 */
export interface StepDefinition {
  uses: HandlerName;
  config?: JsonObject;
  /** 永远是数组；空数组表示终点步骤 */
  next: Transition[];
  retry?: RetryPolicy;
  timeoutMs?: number;
  meta?: StepMeta;
}
