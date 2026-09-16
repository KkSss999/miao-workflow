import { MemoryWorkflowStorage, Registry, WorkflowEngine, WorkflowWorker } from "../../src/index.js";
import type { StepHandler, StepResult, WorkflowStorage } from "../../src/index.js";

/**
 * 测试夹具：可注入的时钟 + 确定性 id + 一个 worker。
 *
 * 所有测试都不 sleep（除了专门测心跳的那个），因为时钟是注入的 —— 时间在测试里是可推进的。
 */

export const HARNESS_START = Date.parse("2026-01-01T00:00:00.000Z");

export interface HarnessOptions {
  storage?: WorkflowStorage;
  maxStepsPerTick?: number;
  owner?: string;
  leaseMs?: number;
  leaseRenewIntervalMs?: number;
  concurrency?: number;
}

export interface Harness {
  storage: WorkflowStorage;
  registry: Registry;
  engine: WorkflowEngine;
  worker: WorkflowWorker;
  /** 记录 handler 被调用的顺序（`stepId` 或自定义字符串） */
  calls: string[];
  now: () => Date;
  nowIso: () => string;
  advance: (ms: number) => void;
  newId: () => string;
  /** 造一个写进 calls 的 handler */
  tracked: (stepId: string, patch?: Record<string, never> | object) => StepHandler;
  /** 造一个返回 completed 的 handler */
  noop: () => StepHandler;
}

/**
 * 每个 harness 给自己的 id 加个前缀。
 *
 * 为什么需要：多个 harness 可能共享同一个 storage（模拟重启 / 多个 worker），
 * 各自的顺序 id 会从 1 开始 —— 直接撞车。生产里 newId 是 UUID，天然全局唯一。
 */
let harnessSeq = 0;

export function createHarness(options: HarnessOptions = {}): Harness {
  let current = new Date(HARNESS_START);
  let seq = 0;
  const tag = `h${++harnessSeq}`;
  const newId = (): string => `${tag}-id-${++seq}`;
  const now = (): Date => current;

  const storage = options.storage ?? new MemoryWorkflowStorage({ now, newId });
  const registry = new Registry();
  const engine = new WorkflowEngine({
    storage,
    registry,
    now,
    newId,
    random: () => 0.5,
    ...(options.maxStepsPerTick === undefined ? {} : { limits: { maxStepsPerTick: options.maxStepsPerTick } }),
  });

  const worker = new WorkflowWorker({
    engine,
    owner: options.owner ?? "worker-1",
    concurrency: options.concurrency ?? 4,
    leaseMs: options.leaseMs ?? 60_000,
    leaseRenewIntervalMs: options.leaseRenewIntervalMs ?? 20,
    pollIntervalMs: 5,
    pollJitterMs: 0,
    onError: () => undefined,
  });

  const calls: string[] = [];

  const advance = (ms: number): void => {
    current = new Date(current.getTime() + ms);
  };

  return {
    storage,
    registry,
    engine,
    worker,
    calls,
    now,
    nowIso: () => current.toISOString(),
    advance,
    newId,
    tracked(stepId: string, patch?: object): StepHandler {
      return {
        async execute(): Promise<StepResult> {
          calls.push(stepId);
          return patch === undefined
            ? { status: "completed", output: { from: stepId } }
            : { status: "completed", output: { from: stepId }, patch: patch as Record<string, never> };
        },
      };
    },
    noop(): StepHandler {
      return {
        async execute(): Promise<StepResult> {
          return { status: "completed" };
        },
      };
    },
  };
}

/** 造一个「等信号」的 handler：被叫醒后返回 payload。 */
export function waiter(waitFor: string): StepHandler {
  return {
    async execute(context): Promise<StepResult> {
      if (context.resume === undefined) return { status: "waiting", waitFor };
      return {
        status: "completed",
        output: context.resume.payload ?? null,
        patch: { approved: true },
      };
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
