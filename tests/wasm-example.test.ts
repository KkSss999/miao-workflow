import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Registry, defineWorkflow, type JsonObject } from "../src/index.js";
import { WasmStepModule, createWasmHandler, registerWasmHandlers } from "../src/extensions/wasm/index.js";
import { createHarness } from "./support/harness.js";
import { buildEchoModule } from "./support/wasm-fixtures.js";

/**
 * `examples/wasm-handler/echo.wasm` 是**磁盘上的真文件** —— 这条链路和别的 wasm 测试不同：
 * 那些用的是内存里的字节，这里证明的是「第三方把 .wasm 丢过来、注册、跑起来」。
 */

const modulePath = fileURLToPath(new URL("../examples/wasm-handler/echo.wasm", import.meta.url));
const bytes = readFileSync(modulePath);

describe("examples/wasm-handler: 从磁盘加载第三方模块", () => {
  it("磁盘上的 echo.wasm 与编码器输出一致（防止两边漂移）", () => {
    expect(bytes.equals(Buffer.from(buildEchoModule()))).toBe(true);
  });

  it("inline 模式：注册成一个普通 handler 就能跑", async () => {
    const h = createHarness();
    registerWasmHandlers(h.registry, { "text.extract": bytes });

    const run = await h.engine.start(
      defineWorkflow({
        id: "wasm-example-inline",
        version: 1,
        start: "extract",
        steps: { extract: { uses: "text.extract", config: { currency: "CNY" } } },
      }),
      { input: { text: "报价 1200 CNY" } },
    );

    expect((await h.worker.tick()).completed).toBe(1);

    const stepRun = (await h.storage.steps.listByRun(run.id))[0];
    const echo = (stepRun?.output as JsonObject)["echo"] as JsonObject;
    expect(echo["stepId"]).toBe("extract");
    expect(echo["config"]).toEqual({ currency: "CNY" });
    expect(echo["input"]).toEqual({ text: "报价 1200 CNY" });
  });

  it("worker 模式 + 中间夹一次人工审批：从文件加载的模块也能参与挂起与恢复", async () => {
    const h = createHarness();
    h.registry.register({
      "human.approval": {
        async execute({ resume }) {
          return resume === undefined
            ? { status: "waiting" as const, waitFor: "approval" }
            : { status: "completed" as const, output: resume.payload ?? null, patch: { approved: true } };
        },
      },
    });
    registerWasmHandlers(h.registry, { "text.extract": bytes }, { execution: "worker", timeoutMs: 5_000 });

    const run = await h.engine.start(
      defineWorkflow({
        id: "wasm-example-worker",
        version: 1,
        start: "approve",
        steps: {
          approve: { uses: "human.approval", next: "extract" },
          extract: { uses: "text.extract" },
        },
      }),
    );

    await h.worker.tick();
    expect((await h.engine.get(run.id)).status).toBe("WAITING");

    await h.engine.signal(run.id, "approval", { by: "gery" });
    await h.worker.tick();

    const final = await h.engine.get(run.id);
    expect(final.status).toBe("COMPLETED");
    expect(final.context).toEqual({ approved: true });

    const stepRun = (await h.storage.steps.listByRun(run.id))[1];
    const echo = (stepRun?.output as JsonObject)["echo"] as JsonObject;
    // 模块能看到上游的 output（= approval 那一步的 resume payload）
    expect(echo["input"]).toEqual({ by: "gery" });
  });

  it("模块落盘之后，引擎完全不知道它是 wasm", async () => {
    const handler = createWasmHandler(bytes, { handlerName: "text.extract" });
    const registry = new Registry().register({ "text.extract": handler });

    const result = await handler.execute(
      {
        runId: "r",
        stepRunId: "sr",
        stepId: "extract",
        input: { text: "hi" },
        context: {},
        attempt: 1,
        visit: 1,
        idempotencyKey: "r:extract:1",
        signal: new AbortController().signal,
      },
      undefined,
    );

    expect(result.status).toBe("completed");
    await handler.dispose();

    // 同一个模块也可以直接当 WasmStepModule 用（低层 API）
    const module = new WasmStepModule(bytes, { name: "echo" });
    expect(registry.has("text.extract")).toBe(true);
    expect(module.memory.buffer.byteLength).toBeGreaterThan(0);
  });
});
