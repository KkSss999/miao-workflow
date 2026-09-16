import type { WorkflowRun } from "../runtime/run.js";
import type { RunStore } from "../storage/interface.js";

/** 默认租期。超过这个时间没续租，别的 worker 可以接手（crash recovery 靠的就是它）。 */
export const DEFAULT_LEASE_MS = 30_000;

/** 心跳间隔必须显著小于租期，否则会自己把自己判成过期。 */
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = 10_000;

/** 连续失败多少次就认为「lease 保不住了」。默认 3 次。 */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export interface HeartbeatOptions {
  /** lease 确认丢了（续租返回 false，或连续失败到阈值） */
  onLost?: () => void;
  /** 续租过程中的异常，用于上报/打日志 */
  onError?: (error: unknown) => void;
  maxConsecutiveFailures?: number;
}

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
   *
   * @returns stop 函数（务必在 finally 里调用）
   *
   * 续租失败（数据库抖动、连接池耗尽）**必须被吞掉并上报**：
   * 这里是 `setInterval` 回调，一旦漏出 rejection，Node 默认的
   * `--unhandled-rejections=throw` 会直接把整个 worker 进程干掉 ——
   * 而心跳存在的意义恰恰是「数据库不重要，反正会恢复」。
   */
  startHeartbeat(runId: string, options: HeartbeatOptions = {}): () => void {
    const { onLost, onError, maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES } = options;
    let failures = 0;

    const timer = setInterval(() => {
      void this.renew(runId).then(
        (renewed) => {
          failures = 0;
          if (!renewed) {
            onLost?.();
            stop();
          }
        },
        (error: unknown) => {
          failures += 1;
          onError?.(error);
          if (failures >= maxConsecutiveFailures) {
            // 连续失败到阈值：我们已经无法证明 lease 还在自己手里，停手更安全
            onLost?.();
            stop();
          }
        },
      );
    }, this.renewIntervalMs);
    timer.unref?.();

    const stop = (): void => {
      clearInterval(timer);
    };
    return stop;
  }
}
