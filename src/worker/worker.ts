import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import type { WorkflowEngine } from "../core/engine.js";
import { LeaseLostError } from "../core/errors.js";
import { isTerminalRunStatus } from "../runtime/run.js";
import { DEFAULT_LEASE_MS, DEFAULT_LEASE_RENEW_INTERVAL_MS, LeaseManager } from "./lease.js";
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
  leaseRenewIntervalMs?: number;
  /** 覆盖时钟（默认跟随 engine 的时钟，测试里才需要） */
  now?: () => Date;
  onError?: (error: unknown, context: { runId?: string }) => void;
}

/** 一次 tick 的战果。 */
export interface WorkerTickResult {
  /** 抢到几个 run */
  claimed: number;
  /** 有几个「引擎没抛错地处理完」（**不等于成功**：handler 失败也算 handled） */
  handled: number;
  /** 有几个处理时抛错（已经被隔离，不影响别的 run） */
  failed: number;
  /** 经过这次 tick 之后落到终态（COMPLETED / FAILED / CANCELLED）的 run 数 */
  completed: number;
}

/**
 * Worker = 抢 lease → 推进 run → 放手。
 *
 * 它不拥有任何状态：进程可以随时被 `kill -9`，重启后 lease 过期，别的 worker 接着跑。
 *
 * ```ts
 * const worker = new WorkflowWorker({ engine, concurrency: 16 });
 * worker.start();
 * process.on("SIGTERM", async () => { worker.stop(); await worker.drain(); });
 * ```
 */
export class WorkflowWorker {
  readonly engine: WorkflowEngine;
  readonly owner: string;
  readonly concurrency: number;
  readonly maxStepsPerTick: number;
  readonly lease: LeaseManager;
  readonly scheduler: Scheduler;

  readonly #onError: (error: unknown, context: { runId?: string }) => void;
  readonly #inFlight = new Set<Promise<unknown>>();

  constructor(options: WorkflowWorkerOptions) {
    this.engine = options.engine;
    this.owner = options.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.concurrency = options.concurrency ?? 16;
    this.maxStepsPerTick = options.maxStepsPerTick ?? this.engine.limits.maxStepsPerTick;
    this.#onError =
      options.onError ??
      ((error, context) => {
        console.error(`[mwf] run ${context.runId ?? "-"} 处理失败`, error);
      });

    this.lease = new LeaseManager({
      runs: this.engine.storage.runs,
      owner: this.owner,
      leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
      renewIntervalMs: options.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS,
      // 和 engine 用同一个时钟 —— 否则测试里 lease 一造出来就是过期的
      now: options.now ?? this.engine.now,
    });

    this.scheduler = new Scheduler({
      onTick: async () => {
        await this.tick();
      },
      intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      jitterMs: options.pollJitterMs ?? DEFAULT_POLL_JITTER_MS,
      onError: (error) => this.#onError(error, {}),
    });
  }

  get running(): boolean {
    return this.scheduler.running;
  }

  start(): void {
    this.scheduler.start();
  }

  /** 停止轮询。已经在处理的 run 不会被掐断 —— 用 `drain()` 等它们跑完。 */
  stop(): void {
    this.scheduler.stop();
  }

  /** 等所有在途的 run 处理完（优雅退出用）。 */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  /**
   * 抢一批 run 并推进。
   *
   * 单个 run 出错不会影响同一批里别的 run（失败隔离），
   * 因为一个坏掉的 handler 不该把整个 worker 拖下水。
   */
  async tick(): Promise<WorkerTickResult> {
    const claimed = await this.lease.claim(this.concurrency);
    if (claimed.length === 0) return { claimed: 0, handled: 0, failed: 0, completed: 0 };

    const outcomes = await Promise.all(claimed.map((run) => this.#process(run.id)));
    return {
      claimed: claimed.length,
      handled: outcomes.filter((outcome) => outcome.outcome === "handled").length,
      failed: outcomes.filter((outcome) => outcome.outcome === "failed").length,
      completed: outcomes.filter((outcome) => outcome.completed).length,
    };
  }

  async #process(runId: string): Promise<{ outcome: "handled" | "failed"; completed: boolean }> {
    // 心跳：handler 可能跑很久（也可能卡住），不能让 lease 在中途过期
    const stopHeartbeat = this.lease.startHeartbeat(runId, {
      onLost: () => this.#onError(new LeaseLostError(runId), { runId }),
      // 续租报错本身不是致命错误（数据库抖一下很正常），但必须被看见
      onError: (error) => this.#onError(error, { runId }),
    });

    const task = async (): Promise<{ outcome: "handled" | "failed"; completed: boolean }> => {
      try {
        const result = await this.engine.tick(runId, { owner: this.owner, leaseMs: this.lease.leaseMs });
        // status 是这次 tick 之后 run 的状态 —— 直接用它判断有没有终态，不用额外查库
        return { outcome: "handled", completed: isTerminalRunStatus(result.status) };
      } catch (error) {
        // 失败隔离：一个坏 handler 不该把整批 run 拖下水
        this.#onError(error, { runId });
        return { outcome: "failed", completed: false };
      } finally {
        stopHeartbeat();
        // 主动放手：下一轮（或别的 worker）能立刻接着推进
        await this.lease.release(runId).catch(() => undefined);
      }
    };

    const pending = task();
    this.#inFlight.add(pending);
    try {
      return await pending;
    } finally {
      this.#inFlight.delete(pending);
    }
  }
}
