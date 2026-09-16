/**
 * 手搓的 wasm 运行时接口 —— 故意**不引用全局 `WebAssembly` 类型**。
 *
 * 为什么：`WebAssembly` 的类型只存在于 TypeScript 的 `lib.dom` / `lib.webworker`，
 * 一个 Node 库如果写 `WebAssembly.Module`，消费者就必须给项目加上整个 DOM lib 才能编译。
 * 我们只声明真正用到的那几个形状，然后从 `globalThis` 取运行时对象 ——
 * 类型干净，也不会把 DOM 拖进别人的 tsconfig。
 */

export interface WasmMemoryLike {
  readonly buffer: ArrayBuffer;
  grow?(pages: number): number;
}

export interface WasmModuleLike {
  readonly __wasmModule?: true;
}

export interface WasmInstanceLike {
  readonly exports: Record<string, unknown>;
}

export type WasmImportsLike = Record<string, Record<string, unknown>>;

export interface WasmRuntimeLike {
  Module: new (bytes: Uint8Array) => WasmModuleLike;
  Instance: new (module: WasmModuleLike, imports?: WasmImportsLike) => WasmInstanceLike;
  Memory: new (descriptor?: { initial?: number; maximum?: number }) => WasmMemoryLike;
}

/** 可接受的模块来源：字节，或者已经编译好的模块 */
export type WasmSource = Uint8Array | ArrayBuffer | WasmModuleLike;

export class WasmRuntimeUnavailableError extends Error {
  constructor() {
    super("当前运行时没有 WebAssembly（Node 18+ 默认支持；浏览器/Worker 也都有）");
    this.name = "WasmRuntimeUnavailableError";
  }
}

export function wasmRuntime(): WasmRuntimeLike {
  const runtime = (globalThis as { WebAssembly?: Partial<WasmRuntimeLike> }).WebAssembly;
  if (runtime?.Module === undefined || runtime.Instance === undefined || runtime.Memory === undefined) {
    throw new WasmRuntimeUnavailableError();
  }
  return runtime as WasmRuntimeLike;
}

export function toModuleBytes(source: WasmSource): Uint8Array | null {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) {
    const view = source as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null; // 已经是编译好的模块
}
