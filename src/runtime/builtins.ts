import type { JsonObject, JsonValue } from "../json.js";
import { ValidationError } from "../core/errors.js";
import { RESERVED_HANDLERS } from "../core/registry.js";
import type { StepHandler, StepResult } from "../core/runner.js";
import type { IsoTimestamp } from "./run.js";

/**
 * 内置 handler —— Runtime 自己的能力，不是业务。
 *
 * 名字统一带 `workflow.` 前缀，一眼能看出是引擎提供的。
 */

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

type Unit = keyof typeof UNIT_MS;

const UNIT_PATTERN = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g;

/**
 * 手搓的 duration 解析（不引第三方依赖）。
 *
 * ```
 * parseDuration(1_500)      → 1500        （裸数字 = 毫秒）
 * parseDuration("500ms")    → 500
 * parseDuration("30s")      → 30_000
 * parseDuration("2d")       → 172_800_000
 * parseDuration("1h30m")    → 5_400_000    （可组合）
 * ```
 *
 * @throws ValidationError 解析不了就报错，不要猜
 */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new ValidationError(`duration 必须是非负有限数字，收到 ${input}`);
    }
    return input;
  }

  const text = input.trim();
  if (text.length === 0) throw new ValidationError("duration 不能为空");

  // 裸数字 = 毫秒
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);

  const compact = text.replace(/\s+/g, "").toLowerCase();
  let total = 0;
  let consumed = 0;

  UNIT_PATTERN.lastIndex = 0;
  for (const match of compact.matchAll(UNIT_PATTERN)) {
    const amount = match[1];
    const unit = match[2];
    if (amount === undefined || unit === undefined) continue;
    total += Number(amount) * UNIT_MS[unit as Unit];
    consumed += match[0].length;
  }

  if (consumed === 0 || consumed !== compact.length) {
    throw new ValidationError(
      `duration "${input}" 解析失败（支持 500ms / 30s / 5m / 2h / 3d / 2w，可组合如 1h30m）`,
    );
  }

  return total;
}

// 用 type 而不是 interface：type 别名才有隐式 index signature，才能直接注册进 Registry
export type DelayConfig = {
  /** 等待时长：`"2d"` / `"30m"` / 1500（毫秒） */
  duration: string | number;
};

/**
 * `workflow.delay` —— 延迟是**一等能力**，不是 `await sleep(...)`。
 *
 * ```
 * { uses: "workflow.delay", config: { duration: "2d" } }
 * ```
 *
 * 第一次执行：`WAITING` + `wake_at = now + duration`（不占进程、不挂 Promise）。
 * 到点后被 worker 捞起来重新执行：这次 `context.resume` 有值 → 直接完成。
 */
export function createDelayHandler(now: () => Date): StepHandler<DelayConfig, JsonObject> {
  return {
    async execute(context, config): Promise<StepResult<JsonObject>> {
      if (context.resume !== undefined) {
        const output: JsonObject = { waitedForMs: parseDuration(config?.duration ?? 0) };
        if (context.resume.wakeAt !== undefined) output["wokeAt"] = context.resume.wakeAt;
        return { status: "completed", output };
      }

      const durationMs = parseDuration(config?.duration ?? 0);
      return {
        status: "waiting",
        waitFor: RESERVED_HANDLERS.delay,
        wakeAt: new Date(now().getTime() + durationMs).toISOString(),
      };
    },
  };
}

/**
 * `workflow.complete` —— 显式终点。
 *
 * step 没有 `next` 时也等价于终点，这个 handler 存在的意义是让「终点」在 Definition 里看得见。
 */
export function createCompleteHandler(): StepHandler {
  return {
    async execute(): Promise<StepResult> {
      return { status: "completed" };
    },
  };
}

/** 一个 run 的挂起被叫醒时的上下文：是信号叫醒的，还是时间到点了。 */
export interface StepResume {
  /** 挂起时在等什么（signal 名或内置 wait 名） */
  waitFor: string;
  /** 时间到点被叫醒（delay / 超时）；信号叫醒时没有这个字段 */
  wakeAt?: IsoTimestamp;
  /** 信号带的 payload */
  payload?: JsonValue;
}

export { RESERVED_HANDLERS };
