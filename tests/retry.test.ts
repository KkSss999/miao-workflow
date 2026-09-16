import { describe, expect, it } from "vitest";

import { DEFAULT_RETRY_POLICY, JITTER_RATIO, computeBackoffMs, normalizeRetryPolicy, shouldRetry } from "../src/index.js";

describe("retry policy", () => {
  it("默认不重试", () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(1);
    expect(shouldRetry(undefined, 1)).toBe(false);
  });

  it("maxAttempts 是总尝试次数（含首次）", () => {
    const policy = { maxAttempts: 3 };
    expect(shouldRetry(policy, 1)).toBe(true);
    expect(shouldRetry(policy, 2)).toBe(true);
    expect(shouldRetry(policy, 3)).toBe(false);
  });

  it("缺省字段从默认值补齐", () => {
    expect(normalizeRetryPolicy({ maxAttempts: 5 })).toEqual({ ...DEFAULT_RETRY_POLICY, maxAttempts: 5 });
  });

  it("fixed 退避每次都等 initialDelayMs", () => {
    const policy = { maxAttempts: 5, backoff: "fixed" as const, initialDelayMs: 500, jitter: false };
    expect(computeBackoffMs(policy, 1)).toBe(500);
    expect(computeBackoffMs(policy, 2)).toBe(500);
    expect(computeBackoffMs(policy, 3)).toBe(500);
  });

  it("exponential 退避逐次翻倍", () => {
    const policy = { maxAttempts: 5, backoff: "exponential" as const, initialDelayMs: 1_000, jitter: false };
    expect(computeBackoffMs(policy, 1)).toBe(1_000);
    expect(computeBackoffMs(policy, 2)).toBe(2_000);
    expect(computeBackoffMs(policy, 3)).toBe(4_000);
  });

  it("退避不会超过 maxDelayMs", () => {
    const policy = {
      maxAttempts: 10,
      backoff: "exponential" as const,
      initialDelayMs: 1_000,
      maxDelayMs: 5_000,
      jitter: false,
    };
    expect(computeBackoffMs(policy, 10)).toBe(5_000);
  });

  it("jitter 落在 ±20% 区间内，避免一批 run 同时重试", () => {
    const policy = { maxAttempts: 3, backoff: "fixed" as const, initialDelayMs: 1_000, jitter: true };
    expect(computeBackoffMs(policy, 1, () => 0)).toBe(1_000 * (1 - JITTER_RATIO));
    expect(computeBackoffMs(policy, 1, () => 1)).toBe(1_000 * (1 + JITTER_RATIO));
    expect(computeBackoffMs(policy, 1, () => 0.5)).toBe(1_000);
  });
});
