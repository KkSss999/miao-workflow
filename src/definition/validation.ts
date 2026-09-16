import { createHash } from "node:crypto";

import { ValidationError } from "../core/errors.js";
import type { JsonValue } from "../json.js";
import type {
  StepDefinition,
  StepDefinitionInput,
  StepId,
  Transition,
  TransitionInput,
} from "./step.js";
import type { WorkflowDefinition, WorkflowDefinitionInput } from "./workflow.js";

const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * 把简写形态归一化。
 *
 * ```
 * next: "approval"                                  → [{ to: "approval" }]
 * next: [{ to: "review", when: "confidence.low" }]   → 原样
 * next: undefined | null                             → []（终点步骤）
 * ```
 */
export function normalizeTransitions(next: TransitionInput | TransitionInput[] | null | undefined): Transition[] {
  if (next === undefined || next === null) return [];
  const list: TransitionInput[] = Array.isArray(next) ? next : [next];
  return list.map((item, index) => {
    if (typeof item === "string") return { to: item };
    if (typeof item === "object" && item !== null && typeof item.to === "string") {
      return item.when === undefined ? { to: item.to } : { to: item.to, when: item.when };
    }
    throw new ValidationError(`transitions[${index}] 必须是 step id 字符串或 { to, when? }`, {
      details: { index },
    });
  });
}

export function normalizeStepDefinition(stepId: StepId, input: StepDefinitionInput): StepDefinition {
  if (typeof input !== "object" || input === null) {
    throw new ValidationError(`step "${stepId}" 必须是对象`, { details: { stepId } });
  }
  if (typeof input.uses !== "string" || input.uses.length === 0) {
    throw new ValidationError(`step "${stepId}" 缺少 uses`, { details: { stepId } });
  }

  const step: StepDefinition = {
    uses: input.uses,
    next: normalizeTransitions(input.next),
  };
  if (input.config !== undefined) step.config = input.config;
  if (input.retry !== undefined) step.retry = { ...input.retry };
  if (input.timeoutMs !== undefined) step.timeoutMs = input.timeoutMs;
  if (input.meta !== undefined) step.meta = { ...input.meta };
  return step;
}

/** 归一化 + 校验。这是 `defineWorkflow()` 真正干的事。 */
export function normalizeDefinition(input: WorkflowDefinitionInput): WorkflowDefinition {
  if (typeof input !== "object" || input === null) {
    throw new ValidationError("workflow definition 必须是对象");
  }
  const { id, version, start, steps, meta } = input;

  if (typeof id !== "string" || id.length === 0) {
    throw new ValidationError("workflow.id 必须是非空字符串");
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError("workflow.version 必须是 >= 1 的整数", { details: { version } });
  }
  if (typeof start !== "string" || start.length === 0) {
    throw new ValidationError("workflow.start 必须是非空字符串");
  }
  if (typeof steps !== "object" || steps === null || Array.isArray(steps) || Object.keys(steps).length === 0) {
    throw new ValidationError("workflow.steps 必须是非空对象");
  }

  const normalizedSteps: Record<StepId, StepDefinition> = {};
  for (const [stepId, stepInput] of Object.entries(steps)) {
    if (!STEP_ID_PATTERN.test(stepId)) {
      throw new ValidationError(`step id "${stepId}" 非法（允许字母数字与 . _ : -）`, { details: { stepId } });
    }
    normalizedSteps[stepId] = normalizeStepDefinition(stepId, stepInput);
  }

  const definition: WorkflowDefinition = { id, version, start, steps: normalizedSteps };
  if (meta !== undefined) definition.meta = { ...meta };

  validateDefinition(definition);
  return definition;
}

/**
 * 结构校验。规则刻意保持「能被机器判定」：
 *
 * - start 必须存在
 * - transition 目标必须存在
 * - 无条件兜底分支必须放在数组最后（保证分支语义一眼可读）
 * - retry / timeout 数值合理
 * - 不存在不可达步骤
 * - 整体必须 JSON serializable
 */
export function validateDefinition(definition: WorkflowDefinition): void {
  assertJsonSerializable(definition, "workflow");

  if (!Object.hasOwn(definition.steps, definition.start)) {
    throw new ValidationError(`workflow.start "${definition.start}" 不在 steps 中`, {
      details: { start: definition.start },
    });
  }

  for (const [stepId, step] of Object.entries(definition.steps)) {
    step.next.forEach((transition, index) => {
      if (!Object.hasOwn(definition.steps, transition.to)) {
        throw new ValidationError(`step "${stepId}" 的 transition 指向不存在的步骤 "${transition.to}"`, {
          details: { stepId, to: transition.to },
        });
      }
      if (transition.when === undefined && index !== step.next.length - 1) {
        throw new ValidationError(`step "${stepId}" 的无条件分支必须放在 next 数组最后`, {
          details: { stepId, index },
        });
      }
    });

    if (step.timeoutMs !== undefined && !(step.timeoutMs > 0)) {
      throw new ValidationError(`step "${stepId}" 的 timeoutMs 必须 > 0`, { details: { stepId } });
    }

    const retry = step.retry;
    if (retry !== undefined) {
      if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1) {
        throw new ValidationError(`step "${stepId}" 的 retry.maxAttempts 必须是 >= 1 的整数`, {
          details: { stepId },
        });
      }
      if (retry.backoff !== undefined && retry.backoff !== "fixed" && retry.backoff !== "exponential") {
        throw new ValidationError(`step "${stepId}" 的 retry.backoff 只能是 fixed 或 exponential`, {
          details: { stepId },
        });
      }
      if (retry.initialDelayMs !== undefined && retry.initialDelayMs < 0) {
        throw new ValidationError(`step "${stepId}" 的 retry.initialDelayMs 必须 >= 0`, { details: { stepId } });
      }
      if (retry.maxDelayMs !== undefined && retry.maxDelayMs < 0) {
        throw new ValidationError(`step "${stepId}" 的 retry.maxDelayMs 必须 >= 0`, { details: { stepId } });
      }
      if (retry.multiplier !== undefined && retry.multiplier < 1) {
        throw new ValidationError(`step "${stepId}" 的 retry.multiplier 必须 >= 1`, { details: { stepId } });
      }
    }
  }

  const unreachable = findUnreachableSteps(definition);
  if (unreachable.length > 0) {
    throw new ValidationError(`存在不可达步骤：${unreachable.join(", ")}`, { details: { unreachable } });
  }
}

/** 从 start 做 BFS，返回走不到的 step id（按字典序）。 */
export function findUnreachableSteps(definition: WorkflowDefinition): StepId[] {
  const seen = new Set<StepId>([definition.start]);
  const queue: StepId[] = [definition.start];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const step = definition.steps[current];
    if (step === undefined) continue;
    for (const transition of step.next) {
      if (seen.has(transition.to)) continue;
      seen.add(transition.to);
      queue.push(transition.to);
    }
  }

  return Object.keys(definition.steps)
    .filter((stepId) => !seen.has(stepId))
    .sort();
}

/**
 * 稳定序列化：对象 key 排序，保证同一份 definition 永远得到同一个字符串。
 * 这是 definition hash 与 version 不可变判断的基础。
 */
export function stableStringify(value: JsonValue): string {
  return stringify(value);
}

function stringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stringify).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stringify(value[key] as JsonValue)}`);
  return `{${entries.join(",")}}`;
}

/** definition 的 sha256（hex）。发布后内容变了就是 hash 变了 —— 必须发新版本。 */
export function hashDefinition(definition: WorkflowDefinition): string {
  return createHash("sha256").update(stableStringify(definition as unknown as JsonValue)).digest("hex");
}

/**
 * 深度检查是否 JSON serializable，并指出具体路径。
 * 这是防止「definition 里偷偷塞了个 function」的唯一防线。
 */
export function assertJsonSerializable(value: unknown, path = "$"): void {
  const ancestors = new Set<object>();

  const walk = (current: unknown, currentPath: string): void => {
    if (current === null) return;

    switch (typeof current) {
      case "string":
      case "boolean":
        return;
      case "number":
        if (!Number.isFinite(current)) {
          throw new ValidationError(`${currentPath} 不是有限数字，definition 必须 JSON serializable`);
        }
        return;
      case "undefined":
        throw new ValidationError(`${currentPath} 是 undefined，definition 必须 JSON serializable`);
      case "function":
      case "symbol":
      case "bigint":
        throw new ValidationError(`${currentPath} 是 ${typeof current}，definition 必须 JSON serializable`);
      case "object":
        break;
      default:
        throw new ValidationError(`${currentPath} 类型不受支持：${typeof current}`);
    }

    const object = current as object;
    if (ancestors.has(object)) {
      throw new ValidationError(`${currentPath} 存在循环引用，definition 必须 JSON serializable`);
    }
    ancestors.add(object);
    try {
      if (Array.isArray(object)) {
        object.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
        return;
      }
      const proto: unknown = Object.getPrototypeOf(object);
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError(
          `${currentPath} 必须是 plain object（当前 ${protoName(proto)}），definition 必须 JSON serializable`,
        );
      }
      for (const [key, item] of Object.entries(object)) {
        walk(item, `${currentPath}.${key}`);
      }
    } finally {
      ancestors.delete(object);
    }
  };

  walk(value, path);
}

function protoName(proto: unknown): string {
  if (typeof proto !== "object" || proto === null) return String(proto);
  const ctor: unknown = (proto as { constructor?: unknown }).constructor;
  if (typeof ctor === "function" && ctor.name.length > 0) return ctor.name;
  return "unknown";
}
