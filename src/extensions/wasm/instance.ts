import type { JsonObject } from "../../json.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  WASM_ABI_VERSION,
  buildWasmRequest,
  decodeResponse,
  encodeRequest,
  type WasmStepRequest,
  type WasmStepResponse,
} from "./abi.js";
import { WasmHostError } from "./errors.js";
import type { WasmStepInvoker } from "./invoker.js";
import {
  toModuleBytes,
  wasmRuntime,
  type WasmImportsLike,
  type WasmMemoryLike,
  type WasmModuleLike,
  type WasmSource,
} from "./runtime.js";

export interface WasmModuleOptions {
  /** 模块名，只用于错误信息与排障 */
  name?: string;
  /**
   * 显式允许的 import。
   *
   * 默认**什么都不给** —— 沙箱里没有 fetch、没有 fs、没有时钟。
   * 真要给能力就在这里白名单化地传进来（capability mediation）。
   */
  imports?: WasmImportsLike;
  maxResponseBytes?: number;
  /** 事后审计用：执行超过这个时长就标记失败（同步 wasm 无法被中断，见 docs/wasm-abi.md） */
  maxDurationMs?: number;
  /**
   * 模块线性内存的上限（字节）。超过就判定失败。
   *
   * 同步 wasm 里宿主**拦不住** `memory.grow`，所以这是事后检查 ——
   * 但它至少能把「模块偷偷长到几 GB」变成一个显式的失败，而不是 OOM。
   * 真要硬隔离，用 `execution: "worker"` 并给进程设内存上限。
   */
  maxMemoryBytes?: number;
}

/** 模块导出的形状（加载时校验，运行时直接用） */
interface RequiredExports {
  mwf_abi_version: () => number;
  mwf_alloc: (size: number) => number;
  mwf_free?: (ptr: number, size: number) => void;
  mwf_reset?: () => void;
  mwf_execute: (requestPtr: number, requestLen: number) => number;
}

/**
 * 一个已加载、已校验的 wasm step 模块。
 *
 * 它是**纯计算宿主**：只在内存里搬运 JSON，不提供任何 IO 能力。
 *
 * 注意 `invoke` 是同步的：模块里的死循环会阻塞事件循环，
 * `StepRunner` 的 Promise.race 超时救不了它。`maxDurationMs` 只做事后审计。
 */
export class WasmStepModule implements WasmStepInvoker {
  readonly module: WasmModuleLike;
  readonly name: string;
  readonly maxResponseBytes: number;
  readonly maxDurationMs: number | undefined;
  readonly maxMemoryBytes: number | undefined;

  readonly #exports: RequiredExports;
  readonly #memory: WasmMemoryLike;

  constructor(source: WasmSource, options: WasmModuleOptions = {}) {
    this.name = options.name ?? "wasm-step";
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.maxDurationMs = options.maxDurationMs;
    this.maxMemoryBytes = options.maxMemoryBytes;

    const runtime = wasmRuntime();
    const bytes = toModuleBytes(source);
    if (bytes !== null) {
      try {
        this.module = new runtime.Module(bytes);
      } catch (cause) {
        throw new WasmHostError(`wasm 模块 "${this.name}" 不是合法的 wasm 二进制`, {
          kind: "wasm.abi",
          moduleName: this.name,
          cause,
        });
      }
    } else {
      this.module = source as WasmModuleLike;
    }

    let instance: { exports: Record<string, unknown> };
    try {
      instance = new runtime.Instance(this.module, options.imports ?? {});
    } catch (cause) {
      // 缺 import 是最常见的加载失败 —— 给出明确指引，而不是原始 LinkError
      throw new WasmHostError(
        `wasm 模块 "${this.name}" 实例化失败（缺少依赖的 import？宿主默认什么都不提供）`,
        { kind: "wasm.imports", moduleName: this.name, cause },
      );
    }

    const exports = instance.exports;
    const memory = exports["memory"];
    if (!isMemory(memory)) {
      throw new WasmHostError(`wasm 模块 "${this.name}" 必须导出 memory`, {
        kind: "wasm.abi",
        moduleName: this.name,
      });
    }
    this.#memory = memory;

    const abiVersion = exports["mwf_abi_version"];
    if (typeof abiVersion !== "function") {
      throw new WasmHostError(`wasm 模块 "${this.name}" 缺少导出 mwf_abi_version()`, {
        kind: "wasm.abi",
        moduleName: this.name,
      });
    }
    const version = (abiVersion as () => number)();
    if (version !== WASM_ABI_VERSION) {
      throw new WasmHostError(
        `wasm 模块 "${this.name}" 的 ABI 版本是 ${version}，宿主支持 ${WASM_ABI_VERSION}`,
        { kind: "wasm.abi", moduleName: this.name },
      );
    }

    for (const required of ["mwf_alloc", "mwf_execute"] as const) {
      if (typeof exports[required] !== "function") {
        throw new WasmHostError(`wasm 模块 "${this.name}" 缺少导出 ${required}()`, {
          kind: "wasm.abi",
          moduleName: this.name,
        });
      }
    }

    this.#exports = exports as unknown as RequiredExports;
  }

  get memory(): WasmMemoryLike {
    return this.#memory;
  }

  /**
   * 执行一次。同步、纯计算；任何异常都会被包成 WasmHostError。
   *
   * `signal` 只会在**开始前**被检查（已经中止就不启动），执行过程中拦不住 ——
   * 同步 wasm 无法被中断。要能掐断就用 worker 执行模式（WasmWorkerHost）。
   */
  invoke(request: WasmStepRequest, signal?: AbortSignal): WasmStepResponse {
    if (signal?.aborted === true) {
      throw new WasmHostError(`wasm 模块 "${this.name}" 在调用前已被中止`, {
        kind: "wasm.overrun",
        moduleName: this.name,
        code: "STEP_TIMEOUT",
      });
    }

    const startedAt = Date.now();

    // 给模块一个复位的机会（bump allocator 不会自己回收）
    this.#exports.mwf_reset?.();

    const payload = encodeRequest(request);
    const requestPtr = this.#alloc(payload.byteLength);
    this.#write(requestPtr, payload);

    let responsePtr: number;
    try {
      responsePtr = this.#exports.mwf_execute(requestPtr, payload.byteLength);
    } catch (cause) {
      // trap（unreachable / 越界 / 栈溢出…）：重试毫无意义
      throw new WasmHostError(`wasm 模块 "${this.name}" 执行时 trap：${trapMessage(cause)}`, {
        kind: "wasm.trap",
        moduleName: this.name,
        cause,
      });
    } finally {
      this.#exports.mwf_free?.(requestPtr, payload.byteLength);
    }

    if (this.maxMemoryBytes !== undefined && this.#memory.buffer.byteLength > this.maxMemoryBytes) {
      throw new WasmHostError(
        `wasm 模块 "${this.name}" 把内存涨到了 ${this.#memory.buffer.byteLength} 字节，超过上限 ${this.maxMemoryBytes}`,
        { kind: "wasm.bounds", moduleName: this.name },
      );
    }

    const elapsed = Date.now() - startedAt;
    if (this.maxDurationMs !== undefined && elapsed > this.maxDurationMs) {
      throw new WasmHostError(
        `wasm 模块 "${this.name}" 执行了 ${elapsed}ms，超过 maxDurationMs=${this.maxDurationMs}ms`,
        { kind: "wasm.overrun", moduleName: this.name, code: "STEP_TIMEOUT" },
      );
    }

    return decodeResponse(this.#readLengthPrefixed(responsePtr), this.name);
  }

  /** 直接用 JSON 调用（测试与工具用）。 */
  invokeJson(request: JsonObject): WasmStepResponse {
    return this.invoke(request as unknown as WasmStepRequest);
  }

  /** 同线程模式没有需要释放的东西（内存随实例回收）。 */
  dispose(): void {
    // no-op
  }

  #alloc(size: number): number {
    if (!Number.isInteger(size) || size < 0) {
      throw new WasmHostError(`请求大小非法：${size}`, { kind: "wasm.bounds", moduleName: this.name });
    }
    const ptr = this.#exports.mwf_alloc(size);
    this.#assertRange(ptr, size, "mwf_alloc");
    return ptr;
  }

  #write(ptr: number, bytes: Uint8Array): void {
    // memory 可能在 alloc 期间增长过，每次都要重新拿 buffer
    new Uint8Array(this.#memory.buffer, ptr, bytes.byteLength).set(bytes);
  }

  #readLengthPrefixed(ptr: number): Uint8Array {
    this.#assertRange(ptr, 4, "mwf_execute 返回的指针");

    // 关键：模块可能在 execute 期间 grow 了 memory，旧 buffer 那时已经 detached，
    // 所以长度和内容都必须在 grow 之后重新读。
    const view = new DataView(this.#memory.buffer);
    const length = view.getUint32(ptr, true);

    if (length > this.maxResponseBytes) {
      throw new WasmHostError(
        `wasm 模块 "${this.name}" 声称响应有 ${length} 字节，超过上限 ${this.maxResponseBytes}`,
        { kind: "wasm.bounds", moduleName: this.name },
      );
    }
    this.#assertRange(ptr + 4, length, "响应内容");

    return new Uint8Array(this.#memory.buffer, ptr + 4, length).slice();
  }

  #assertRange(ptr: number, size: number, what: string): void {
    const total = this.#memory.buffer.byteLength;
    if (!Number.isInteger(ptr) || ptr < 0 || ptr + size > total) {
      throw new WasmHostError(
        `wasm 模块 "${this.name}" 的 ${what} 越界：ptr=${ptr} size=${size} memory=${total}`,
        { kind: "wasm.bounds", moduleName: this.name },
      );
    }
  }
}

export function loadWasmModule(source: WasmSource, options: WasmModuleOptions = {}): WasmStepModule {
  return new WasmStepModule(source, options);
}

function isMemory(value: unknown): value is WasmMemoryLike {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { buffer?: unknown }).buffer instanceof ArrayBuffer
  );
}

function trapMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export { buildWasmRequest };
export type { WasmSource };
