export interface SchedulerOptions {
  /** 每轮干什么。抛异常不会停掉调度器。 */
  onTick: () => Promise<void>;
  /** 基础轮询间隔 */
  intervalMs?: number;
  /** 每轮加 0..jitterMs 随机延迟，避免多 worker 踩同一个节拍 */
  jitterMs?: number;
  onError?: (error: unknown) => void;
}

export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_POLL_JITTER_MS = 250;

/**
 * 轮询调度器 —— 故意做得非常笨。
 *
 * 不做分布式 scheduler、不做 leader election：每个 worker 自己轮询数据库，
 * 靠 `FOR UPDATE SKIP LOCKED` 天然分活。少一个组件，少一类故障。
 *
 * 用 setTimeout 链而不是 setInterval：保证上一轮没跑完就不会叠加下一轮。
 */
export class Scheduler {
  readonly intervalMs: number;
  readonly jitterMs: number;
  readonly #onTick: () => Promise<void>;
  readonly #onError: (error: unknown) => void;

  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(options: SchedulerOptions) {
    this.#onTick = options.onTick;
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.jitterMs = options.jitterMs ?? DEFAULT_POLL_JITTER_MS;
    this.#onError =
      options.onError ??
      ((error: unknown) => {
        console.error("[mwf] scheduler tick failed", error);
      });
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#schedule(0);
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** 跑一轮。测试可以直接调它，不用等定时器。 */
  async tick(): Promise<void> {
    try {
      await this.#onTick();
    } catch (error) {
      this.#onError(error);
    }
  }

  #schedule(delayMs: number): void {
    if (!this.#running) return;
    const timer = setTimeout(() => {
      void this.tick().finally(() => {
        this.#schedule(this.intervalMs + Math.random() * this.jitterMs);
      });
    }, delayMs);
    // 不因为这个定时器而吊住进程
    timer.unref?.();
    this.#timer = timer;
  }
}
