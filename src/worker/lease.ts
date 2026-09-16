import type { WorkflowRun } from "../runtime/run.js";
import type { RunStore } from "../storage/interface.js";

/** 默认租期。超过这个时间没续租，别的 worker 可以接手（crash recovery 靠的就是它）。 */
export const DEFAULT_LEASE_MS = 30_000;

/** 心跳间隔必须显著小于租期，否则会自己把自己判成过期。 */
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = 10_000;

export interface LeaseManagerOptions {
  runs: RunStore;
  /** worker 标识，写进 lease_owner */
  owner: string;
  leaseMs?: number;
  renewIntervalMs?: number;
  now?: () => Date;
}

/**
 * Lease —— 没有 Redis 的情况下，怎么保证一个 run 同时只被一个 worker 推进？
 *
 * 答案：数据库行级锁 + lease 字段。
 *   claim:   FOR UPDATE SKIP LOCKED，抢到的立刻写 lease_owner / lease_expires_at
 *   renew:   心跳续租，证明「我还活着」
 *   release: 主动放手，让别的 worker 立刻能接手
 *   崩了不 release：租期一过别人自然接手 —— 这就是 crash recovery
 */
export class LeaseManager {
  readonly runs: RunStore;
  readonly owner: string;
  readonly leaseMs: number;
  readonly renewIntervalMs: number;
  readonly #now: () => Date;

  constructor(options: LeaseManagerOptions) {
    this.runs = options.runs;
    this.owner = options.owner;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.renewIntervalMs = options.renewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS;
    this.#now = options.now ?? (() => new Date());
  }

  /** 抢占最多 limit 个到期 run。抢不到就返回空数组，不是错误。 */
  async claim(limit: number): Promise<WorkflowRun[]> {
    return this.runs.claimDue({
      owner: this.owner,
      limit,
      leaseMs: this.leaseMs,
      now: this.#now().toISOString(),
    });
  }

  /** 返回 false = lease 已经不是自己的了，应当立刻停止推进这个 run。 */
  async renew(runId: string): Promise<boolean> {
    return this.runs.renewLease(runId, this.owner, this.leaseMs, this.#now().toISOString());
  }

  async release(runId: string): Promise<void> {
    return this.runs.releaseLease(runId, this.owner);
  }

  /**
   * 给一个正在处理的 run 挂心跳。
   * @returns stop 函数（务必在 finally 里调用）
   */
  startHeartbeat(runId: string, onLost?: () => void): () => void {
    const timer = setInterval(() => {
      void this.renew(runId).then((renewed) => {
        if (!renewed) {
          onLost?.();
          stop();
        }
      });
    }, this.renewIntervalMs);
    timer.unref?.();

    const stop = (): void => {
      clearInterval(timer);
    };
    return stop;
  }
}
