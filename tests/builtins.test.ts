import { describe, expect, it } from "vitest";

import { ValidationError, parseDuration } from "../src/index.js";

describe("parseDuration（手搓，不引第三方）", () => {
  it("裸数字 = 毫秒", () => {
    expect(parseDuration(1_500)).toBe(1_500);
    expect(parseDuration("1500")).toBe(1_500);
  });

  it("单个单位", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(parseDuration("1w")).toBe(604_800_000);
  });

  it("组合写法与空格", () => {
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1h 30m")).toBe(5_400_000);
    expect(parseDuration("1d2h3m4s5ms")).toBe(86_400_000 + 7_200_000 + 180_000 + 4_000 + 5);
  });

  it("小数也认（0.5s）", () => {
    expect(parseDuration("0.5s")).toBe(500);
  });

  it("解析不了就报错，不要猜", () => {
    expect(() => parseDuration("两天")).toThrow(ValidationError);
    expect(() => parseDuration("2x")).toThrow(ValidationError);
    expect(() => parseDuration("")).toThrow(ValidationError);
    expect(() => parseDuration("1h30")).toThrow(ValidationError);
    expect(() => parseDuration(-1)).toThrow(ValidationError);
    expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
  });
});
