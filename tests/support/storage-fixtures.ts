import { MemoryWorkflowStorage } from "../../src/storage/memory.js";
import type { WorkflowStorage } from "../../src/storage/interface.js";
import type {
  JsonValue,
  StepRun,
  WorkflowEvent,
  WorkflowRun,
  WorkflowSignal,
} from "../../src/index.js";

/**
 * Storage conformance —— 同一套断言跑 Memory 与 Postgres。
 *
 * 这不是「顺手多测一点」：MemoryWorkflowStorage 的 docstring 声称它的语义与 Postgres 一致，
 * 这个文件就是那句话的证明。任何一边偷偷改了语义，这里立刻会红。
 */

export const CONFORMANCE_START = Date.parse("2026-01-01T00:00:00.000Z");

export interface StorageHarness {
  /** 造一个（或返回共享的）storage */
  create: () => Promise<WorkflowStorage> | WorkflowStorage;
  /** 每个 case 之前清空数据（Postgres 用 TRUNCATE；Memory 每次都是新的） */
  reset?: () => Promise<void>;
}

export function createClock(): { now: () => Date; advance: (ms: number) => void; reset: () => void } {
  let current = new Date(CONFORMANCE_START);
  return {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    reset: () => {
      current = new Date(CONFORMANCE_START);
    },
  };
}

export function sequentialIds(prefix = "id"): () => string {
  let seq = 0;
  return () => `${prefix}-${++seq}`;
}

export function makeRun(id: string, at: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    workflowId: "test-workflow",
    workflowVersion: 1,
    status: "CREATED",
    input: undefined,
    context: {},
    currentStepId: null,
    currentStepRunId: null,
    wakeAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    ...overrides,
  };
}

export function makeStepRun(at: string, overrides: Partial<StepRun> = {}): StepRun {
  return {
    id: "sr-1",
    runId: "run-1",
    stepId: "a",
    status: "COMPLETED",
    attempt: 1,
    visit: 1,
    input: undefined,
    output: { ok: true },
    patch: { a: 1 },
    error: null,
    waitFor: null,
    idempotencyKey: "run-1:a:1",
    startedAt: at,
    finishedAt: at,
    wakeAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

export function makeSignal(at: string, overrides: Partial<WorkflowSignal> = {}): WorkflowSignal {
  return {
    id: "s-1",
    runId: "run-1",
    name: "approval",
    payload: { decision: "approve" } as JsonValue,
    createdAt: at,
    consumedAt: null,
    ...overrides,
  };
}

export function makeEvent(at: string, overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    id: "e-1",
    runId: "run-1",
    stepId: null,
    type: "workflow.started",
    payload: {},
    createdAt: at,
    ...overrides,
  };
}

/** memory 专用 harness：每个 case 一个新实例 */
export function memoryHarness(): StorageHarness {
  const create = (): WorkflowStorage => {
    const ids = sequentialIds("mem");
    return new MemoryWorkflowStorage({ newId: ids });
  };
  return { create };
}
