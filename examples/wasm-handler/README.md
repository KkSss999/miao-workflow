# examples/wasm-handler

**第三方接入 mwf 的方式**：在**你自己的仓库**里编译一个 wasm 模块，把文件丢过来注册一下。
不需要改 mwf 一行代码，也不需要把业务逻辑塞进我们的仓库。

> 为什么这里不是「包一层某个具体业务系统」的示例：那种 dogfood 路线已经取消。
> 「外人怎么接进来」这个问题由 wasm 扩展回答（Phase F）。

## 模块要导出什么

完整规范见 [`docs/wasm-abi.md`](../../docs/wasm-abi.md)。最小要求是四个导出：

| 导出 | 作用 |
|---|---|
| `memory` | 宿主读写 JSON 的地方 |
| `mwf_abi_version` | 必须返回 `1`，否则拒绝加载 |
| `mwf_alloc` | 给宿主一段可写内存 |
| `mwf_execute(reqPtr, reqLen)` | 干活，返回**长度前缀**的 JSON 响应 |

响应就三种形态，和 TS handler 完全一样：

```jsonc
{ "status": "completed", "output": { }, "patch": { } }
{ "status": "waiting", "waitFor": "approval" }
{ "status": "failed", "error": { "code": "STEP_FAILED", "retryable": true } }
```

## 注册（worker 线程执行）

```ts
import { Registry } from "@catease/workflow";
import { registerWasmHandlers } from "@catease/workflow/wasm";
import { readFile } from "node:fs/promises";

const registry = new Registry();
registerWasmHandlers(
  registry,
  { "text.extract": await readFile("./extract.wasm") },
  // 第三方模块一律用 worker：超时（含 step.timeoutMs）= terminate 掉线程。
  // inline 模式更快，但同步 wasm 里的死循环会焊死整个事件循环。
  { execution: "worker", timeoutMs: 1_000 },
);
```

然后在 definition 里当一个普通 handler 用：

```ts
steps: {
  extract: { uses: "text.extract", config: { currency: "CNY" }, next: "review" },
}
```

## 本地验证用的示例模块

`echo.wasm`（302 字节）是一个**手搓的**最小模块：它把收到的请求原样嵌进响应里，
所以你可以一眼看出「宿主到底给了模块什么」。

```
{"status":"completed","output":{"echo": <你收到的完整请求> }}
```

它的字节由 `tests/support/wasm-fixtures.ts` 里的极小 wasm 编码器生成
（机器上没有可用的 wasm 工具链）—— 用 `tests/wasm-example.test.ts` 里的方式重新生成：

```bash
pnpm exec vitest run tests/wasm-example.test.ts   # 会断言磁盘上的文件与编码器输出一致
```

真实模块应该做**纯计算**并返回 `patch`（提取 / 校验 / 规则判定 / 模板渲染 / 格式转换）。
写 IO 的 handler 请留在 TS 侧 —— 沙箱里没有 `fetch` / `fs` / 时钟，
要给能力必须由宿主显式白名单化地传 import。

## Rust / C 侧的骨架

```rust
// 编译成 cdylib + wasm32 目标，并只导出下面几个符号
#[no_mangle] pub extern "C" fn mwf_abi_version() -> i32 { 1 }

#[no_mangle] pub extern "C" fn mwf_alloc(size: i32) -> *mut u8 { /* 你的分配器 */ }

#[no_mangle] pub extern "C" fn mwf_execute(req: *const u8, len: i32) -> *mut u8 {
    let request = unsafe { std::slice::from_raw_parts(req, len as usize) };
    let _ = request; // 解析 JSON → 干活 → 返回 [u32 长度][JSON] 的缓冲区
    /* ... */
}
```

要点：**不要**假设自己有 IO；返回的缓冲区前 4 字节必须是响应 JSON 的小端长度。
