import { describe, expect, it } from "vitest";

import { defineWorkflow, type JsonObject } from "../src/index.js";
import {
  WasmHostError,
  WasmStepModule,
  WasmWorkerHost,
  createWasmHandler,
  registerWasmHandlers,
  wasmRuntime,
} from "../src/extensions/wasm/index.js";
import { createHarness } from "./support/harness.js";
import {
  buildCannedModule,
  buildEchoModule,
  buildHugeLengthModule,
  buildInfiniteLoopModule,
  buildTrapModule,
} from "./support/wasm-fixtures.js";

/**
 * Phase F：worker 执行模式。
 *
 * 这是 F 的收官：同线程模式唯一的硬伤（同步 wasm 无法被中断）在这里被解决 ——
 * 超时 = `worker.terminate()`。下面那个死循环模块在同线程模式下会把整个测试卡死，
 * 在 worker 模式下它只是一个普通的失败。
 */

const ECHO = buildEchoModule();

const baseRequest: JsonObject = {
  abi: 1,
  stepId: "extract",
  runId: "run-1",
  stepRunId: "sr-1",
  attempt: 1,
  visit: 1,
  idempotencyKey: "run-1:extract:1",
  context: { seeded: true },
};

function echoed(response: { status: string; output?: unknown }): JsonObject {
  return (response.output as JsonObject)["echo"] as JsonObject;
}

describe("Phase F.worker: 线程隔离", () => {
  it("worker 里跑通 echo —— 请求完整、响应被宿主校验过", async () => {
    const host = new WasmWorkerHost(ECHO, { name: "echo" });
    try {
      const response = await host.invoke({
        ...baseRequest,
        input: { text: "猫逸 🐱" },
      } as never);

      expect(response.status).toBe("completed");
      expect(echoed(response as { status: string; output?: unknown })).toEqual({
        ...baseRequest,
        input: { text: "猫逸 🐱" },
      });
    } finally {
      await host.dispose();
    }
  });

  it("死循环模块被 terminate：进程活着，错误是 STEP_TIMEOUT", async () => {
    const host = new WasmWorkerHost(buildInfiniteLoopModule(), { name: "spin", timeoutMs: 150 });
    const startedAt = Date.now();

    try {
      await host.invoke(baseRequest as never);
      expect.unreachable("死循环模块不该返回");
    } catch (error) {
      const hostError = error as WasmHostError;
      expect(hostError).toBeInstanceOf(WasmHostError);
      expect(hostError.kind).toBe("wasm.overrun");
      expect(hostError.code).toBe("STEP_TIMEOUT");
    }

    // 关键：150ms 就回来了，而不是等它跑到天荒地老
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    await host.dispose();
  });

  it("terminate 之后同一个 host 还能继续用（自动重起干净的 worker）", async () => {
    const host = new WasmWorkerHost(ECHO, { name: "echo" });
    try {
      // 用一个立刻中止的信号把在途调用掐掉 → worker 被 terminate
      const controller = new AbortController();
      const aborted = host.invoke(baseRequest as never, controller.signal);
      controller.abort();
      await expect(aborted).rejects.toThrow(WasmHostError);

      // 同一个 host 再调一次：worker 会重新拉起，正常工作
      const response = await host.invoke(baseRequest as never);
      expect(response.status).toBe("completed");
      expect(echoed(response as { status: string; output?: unknown })["runId"]).toBe("run-1");
    } finally {
      await host.dispose();
    }
  });

  it("dispose 之后拒绝新调用（线程已释放）", async () => {
    const host = new WasmWorkerHost(ECHO, { name: "echo" });
    await host.invoke(baseRequest as never);
    await host.dispose();

    await expect(host.invoke(baseRequest as never)).rejects.toThrow(/已释放/);
  });

  it("worker 模式的错误 kind 与同线程模式一致（两边的检查不会漂）", async () => {
    const cases = [
      { module: buildTrapModule(), kind: "wasm.trap" },
      { module: buildHugeLengthModule(), kind: "wasm.bounds" },
      { module: buildCannedModule('{"status":"whatever"}'), kind: "wasm.response" },
    ] as const;

    for (const { module, kind } of cases) {
      // 同线程
      const inline = new WasmStepModule(module, { name: "inline" });
      let inlineKind: string | undefined;
      try {
        inline.invokeJson(baseRequest);
      } catch (error) {
        inlineKind = (error as WasmHostError).kind;
      }
      expect(inlineKind).toBe(kind);

      // worker
      const host = new WasmWorkerHost(module, { name: "worker" });
      let workerKind: string | undefined;
      try {
        await host.invoke(baseRequest as never);
      } catch (error) {
        workerKind = (error as WasmHostError).kind;
      } finally {
        await host.dispose();
      }
      expect(workerKind).toBe(kind);
    }
  });

  it("worker 模式不接受已编译的 Module（编译结果跨不了线程）", () => {
    const compiled = new (wasmRuntime().Module)(ECHO);
    expect(() => new WasmWorkerHost(compiled, { name: "compiled" })).toThrow(/需要模块字节/);
  });
});

describe("Phase F.worker: 接进 engine", () => {
  it("第三方模块放 worker 跑：engine 侧完全无感", async () => {
    const h = createHarness();
    h.registry.register("test.after", h.tracked("after"));
    registerWasmHandlers(
      h.registry,
      { "wasm.echo": ECHO },
      { execution: "worker", timeoutMs: 5_000 },
    );

    const run = await h.engine.start(
      defineWorkflow({
        id: "wasm-worker-engine",
        version: 1,
        start: "extract",
        steps: {
          extract: { uses: "wasm.echo", config: { currency: "CNY" }, next: "after" },
          after: { uses: "test.after" },
        },
      }),
      { input: { text: "报价 1200 CNY" } },
    );

    expect(await h.worker.tick()).toEqual({ claimed: 1, handled: 1, failed: 0, completed: 1 });
    expect((await h.engine.get(run.id)).status).toBe("COMPLETED");
    expect(h.calls).toEqual(["after"]);

    const stepRun = (await h.storage.steps.listByRun(run.id))[0];
    const echo = (stepRun?.output as JsonObject)["echo"] as JsonObject;
    expect(echo["config"]).toEqual({ currency: "CNY" });
    expect(echo["input"]).toEqual({ text: "报价 1200 CNY" });
  });

  it("step.timeoutMs 真的能掐断死循环模块 —— run FAILED(STEP_TIMEOUT)，测试还能继续跑", async () => {
    const h = createHarness();
    registerWasmHandlers(h.registry, { "wasm.spin": buildInfiniteLoopModule() }, { execution: "worker" });

    const run = await h.engine.start(
      defineWorkflow({
        id: "wasm-worker-timeout",
        version: 1,
        start: "spin",
        steps: { spin: { uses: "wasm.spin", timeoutMs: 150 } },
      }),
    );

    const startedAt = Date.now();
    const result = await h.worker.tick();

    expect(result.handled).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(3_000);

    const final = await h.engine.get(run.id);
    expect(final.status).toBe("FAILED");
    expect(final.error?.code).toBe("STEP_TIMEOUT");

    const stepRun = (await h.storage.steps.listByRun(run.id))[0];
    expect(stepRun?.status).toBe("FAILED");
    expect(stepRun?.error?.code).toBe("STEP_TIMEOUT");
  });

  it("多个 run 并发跑 wasm handler：host 内部串行，但不互相污染", async () => {
    const h = createHarness();
    registerWasmHandlers(h.registry, { "wasm.echo": ECHO }, { execution: "worker" });

    const workflow = defineWorkflow({
      id: "wasm-worker-concurrent",
      version: 1,
      start: "extract",
      steps: { extract: { uses: "wasm.echo" } },
    });

    const runs = await Promise.all([
      h.engine.start(workflow, { input: { n: 1 } }),
      h.engine.start(workflow, { input: { n: 2 } }),
      h.engine.start(workflow, { input: { n: 3 } }),
    ]);

    const result = await h.worker.tick();
    expect(result.claimed).toBe(3);
    expect(result.failed).toBe(0);

    for (const [index, run] of runs.entries()) {
      expect((await h.engine.get(run.id)).status).toBe("COMPLETED");
      const stepRun = (await h.storage.steps.listByRun(run.id))[0];
      const echo = (stepRun?.output as JsonObject)["echo"] as JsonObject;
      // 每个 run 拿到的都是自己的请求
      expect(echo["input"]).toEqual({ n: index + 1 });
      expect(echo["runId"]).toBe(run.id);
    }
  });
});

describe("Phase F.worker: handler 生命周期", () => {
  it("createWasmHandler 返回的 handler 有 dispose()", async () => {
    const handler = createWasmHandler(ECHO, { execution: "worker", handlerName: "wasm.echo" });

    const result = await handler.execute(
      {
        runId: "r",
        stepRunId: "sr",
        stepId: "s",
        input: undefined,
        context: {},
        attempt: 1,
        visit: 1,
        idempotencyKey: "r:s:1",
        signal: new AbortController().signal,
      },
      undefined,
    );
    expect(result.status).toBe("completed");

    await handler.dispose();
    await handler.dispose(); // 幂等
  });
});
