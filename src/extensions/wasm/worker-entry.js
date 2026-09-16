/**
 * WASM 执行 worker —— 跑在独立线程里，所以可以被 `terminate()`。
 *
 * 这个文件是**纯 JS**（不是 TS），原因很实在：
 * - worker 由 `new Worker(new URL("./worker-entry.js", import.meta.url))` 启动，
 *   src 模式（vitest）与 dist 模式解析到的是同一个相对路径，两边都能直接跑；
 *   如果写成 .ts，Node 的类型剥离不会把 `./x.js` 重映射回 `./x.ts`，worker 就起不来
 * - 它只依赖 `node:worker_threads` 和 WebAssembly，不需要宿主那边的任何代码
 *
 * 协议（结构化克隆传对象）：
 *   宿主 → worker   { type: "load", bytes, maxResponseBytes }
 *   宿主 → worker   { type: "invoke", id, request }
 *   宿主 → worker   { type: "close" }
 *   worker → 宿主   { type: "ready" } | { type: "result", id, text } | { type: "error", id, error }
 *
 * 注意：worker 只把响应**文本**回传，JSON 解析与语义校验统一由宿主侧的
 * `decodeResponse` 负责 —— 校验只有一处，不两边各写一份。
 */

import { parentPort } from "node:worker_threads";

if (parentPort === null) {
  throw new Error("mwf: worker-entry.js 必须由 WasmWorkerHost 启动");
}

const port = parentPort;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

let exportsRef = null;
let memory = null;
let maxResponseBytes = 8 * 1024 * 1024;

port.on("message", (message) => {
  const id = message.id;

  try {
    switch (message.type) {
      case "load":
        load(message);
        port.postMessage({ type: "ready", id });
        return;

      case "invoke":
        port.postMessage({ type: "result", id, text: invoke(message.request) });
        return;

      case "close":
        process.exit(0);
        return;

      default:
        throw fail("wasm.abi", `未知消息类型：${String(message.type)}`);
    }
  } catch (error) {
    port.postMessage({ type: "error", id, error: describe(error) });
  }
});

function load(message) {
  maxResponseBytes = message.maxResponseBytes ?? maxResponseBytes;

  let compiled;
  try {
    compiled = new WebAssembly.Module(message.bytes);
  } catch (error) {
    throw fail("wasm.abi", `不是合法的 wasm 二进制：${errorMessage(error)}`);
  }

  let instance;
  try {
    instance = new WebAssembly.Instance(compiled, {});
  } catch (error) {
    throw fail("wasm.imports", `实例化失败（宿主默认不提供任何 import）：${errorMessage(error)}`);
  }

  const exports = instance.exports;
  memory = exports.memory;
  if (memory === undefined || memory === null || !(memory.buffer instanceof ArrayBuffer)) {
    throw fail("wasm.abi", "必须导出 memory");
  }
  if (typeof exports.mwf_abi_version !== "function") {
    throw fail("wasm.abi", "缺少导出 mwf_abi_version()");
  }
  const version = exports.mwf_abi_version();
  if (version !== 1) {
    throw fail("wasm.abi", `ABI 版本是 ${version}，宿主支持 1`);
  }
  for (const name of ["mwf_alloc", "mwf_execute"]) {
    if (typeof exports[name] !== "function") {
      throw fail("wasm.abi", `缺少导出 ${name}()`);
    }
  }

  exportsRef = exports;
}

function invoke(request) {
  if (exportsRef === null) throw fail("wasm.abi", "模块还没 load");

  const exports = exportsRef;
  if (typeof exports.mwf_reset === "function") exports.mwf_reset();

  const payload = encoder.encode(JSON.stringify(request));
  const requestPtr = exports.mwf_alloc(payload.byteLength);
  assertRange(requestPtr, payload.byteLength, "mwf_alloc");

  new Uint8Array(memory.buffer, requestPtr, payload.byteLength).set(payload);

  let responsePtr;
  try {
    responsePtr = exports.mwf_execute(requestPtr, payload.byteLength);
  } catch (error) {
    throw fail("wasm.trap", `执行时 trap：${errorMessage(error)}`);
  } finally {
    if (typeof exports.mwf_free === "function") exports.mwf_free(requestPtr, payload.byteLength);
  }

  assertRange(responsePtr, 4, "mwf_execute 返回的指针");

  // 模块可能在 execute 期间 grow 了 memory，所以长度和内容都要在 grow 之后重新读
  const view = new DataView(memory.buffer);
  const length = view.getUint32(responsePtr, true);
  if (length > maxResponseBytes) {
    throw fail("wasm.bounds", `响应声称有 ${length} 字节，超过上限 ${maxResponseBytes}`);
  }
  assertRange(responsePtr + 4, length, "响应内容");

  const bytes = new Uint8Array(memory.buffer, responsePtr + 4, length);

  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw fail("wasm.response", `响应不是合法 UTF-8：${errorMessage(error)}`);
  }
}

function assertRange(ptr, size, what) {
  const total = memory.buffer.byteLength;
  if (!Number.isInteger(ptr) || ptr < 0 || ptr + size > total) {
    throw fail("wasm.bounds", `${what} 越界：ptr=${ptr} size=${size} memory=${total}`);
  }
}

/** 给抛出的错误打上 kind，宿主据此映射成 WasmHostError */
function fail(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function describe(error) {
  return {
    kind: typeof error?.kind === "string" ? error.kind : "wasm.response",
    name: typeof error?.name === "string" ? error.name : "Error",
    message: errorMessage(error),
  };
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
