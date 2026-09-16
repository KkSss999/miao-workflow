/**
 * `@catease/workflow/wasm` —— WASM handler 宿主（Phase F）。
 *
 * 这是**扩展入口，不是 Core**：
 *
 * - Core 只认 `StepHandler`，wasm 只是它的一个实现 —— 所以「Core 不认识业务」这条规矩不用破
 * - `src/` 里除了这个目录，没有任何一行 import 它（`tests/boundary.test.ts` 盯着）
 * - 边界是 JSON in / JSON out，将来换执行模式（worker_threads / 远程宿主）不用改协议
 *
 * ```ts
 * import { Registry } from "@catease/workflow";
 * import { registerWasmHandlers } from "@catease/workflow/wasm";
 *
 * const registry = new Registry();
 * registerWasmHandlers(registry, {
 *   "text.extract": await readFile("./extract.wasm"),
 * });
 * ```
 *
 * ABI 规范：docs/wasm-abi.md
 */

export {
  DEFAULT_MAX_RESPONSE_BYTES,
  WASM_ABI_VERSION,
  WASM_ERROR_CODES,
  buildWasmRequest,
  decodeResponse,
  encodeRequest,
} from "./abi.js";
export type { WasmErrorCode, WasmStepErrorPayload, WasmStepRequest, WasmStepResponse } from "./abi.js";

export { WasmHostError } from "./errors.js";
export type { WasmHostErrorKind, WasmHostErrorOptions } from "./errors.js";

export { WasmStepModule, loadWasmModule } from "./instance.js";
export type { WasmModuleOptions } from "./instance.js";

export { WasmRuntimeUnavailableError, wasmRuntime } from "./runtime.js";
export type {
  WasmImportsLike,
  WasmInstanceLike,
  WasmMemoryLike,
  WasmModuleLike,
  WasmRuntimeLike,
  WasmSource,
} from "./runtime.js";

export { createWasmHandler, handlerFor, registerWasmHandlers } from "./handler.js";
export type { WasmHandlerOptions } from "./handler.js";
