import { Worker } from "node:worker_threads";

import { DEFAULT_MAX_RESPONSE_BYTES, decodeResponse, type WasmStepRequest, type WasmStepResponse } from "./abi.js";
import { WasmHostError, type WasmHostErrorKind } from "./errors.js";
import type { WasmStepInvoker } from "./invoker.js";
import type { WasmModuleOptions, WasmSource } from "./instance.js";
import { toModuleBytes } from "./runtime.js";

export interface WasmWorkerHostOptions extends WasmModuleOptions {
  /**
   * 单次调用的硬时限：超了就 **terminate worker**（不是审计，是真掐断）。
   *
   * 不传也行 —— `StepRunner` 的 `step.timeoutMs` 会通过 AbortSignal 传进来，
   * 那时同样走 terminate。
   */
  timeoutMs?: number;
  /** 覆盖 worker 入口路径（默认取本文件旁边的 worker-entry.js） */
  workerPath?: URL | string;
}

interface PendingCall {
  resolve: (text: string) => void;
  reject: (error: unknown) => void;
}

/**
 * 把 wasm 模块放在**独立线程**里执行。
 *
 * 这补上了同线程模式唯一的硬伤：同步 wasm 无法被中断。
 * 在这里，超时 = `worker.terminate()`，死循环模块拿它没办法；
 * 掐掉之后下一次调用会自动起一个干净的 worker（模块状态本来就不该有）。
 *
 * 代价（写在明处）：
 * - 每次调用多一次结构化克隆 + 一次线程切换（纯计算场景可忽略）
 * - 同一个 host 的调用是**串行**的（一个 worker 一次只跑一个调用）；
 *   要并行就多建几个 host
 */
export class WasmWorkerHost implements WasmStepInvoker {
  readonly name: string;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number | undefined;

  readonly #bytes: Uint8Array;
  readonly #workerPath: URL | string;
  readonly #maxDurationMs: number | undefined;

  #worker: Worker | null = null;
  #starting: Promise<void> | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #nextId = 1;
  #disposed = false;
  readonly #pending = new Map<number, PendingCall>();

  constructor(source: WasmSource, options: WasmWorkerHostOptions = {}) {
    this.name = options.name ?? "wasm-step";
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.timeoutMs = options.timeoutMs;
    this.#maxDurationMs = options.maxDurationMs;
    this.#workerPath = options.workerPath ?? new URL("./worker-entry.js", import.meta.url);

    const bytes = toModuleBytes(source);
    if (bytes === null) {
      throw new WasmHostError(
        "worker 执行模式需要模块字节 —— 已编译的 WebAssembly.Module 跨不了线程",
        { kind: "wasm.abi", moduleName: this.name },
      );
    }
    // 复制一份：worker 是独立 realm，字节要跟着过去
    this.#bytes = bytes.slice();
  }

  /** 调用是串行的：同一个 worker 不会同时跑两个模块调用。 */
  invoke(request: WasmStepRequest, signal?: AbortSignal): Promise<WasmStepResponse> {
    const run = this.#chain.then(
      () => this.#invokeOnce(request, signal),
      () => this.#invokeOnce(request, signal),
    );
    // 让失败的调用不污染后续调用
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    // 竞态：dispose 时可能有一个 #start 正在飞 —— 等它落定再 kill，
    // 否则它会在线程已经被判死刑之后把 #worker 重新赋值，等于漏一个线程出来。
    const starting = this.#starting;
    if (starting !== null) await starting.catch(() => undefined);
    await this.#kill(
      new WasmHostError(`wasm worker "${this.name}" 已释放`, { kind: "wasm.trap", moduleName: this.name }),
    );
  }

  async #invokeOnce(request: WasmStepRequest, signal?: AbortSignal): Promise<WasmStepResponse> {
    if (this.#disposed) {
      throw new WasmHostError(`wasm worker "${this.name}" 已释放`, { kind: "wasm.trap", moduleName: this.name });
    }

    const budget = this.#budget();
    if (signal?.aborted === true) {
      throw timeoutError(this.name, budget, "调用前就已经被中止");
    }

    const worker = await this.#ensureWorker();
    worker.ref(); // 有在途调用时别让进程提前退出
    const id = this.#nextId++;

    return new Promise<WasmStepResponse>((resolve, reject) => {
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
        worker.unref();
        fn();
      };

      const abortWith = (why: string): void => {
        const error = timeoutError(this.name, budget, why);
        void this.#kill(error).catch(() => undefined);
        finish(() => reject(error));
      };

      const onAbort = (): void => {
        // 关键路径：真掐断，而不是等它自己跑完
        abortWith("收到中止信号");
      };

      const timer =
        budget === undefined
          ? null
          : setTimeout(() => {
              abortWith(`超过 ${budget}ms`);
            }, budget);

      signal?.addEventListener("abort", onAbort, { once: true });

      this.#pending.set(id, {
        resolve: (text) =>
          finish(() => {
            try {
              // 语义校验统一由宿主负责 —— worker 只回传文本
              resolve(decodeResponse(new TextEncoder().encode(text), this.name));
            } catch (error) {
              reject(error);
            }
          }),
        reject: (error) => finish(() => reject(error)),
      });

      worker.postMessage({ type: "invoke", id, request });
    });
  }

  #budget(): number | undefined {
    const budgets = [this.timeoutMs, this.#maxDurationMs].filter(
      (value): value is number => value !== undefined && value > 0,
    );
    return budgets.length === 0 ? undefined : Math.min(...budgets);
  }

  async #ensureWorker(): Promise<Worker> {
    if (this.#worker !== null) return this.#worker;
    if (this.#disposed) {
      throw new WasmHostError(`wasm worker "${this.name}" 已释放`, { kind: "wasm.trap", moduleName: this.name });
    }
    if (this.#starting === null) {
      this.#starting = this.#start().finally(() => {
        this.#starting = null;
      });
    }
    await this.#starting;

    const worker = this.#worker;
    if (worker === null) {
      throw new WasmHostError(`wasm worker "${this.name}" 启动失败`, {
        kind: "wasm.abi",
        moduleName: this.name,
      });
    }
    return worker;
  }

  async #start(): Promise<void> {
    const worker = new Worker(this.#workerPath);
    // 空闲时不吊住进程；有在途调用时 #invokeOnce 会 ref() 回来
    worker.unref();

    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "ready") return;

      const id = typeof message.id === "number" ? message.id : undefined;
      const pending = id === undefined ? undefined : this.#pending.get(id);
      if (pending === undefined) return;

      if (message.type === "result" && typeof message.text === "string") {
        pending.resolve(message.text);
        return;
      }
      pending.reject(workerError(this.name, message.error));
    });

    worker.on("error", (error: Error) => {
      this.#failAll(workerFailure(this.name, error));
    });

    worker.on("exit", (code: number) => {
      // 主动 terminate 时也会走到这里
      this.#worker = null;
      this.#failAll(
        new WasmHostError(`wasm worker "${this.name}" 退出（code ${code}）`, {
          kind: "wasm.trap",
          moduleName: this.name,
        }),
      );
    });

    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        worker.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        worker.off("message", onReady);
        reject(workerFailure(this.name, error));
      };

      worker.once("message", onReady);
      worker.once("error", onError);

      worker.postMessage({ type: "load", bytes: this.#bytes, maxResponseBytes: this.maxResponseBytes });
    });

    this.#worker = worker;
  }

  /** 掐断当前 worker：在途调用立刻失败，下一次调用自动重起一个干净的 */
  async #kill(reason: unknown): Promise<void> {
    const worker = this.#worker;
    this.#worker = null;
    if (worker !== null) await worker.terminate();
    this.#failAll(reason);
  }

  #failAll(reason: unknown): void {
    for (const [, pending] of [...this.#pending]) pending.reject(reason);
    this.#pending.clear();
  }
}

interface WorkerMessage {
  type?: string;
  id?: number;
  text?: string;
  error?: { kind?: string; name?: string; message?: string };
}

const ERROR_KINDS: readonly WasmHostErrorKind[] = [
  "wasm.abi",
  "wasm.imports",
  "wasm.bounds",
  "wasm.trap",
  "wasm.response",
  "wasm.overrun",
];

function workerError(moduleName: string, error: WorkerMessage["error"]): WasmHostError {
  const kind = ERROR_KINDS.find((candidate) => candidate === error?.kind) ?? "wasm.response";
  const message = error?.message ?? "worker 里执行失败";
  return new WasmHostError(`wasm 模块 "${moduleName}" 执行失败：${message}`, { kind, moduleName });
}

function workerFailure(moduleName: string, error: Error): WasmHostError {
  return new WasmHostError(`wasm worker "${moduleName}" 异常：${error.message}`, {
    kind: "wasm.trap",
    moduleName,
    cause: error,
  });
}

function timeoutError(moduleName: string, budget: number | undefined, why: string): WasmHostError {
  return new WasmHostError(
    budget === undefined
      ? `wasm 模块 "${moduleName}" 被中止（${why}）`
      : `wasm 模块 "${moduleName}" ${why}，已 terminate（budget=${budget}ms）`,
    { kind: "wasm.overrun", moduleName, code: "STEP_TIMEOUT" },
  );
}
