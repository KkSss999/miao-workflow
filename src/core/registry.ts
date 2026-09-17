import type { GuardName, HandlerName, StepId } from "../definition/step.js";
import type { WorkflowDefinition } from "../definition/workflow.js";
import type { JsonObject, JsonValue } from "../json.js";
import {
  DuplicateRegistrationError,
  GuardNotFoundError,
  HandlerNotFoundError,
  ValidationError,
} from "./errors.js";
import type { StepHandler } from "./runner.js";

/**
 * Core 不认识业务。
 *
 * 它只知道 handler 名和 guard 名；"ai.classify" / "record.create" 这些名字背后的东西
 * 由使用方自己注册。
 */

export interface GuardContext {
  runId: string;
  stepId: StepId;
  /** 累积到当前步骤的 context（含本步的 patch） */
  context: JsonObject;
  /** 本步的 output */
  output: JsonValue | undefined;
}

/**
 * Guard 是**同步纯函数** —— 因为定义里只能写名字，不能写表达式语言。
 * 一旦允许 async / 副作用，transition 就不再可预测了。
 */
export type Guard = (context: GuardContext) => boolean;

export interface GuardResolver {
  resolveGuard(name: GuardName): Guard;
}

/**
 * 存进 Registry 的 handler 统一形态。
 *
 * `TConfig` 取 `JsonObject | undefined`（definition 里 config 的类型），
 * `TOutput` 取 `unknown` —— 作者侧仍然可以写更精确的泛型，方法参数是双变的，能直接注册。
 * 运行时把 config 交给 handler 前会自己校验（Phase A）。
 */
export type AnyStepHandler = StepHandler<JsonObject | undefined, unknown>;

export interface RegistryOptions {
  /** 重名时怎么办。默认 throw —— 悄悄覆盖是排障噩梦。 */
  duplicate?: "throw" | "replace";
}

export class Registry implements GuardResolver {
  readonly #handlers = new Map<HandlerName, AnyStepHandler>();
  readonly #guards = new Map<GuardName, Guard>();
  readonly #duplicate: "throw" | "replace";

  constructor(options: RegistryOptions = {}) {
    this.#duplicate = options.duplicate ?? "throw";
  }

  register(name: HandlerName, handler: AnyStepHandler): this;
  register(handlers: Record<HandlerName, AnyStepHandler>): this;
  register(
    nameOrMap: HandlerName | Record<HandlerName, AnyStepHandler>,
    handler?: AnyStepHandler,
  ): this {
    if (typeof nameOrMap === "string") {
      if (handler === undefined) {
        throw new ValidationError(`register("${nameOrMap}") 缺少 handler`);
      }
      this.#setHandler(nameOrMap, handler);
      return this;
    }
    for (const [name, entry] of Object.entries(nameOrMap)) {
      this.#setHandler(name, entry);
    }
    return this;
  }

  guard(name: GuardName, guard: Guard): this;
  guard(guards: Record<GuardName, Guard>): this;
  guard(nameOrMap: GuardName | Record<GuardName, Guard>, guard?: Guard): this {
    if (typeof nameOrMap === "string") {
      if (guard === undefined) {
        throw new ValidationError(`guard("${nameOrMap}") 缺少实现`);
      }
      this.#setGuard(nameOrMap, guard);
      return this;
    }
    for (const [name, entry] of Object.entries(nameOrMap)) {
      this.#setGuard(name, entry);
    }
    return this;
  }

  resolve(name: HandlerName): AnyStepHandler {
    const handler = this.#handlers.get(name);
    if (handler === undefined) throw new HandlerNotFoundError(name);
    return handler;
  }

  resolveGuard(name: GuardName): Guard {
    const guard = this.#guards.get(name);
    if (guard === undefined) throw new GuardNotFoundError(name);
    return guard;
  }

  has(name: HandlerName): boolean {
    return this.#handlers.has(name);
  }

  hasGuard(name: GuardName): boolean {
    return this.#guards.has(name);
  }

  handlerNames(): HandlerName[] {
    return [...this.#handlers.keys()].sort();
  }

  guardNames(): GuardName[] {
    return [...this.#guards.keys()].sort();
  }

  #setHandler(name: HandlerName, handler: AnyStepHandler): void {
    if (this.#handlers.has(name) && this.#duplicate === "throw") {
      throw new DuplicateRegistrationError("handler", name);
    }
    this.#handlers.set(name, handler);
  }

  #setGuard(name: GuardName, guard: Guard): void {
    if (this.#guards.has(name) && this.#duplicate === "throw") {
      throw new DuplicateRegistrationError("guard", name);
    }
    this.#guards.set(name, guard);
  }
}

export function createRegistry(options: RegistryOptions = {}): Registry {
  return new Registry(options);
}

/**
 * 保留 handler 名 —— 由 Runtime 自己实现，不是业务 handler。
 * 名字带 `workflow.` 前缀，一眼能看出是引擎能力。
 */
export const RESERVED_HANDLERS = {
  /** Phase D：`{ duration: "2d" }` → 挂起到 wake_at，不占进程 */
  delay: "workflow.delay",
  /** 显式终点（step 没有 next 时也等价于终点） */
  complete: "workflow.complete",
} as const;

export const RESERVED_HANDLER_NAMES: readonly string[] = Object.values(RESERVED_HANDLERS);

export function isReservedHandler(name: HandlerName): boolean {
  return RESERVED_HANDLER_NAMES.includes(name);
}

/** 只做“有没有注册”的查询，不要求完整 Registry（便于测试与扩展包实现） */
export interface HandlerLookup {
  has(name: HandlerName): boolean;
}

export interface GuardLookup {
  hasGuard(name: GuardName): boolean;
}

export interface RegistryCoverage {
  missingHandlers: HandlerName[];
  missingGuards: GuardName[];
}

/**
 * definition 里引用的 handler / guard 是不是都注册了。
 *
 * 这是 publish 与 start 的卡点：宁可启动时炸，也不要跑到一半才发现某个 step 没人实现。
 */
export function checkRegistryCoverage(
  definition: WorkflowDefinition,
  lookup: HandlerLookup & GuardLookup,
): RegistryCoverage {
  const missingHandlers = new Set<HandlerName>();
  const missingGuards = new Set<GuardName>();

  for (const step of Object.values(definition.steps)) {
    if (!lookup.has(step.uses)) missingHandlers.add(step.uses);
    for (const transition of step.next) {
      if (transition.when !== undefined && !lookup.hasGuard(transition.when)) {
        missingGuards.add(transition.when);
      }
    }
  }

  return {
    missingHandlers: [...missingHandlers].sort(),
    missingGuards: [...missingGuards].sort(),
  };
}

/** @throws ValidationError 有任何一个 handler / guard 没注册 */
export function assertRegistryCoverage(
  definition: WorkflowDefinition,
  lookup: HandlerLookup & GuardLookup,
): void {
  const { missingHandlers, missingGuards } = checkRegistryCoverage(definition, lookup);
  if (missingHandlers.length === 0 && missingGuards.length === 0) return;

  const parts: string[] = [];
  if (missingHandlers.length > 0) parts.push(`handler: ${missingHandlers.join(", ")}`);
  if (missingGuards.length > 0) parts.push(`guard: ${missingGuards.join(", ")}`);

  throw new ValidationError(`workflow "${definition.id}" v${definition.version} 缺少注册：${parts.join("；")}`, {
    details: { workflowId: definition.id, version: definition.version, missingHandlers, missingGuards },
  });
}
