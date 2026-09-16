import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { NotImplementedError } from "../core/errors.js";
import type { WorkflowEngine } from "../core/engine.js";
import { DEFAULT_LEASE_MS, LeaseManager } from "./lease.js";
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_POLL_JITTER_MS, Scheduler } from "./scheduler.js";

export interface WorkflowWorkerOptions {
  engine: WorkflowEngine;
  /** 默认 `hostname:pid:random` */
  owner?: string;
  /** 同时推进多少个 run。每个 run 内部仍然是顺序执行。 */
  concurrency?: number;
  /** 覆盖 engine 的 maxStepsPerTick */
  maxStepsPerTick?: number;
  pollIntervalMs?: number;
  pollJitterMs?: number;
  leaseMs?: number;
  onError?: (error: unknown) => void;
}

/** 一次 tick 的战果。 */
export interface WorkerTickResult {
  claimed: number;
  processed: number;
  failed: number;
}

/**
 * Worker = 抢 lease → 推进 run → 放手。
 *
 * 它不拥有任何状态：进程随时可以被 kill -9，重启后 lease 过期，别的 worker 接着跑。
 *
 * ```ts
 * const worker = new WorkflowWorker({ engine });
 * await worker.start();
 * ```
 *
 * 骨架阶段：调度器可用，实际推进逻辑落在 Phase C。
 */
export class WorkflowWorker {
  readonly engine: WorkflowEngine;
  readonly owner: string;
  readonly concurrency: number;
  readonly maxStepsPerTick: number;
  readonly lease: LeaseManager;
  readonly scheduler: Scheduler;

  constructor(options: WorkflowWorkerOptions) {
    this.engine = options.engine;
    this.owner = options.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.concurrency = options.concurrency ?? 16;
    this.maxStepsPerTick = options.maxStepsPerTick ?? this.engine.limits.maxStepsPerTick;
    this.lease = new LeaseManager({
      runs: this.engine.storage.runs,
      owner: this.owner,
      leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    });
    this.scheduler = new Scheduler({
      onTick: async () => {
        await this.tick();
      },
      intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      jitterMs: options.pollJitterMs ?? DEFAULT_POLL_JITTER_MS,
      onError: options.onError,
    });
  }

  get running(): boolean {
    return this.scheduler.running;
  }

  start(): void {
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  /**
   * 抢一批 run 并推进。
   *
   * Phase C 实现：claim(concurrency) → 对每个 run 挂心跳 → engine.tick(runId) → release。
   */
  async tick(): Promise<WorkerTickResult> {
    throw new NotImplementedError("WorkflowWorker.tick（Phase C）");
  }
}
