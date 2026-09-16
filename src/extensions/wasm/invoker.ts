import type { WasmStepRequest, WasmStepResponse } from "./abi.js";

/**
 * 执行一个 wasm step 的东西 —— `WasmStepModule`（同线程）与 `WasmWorkerHost`（独立线程）
 * 都实现它。handler 只依赖这个接口，所以「换执行模式」不需要改上层。
 */
export interface WasmStepInvoker {
  readonly name: string;
  invoke(request: WasmStepRequest, signal?: AbortSignal): WasmStepResponse | Promise<WasmStepResponse>;
  /** 释放资源（worker 线程 / 实例）。可选。 */
  dispose?(): void | Promise<void>;
}
