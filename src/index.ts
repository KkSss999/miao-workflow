/**
 * @catease/workflow —— Embedded durable workflow runtime for TypeScript.
 *
 * 四层分工（不许串味）：
 *   1. Definition —— 下一步是什么（纯 JSON，可落库、可 diff、可版本化）
 *   2. Handler    —— 这一步怎么做（业务自己注册）
 *   3. Storage    —— 死了以后还记得做到哪（Memory / PostgreSQL）
 *   4. Worker     —— 它最终还会继续做（lease + 轮询，不需要 Redis）
 *
 * 极简使用：
 *
 * ```ts
 * import { WorkflowEngine, WorkflowClient, WorkflowWorker } from "@catease/workflow";
 * import { MemoryWorkflowStorage } from "@catease/workflow";
 *
 * const storage = new MemoryWorkflowStorage();
 * const engine = new WorkflowEngine({ storage });
 * engine.registry.register("email.send", emailHandler);
 * engine.registry.guard("confidence.low", ({ context }) => Number(context.confidence) < 0.75);
 *
 * const client = new WorkflowClient(engine);
 * const run = await client.start(workflow, { input: { intakeId: "INT-1024" } });
 * ```
 */

// ── JSON 基础类型 ────────────────────────────────────────────────
export type { JsonObject, JsonPrimitive, JsonValue } from "./json.js";
export { isJsonValue } from "./json.js";

// ── Definition 层 ───────────────────────────────────────────────
export { defineWorkflow } from "./definition/workflow.js";
export type { WorkflowDefinition, WorkflowDefinitionInput, WorkflowMeta } from "./definition/workflow.js";
export type {
  GuardName,
  HandlerName,
  RetryBackoff,
  RetryPolicy,
  StepDefinition,
  StepDefinitionInput,
  StepId,
  StepMeta,
  Transition,
  TransitionInput,
} from "./definition/step.js";
export {
  assertJsonSerializable,
  findUnreachableSteps,
  hashDefinition,
  normalizeDefinition,
  normalizeStepDefinition,
  normalizeTransitions,
  stableStringify,
  validateDefinition,
} from "./definition/validation.js";

// ── Core 层 ─────────────────────────────────────────────────────
export {
  DEFAULT_ENGINE_LIMITS,
  WorkflowClient,
  WorkflowEngine,
} from "./core/engine.js";
export type { EngineLimits, StartRunOptions, TickOptions, TickResult, WorkflowEngineOptions } from "./core/engine.js";

export {
  RESERVED_HANDLERS,
  RESERVED_HANDLER_NAMES,
  Registry,
  assertRegistryCoverage,
  checkRegistryCoverage,
  createRegistry,
  isReservedHandler,
} from "./core/registry.js";
export type {
  AnyStepHandler,
  Guard,
  GuardContext,
  GuardLookup,
  GuardResolver,
  HandlerLookup,
  RegistryCoverage,
  RegistryOptions,
} from "./core/registry.js";

export { StepRunner } from "./core/runner.js";
export type {
  StepExecutionContext,
  StepExecutionArgs,
  StepExecutionOutcome,
  StepHandler,
  StepResult,
  StepRunnerOptions,
} from "./core/runner.js";

export { resolveNextStep } from "./core/transitions.js";
export type { ResolveNextStepArgs } from "./core/transitions.js";

// ── 错误 ────────────────────────────────────────────────────────
export {
  DefinitionNotFoundError,
  DuplicateRegistrationError,
  GuardNotFoundError,
  HandlerNotFoundError,
  LeaseLostError,
  LimitExceededError,
  NoMatchingTransitionError,
  NotImplementedError,
  RunNotActiveError,
  RunNotFoundError,
  StepRunNotFoundError,
  StorageConflictError,
  UnknownOutcomeError,
  ValidationError,
  WorkflowError,
  deserializeError,
  isWorkflowError,
  serializeError,
  toWorkflowError,
} from "./core/errors.js";
export type {
  SerializedWorkflowError,
  WorkflowErrorCode,
  WorkflowErrorOptions,
} from "./core/errors.js";

// ── Runtime 记录与状态机 ────────────────────────────────────────
export {
  ACTIVE_RUN_STATUSES,
  CLAIMABLE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  WAITING_RUN_STATUSES,
  isActiveRunStatus,
  isClaimableRunStatus,
  isRunDue,
  isTerminalRunStatus,
} from "./runtime/run.js";
export type { IsoTimestamp, RunStatus, WorkflowRun, WorkflowRunPatch } from "./runtime/run.js";

export {
  TERMINAL_STEP_STATUSES,
  buildIdempotencyKey,
  isTerminalStepStatus,
  serializeStepError,
  stepRunError,
} from "./runtime/step-run.js";
export type { StepRun, StepRunPatch, StepStatus } from "./runtime/step-run.js";

export type { SignalInput, WorkflowSignal } from "./runtime/signal.js";
export type { WorkflowEvent, WorkflowEventType } from "./runtime/events.js";

export {
  DEFAULT_RETRY_POLICY,
  JITTER_RATIO,
  computeBackoffMs,
  normalizeRetryPolicy,
  shouldRetry,
} from "./runtime/retry.js";
export type { NormalizedRetryPolicy } from "./runtime/retry.js";

// ── Storage 适配器 ──────────────────────────────────────────────
export { MemoryWorkflowStorage } from "./storage/memory.js";
export type { MemoryStorageOptions } from "./storage/memory.js";
export { PostgresWorkflowStorage } from "./storage/postgres.js";
export type { PostgresStorageOptions, SqlClient, SqlQueryResult } from "./storage/postgres.js";
export type {
  ClaimOptions,
  DefinitionRecord,
  DefinitionStore,
  EventStore,
  RunStore,
  SignalStore,
  StepRunStore,
  WorkflowStorage,
} from "./storage/interface.js";

// ── Worker ─────────────────────────────────────────────────────
export { WorkflowWorker } from "./worker/worker.js";
export type { WorkerTickResult, WorkflowWorkerOptions } from "./worker/worker.js";
export { DEFAULT_LEASE_MS, DEFAULT_LEASE_RENEW_INTERVAL_MS, LeaseManager } from "./worker/lease.js";
export type { LeaseManagerOptions } from "./worker/lease.js";
export { DEFAULT_POLL_INTERVAL_MS, DEFAULT_POLL_JITTER_MS, Scheduler } from "./worker/scheduler.js";
export type { SchedulerOptions } from "./worker/scheduler.js";
