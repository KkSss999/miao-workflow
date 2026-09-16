import { hashDefinition } from "../definition/validation.js";
import { defineWorkflow, type WorkflowDefinition, type WorkflowDefinitionInput } from "../definition/workflow.js";
import type { JsonValue } from "../json.js";
import type { WorkflowRun } from "../runtime/run.js";
import type { WorkflowStorage } from "../storage/interface.js";
import { NotImplementedError, RunNotFoundError } from "./errors.js";
import { Registry, createRegistry } from "./registry.js";

export interface EngineLimits {
  /**
   * 一次 tick 最多推进多少个 step。
   *
   * 防的是 `A → B → A → B` 这种 bug 把 CPU 吃穿：撞到上限就重新排队，而不是死循环。
   */
  maxStepsPerTick: number;
}

export const DEFAULT_ENGINE_LIMITS: EngineLimits = {
  maxStepsPerTick: 32,
};

export interface WorkflowEngineOptions {
  storage: WorkflowStorage;
  registry?: Registry;
  limits?: Partial<EngineLimits>;
}

export interface StartRunOptions {
  input?: JsonValue;
  /** 指定 run id（重放 / 迁移用）；默认由 storage 生成 */
  runId?: string;
}

/**
 * 引擎 = Definition + Storage + Registry。
 *
 * 它只做四件事：发布定义、起 run、推进 run、处理信号。
 * 不认识 Intake / Lead / Slack / Email，也不认识 OpenAI。
 */
export class WorkflowEngine {
  readonly storage: WorkflowStorage;
  readonly registry: Registry;
  readonly limits: EngineLimits;

  constructor(options: WorkflowEngineOptions) {
    this.storage = options.storage;
    this.registry = options.registry ?? createRegistry();
    this.limits = { ...DEFAULT_ENGINE_LIMITS, ...options.limits };
  }

  /**
   * 发布 definition。
   *
   * - 同 version + 同内容 → 幂等，什么都不发生
   * - 同 version + 改内容 → StorageConflictError，逼你升版本
   *
   * 已发布版本不可修改，是「老 run 永远能跑完」的前提。
   */
  async publish(input: WorkflowDefinitionInput | WorkflowDefinition): Promise<WorkflowDefinition> {
    const definition = defineWorkflow(input);
    await this.storage.definitions.save({
      definition,
      definitionHash: hashDefinition(definition),
    });
    return definition;
  }

  /**
   * 起一个 run。传 definition 对象会自动先 publish（幂等）。
   *
   * Phase A 实现。
   */
  async start(_workflow: string | WorkflowDefinition, _options: StartRunOptions = {}): Promise<WorkflowRun> {
    throw new NotImplementedError("WorkflowEngine.start（Phase A）");
  }

  async get(runId: string): Promise<WorkflowRun> {
    const run = await this.storage.runs.get(runId);
    if (run === null) throw new RunNotFoundError(runId);
    return run;
  }

  /**
   * 推进一个 run：claim → execute step → persist → transition → 继续，
   * 直到 WAITING / 终态 / 撞到 maxStepsPerTick。返回本次真正执行了多少 step。
   *
   * Phase A 实现。
   */
  async tick(_runId: string): Promise<number> {
    throw new NotImplementedError("WorkflowEngine.tick（Phase A）");
  }

  /**
   * 送到外部信号（人类审批、webhook 回调…）。
   * 先落库再 wake，所以进程崩了也不丢。
   *
   * Phase D 实现。
   */
  async signal(_runId: string, _name: string, _payload?: JsonValue): Promise<void> {
    throw new NotImplementedError("WorkflowEngine.signal（Phase D）");
  }

  /** Phase D 实现。 */
  async cancel(_runId: string): Promise<void> {
    throw new NotImplementedError("WorkflowEngine.cancel（Phase D）");
  }
}

/**
 * 使用方（Web 后端、CLI、触发器）只需要认识这个门面。
 *
 * ```ts
 * const client = new WorkflowClient(engine);
 * const run = await client.start("intake-to-action", { input: { intakeId: "INT-1024" } });
 * await client.signal(run.id, "approval", { decision: "approve" });
 * ```
 */
export class WorkflowClient {
  readonly engine: WorkflowEngine;

  constructor(engine: WorkflowEngine) {
    this.engine = engine;
  }

  async start(workflow: string | WorkflowDefinition, options: StartRunOptions = {}): Promise<WorkflowRun> {
    return this.engine.start(workflow, options);
  }

  async signal(runId: string, name: string, payload?: JsonValue): Promise<void> {
    return this.engine.signal(runId, name, payload);
  }

  async cancel(runId: string): Promise<void> {
    return this.engine.cancel(runId);
  }

  async get(runId: string): Promise<WorkflowRun> {
    return this.engine.get(runId);
  }
}
