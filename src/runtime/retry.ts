import type { RetryBackoff, RetryPolicy } from "../definition/step.js";

export interface NormalizedRetryPolicy {
  maxAttempts: number;
  backoff: RetryBackoff;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitter: boolean;
}

/**
 * 默认不重试。
 *
 * 重试必须是显式决定 —— 因为「重试」意味着我们相信失败是暂时且幂等的，
 * 这个判断只有写 handler 的人做得出来。
 */
export const DEFAULT_RETRY_POLICY: NormalizedRetryPolicy = {
  maxAttempts: 1,
  backoff: "exponential",
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  multiplier: 2,
  jitter: true,
};

/** 抖动幅度：±20% */
export const JITTER_RATIO = 0.2;

export function normalizeRetryPolicy(policy?: RetryPolicy): NormalizedRetryPolicy {
  if (policy === undefined) return { ...DEFAULT_RETRY_POLICY };
  return {
    maxAttempts: policy.maxAttempts,
    backoff: policy.backoff ?? DEFAULT_RETRY_POLICY.backoff,
    initialDelayMs: policy.initialDelayMs ?? DEFAULT_RETRY_POLICY.initialDelayMs,
    maxDelayMs: policy.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    multiplier: policy.multiplier ?? DEFAULT_RETRY_POLICY.multiplier,
    jitter: policy.jitter ?? DEFAULT_RETRY_POLICY.jitter,
  };
}

/**
 * @param attempt 已经失败的次数（1-based）。第一次失败传 1。
 */
export function shouldRetry(
  policy: RetryPolicy | NormalizedRetryPolicy | undefined,
  attempt: number,
): boolean {
  const normalized = isNormalized(policy) ? policy : normalizeRetryPolicy(policy);
  return attempt < normalized.maxAttempts;
}

/**
 * 下一次尝试前等多久（毫秒）。
 *
 * 退避策略是引擎的决定，不是 handler 的决定 —— handler 只负责说「我失败了、可不可重试」。
 *
 * @param attempt 已经失败的次数（1-based）
 * @param rng     注入随机源，测试里传固定值即可得到确定结果
 */
export function computeBackoffMs(
  policy: RetryPolicy | NormalizedRetryPolicy,
  attempt: number,
  rng: () => number = Math.random,
): number {
  const normalized = isNormalized(policy) ? policy : normalizeRetryPolicy(policy);
  const failedAttempts = Math.max(1, Math.floor(attempt));
  const raw =
    normalized.backoff === "fixed"
      ? normalized.initialDelayMs
      : normalized.initialDelayMs * normalized.multiplier ** (failedAttempts - 1);

  const capped = Math.min(raw, normalized.maxDelayMs);
  if (!normalized.jitter) return Math.round(capped);

  const factor = 1 + (rng() * 2 - 1) * JITTER_RATIO;
  return Math.max(0, Math.round(capped * factor));
}

function isNormalized(
  policy: RetryPolicy | NormalizedRetryPolicy | undefined,
): policy is NormalizedRetryPolicy {
  return (
    policy !== undefined &&
    "backoff" in policy &&
    "initialDelayMs" in policy &&
    "maxDelayMs" in policy &&
    "multiplier" in policy &&
    "jitter" in policy
  );
}
