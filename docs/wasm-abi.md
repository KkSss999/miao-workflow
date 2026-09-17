# WASM handler ABI v1

> Phase F：让第三方**打包一个 wasm 模块、注册一个名字**就接进来。

三条不妥协的边界：

1. **它是 extension，不是 Core。** Core 只认 `StepHandler`；wasm 宿主只是它的一个实现
   （`@catease/workflow/wasm`）。Core 里没有任何一行 import 它（有测试盯着）。
2. **IO 必须由宿主中介。** 模块自己拿不到 `fetch`、文件系统、时钟 ——
   ABI v1 **不提供任何 host function**，所以 v1 的 wasm handler 只能做纯计算
   （提取 / 校验 / 规则判定 / 模板渲染 / 格式转换）。将来要 IO 就加白名单化的 capability import。
3. **边界是 JSON in / JSON out。** 送进去和拿回来都是 JSON —— 这正是 Core 一直保持的形状，
   所以 ABI 落地不需要动 Core 一行。

## 模块要求

| 导出 | 签名 | 必需 | 说明 |
|---|---|---|---|
| `memory` | `WebAssembly.Memory` | ✅ | 宿主读写 JSON 的地方 |
| `mwf_abi_version` | `() -> i32` | ✅ | 必须返回 `1`，否则宿主拒绝加载 |
| `mwf_alloc` | `(size: i32) -> i32` | ✅ | 返回一段可写内存的指针 |
| `mwf_free` | `(ptr: i32, size: i32) -> ()` | 可选 | 宿主写完请求后调用 |
| `mwf_reset` | `() -> ()` | 可选 | **每次调用前**由宿主调用；模块可借此复位工作区，避免长时间运行泄漏 |
| `mwf_execute` | `(requestPtr: i32, requestLen: i32) -> i32` | ✅ | 返回**长度前缀**响应缓冲区的指针 |

### 返回值的形状：长度前缀

```
mwf_execute 返回 respPtr，内存里是：

  respPtr + 0 : u32 (小端)   = N     ← 响应 JSON 的字节数
  respPtr + 4 : N 字节 UTF-8 JSON
```

为什么是长度前缀而不是 NUL 结尾：JSON 里可以有 `\0`，用长度才是唯一无歧义的做法。

## 请求（宿主 → 模块）

```jsonc
{
  "abi": 1,
  "stepId": "extract",
  "runId": "8f0c…",
  "stepRunId": "1b7e…",
  "attempt": 1,              // 1-based：同一次 step run 的第几次尝试
  "visit": 1,                // 第几次进入这个 step（回边时 +1）
  "idempotencyKey": "8f0c…:extract:1",
  "input": { … },            // 上一步的 output（首步为 run.input），可能没有
  "context": { … },          // 累积的 context
  "config": { … },           // definition 里这一步的 config，可能没有
  "resume": { "waitFor": "approval", "payload": { … } }   // 只有被叫醒重新执行时才有
}
```

**没有 `AbortSignal`。** 跨不了边界，而且同步 wasm 也无法被中断 —— 见下面的「诚实说明」。

## 响应（模块 → 宿主）

就是 `StepResult` 的三种形状，错误变成数据：

```jsonc
{ "status": "completed", "output": { … }, "patch": { … } }
{ "status": "waiting", "waitFor": "approval", "wakeAt": "2026-01-03T00:00:00.000Z" }
{ "status": "failed", "error": { "code": "STEP_FAILED", "message": "…", "retryable": true, "details": { … } } }
```

错误码白名单：`STEP_FAILED` / `STEP_TIMEOUT` / `UNKNOWN_OUTCOME` / `VALIDATION_ERROR` /
`LIMIT_EXCEEDED` / `WORKFLOW_ERROR`。**不在白名单里的一律降级成 `STEP_FAILED`** ——
模块不该能凭空发明错误语义。

`UNKNOWN_OUTCOME` 仍然是特殊的：它表示「外部结果未知」，引擎**永不自动重试**。

## 宿主侧的护栏

| 护栏 | 行为 |
|---|---|
| ABI 版本不符 | 加载失败（`details.kind = "wasm.abi"`） |
| 缺少必需导出 / memory 类型不对 | 加载失败 |
| 模块声明了 import 但宿主没提供 | 加载失败（**默认不允许任何 import**） |
| `mwf_alloc` 返回越界指针 | 执行失败（`wasm.bounds`） |
| 响应长度超过 `maxResponseBytes`（默认 8 MiB）或越界 | 执行失败（`wasm.bounds`） |
| 响应不是合法 JSON / status 不合法 | 执行失败（`wasm.response`） |
| 模块 trap（`unreachable` 等） | 执行失败（`wasm.trap`），`retryable: false` |
| 执行超过 `maxDurationMs` / `timeoutMs` / `step.timeoutMs` | inline 模式：事后审计（`wasm.overrun`）；**worker 模式：terminate 掉线程** |
| 线性内存超过 `maxMemoryBytes` | 执行失败（`wasm.bounds`）—— **事后检查**：`memory.grow` 拦不住，硬隔离要独立进程 |

失败一律包成 `WasmHostError extends WorkflowError`（code `STEP_FAILED`，`retryable: false`），
所以它进 step run 的 `error` 字段、进事件流、被 UI 显示的方式和普通 handler 完全一样。

## 两种执行模式（选一个，别猜）

`mwf_execute` 是**同步**调用，所以「谁来保证它不失控」有两种答案：

| | `execution: "inline"`（默认） | `execution: "worker"` |
|---|---|---|
| 线程 | 同线程 | 独立 worker_threads |
| 速度 | 最快（无跨线程开销） | 每次调用多一次结构化克隆 + 线程切换 |
| 死循环 | **会焊死整个事件循环**，`step.timeoutMs` 拦不住 | **`terminate()` 掉**，`step.timeoutMs` 真生效 |
| 适合 | 自己写的、可信的模块 | **第三方模块** |

```ts
// 第三方模块：放 worker 里跑
registerWasmHandlers(
  registry,
  { "text.extract": bytes },
  { execution: "worker", timeoutMs: 1_000 },
);
```

worker 模式的细节：

- **懒启动**：第一次调用才起线程，注册保持同步
- **超时来源**：`timeoutMs` / `maxDurationMs` 选项，**以及 `step.timeoutMs`**
  （`StepRunner` 通过 `AbortSignal` 传进来）。任一触发都走 `worker.terminate()`
- **自动恢复**：被掐掉之后，下一次调用会重起一个干净的 worker
- **串行**：同一个 host 一次只跑一个调用；要并行就多建几个 host
- **生命周期**：`createWasmHandler()` 返回的 handler 带 `dispose()`，记得在退出时调用
  （worker 空闲时是 `unref` 的，所以忘了也不会吊住进程）

worker 里**没有 IO 能力**：线程入口只做 WebAssembly 调用，不暴露 `fs` / `net` / 时钟，
也不接受模块的 import（除非宿主显式白名单化地传）。所以「独立线程」是隔离与可中断，
不是提权。

## 现成的例子

- `examples/wasm-handler/`：从磁盘加载一个真 `.wasm` 文件并注册（含 Rust 骨架与最小模块）
- `tests/wasm-example.test.ts`：那条链路的回归测试（文件 ↔ 编码器漂移、inline / worker 两种模式）

## 一个 fixture 长什么样

`tests/support/wasm-fixtures.ts` 里有一个**手搓的 wasm 二进制编码器**（不装任何工具链），
用它生成测试模块：`mwf_alloc` 是 bump allocator，`mwf_execute` 用两条 `memory.copy`
把请求原样嵌进响应里：

```
{"status":"completed","output":{"echo":  <请求 JSON>  }}
```

这样一次断言就能同时证明：内存写入、长度前缀、JSON 往返、以及「模块确实收到了完整的请求」。
