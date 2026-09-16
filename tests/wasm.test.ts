import { describe, expect, it } from "vitest";

import {
  Registry,
  defineWorkflow,
  type JsonObject,
  type StepExecutionContext,
} from "../src/index.js";
import {
  WasmHostError,
  WasmStepModule,
  createWasmHandler,
  registerWasmHandlers,
} from "../src/extensions/wasm/index.js";
import { createHarness } from "./support/harness.js";
import {
  buildCannedModule,
  buildEchoModule,
  buildHugeLengthModule,
  buildImportingModule,
  buildModule,
  buildTrapModule,
  op,
} from "./support/wasm-fixtures.js";

/**
 * Phase F：WASM handler 宿主。
 *
 * 夹具是**手搓的 wasm 二进制**（tests/support/wasm-fixtures.ts，不装任何工具链）：
 * `mwf_execute` 把请求原样嵌进响应，所以一次断言就能证明内存写入、长度前缀、JSON 往返都对。
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

/** 夹具把请求原样放在 output.echo 里 */
function echoOf(output: JsonObject): JsonObject {
  return output["echo"] as JsonObject;
}

function echoed(response: unknown): JsonObject {
  return echoOf((response as { output: JsonObject }).output);
}

describe("Phase F: ABI 底层（手搓模块）", () => {
  it("模块收到的是完整请求 JSON —— 内存写入与长度前缀都对", () => {
    const module = new WasmStepModule(ECHO, { name: "echo" });
    const response = module.invokeJson({ ...baseRequest, input: { text: "hello 世界" } });

    expect(response.status).toBe("completed");
    expect(echoed(response)).toEqual({ ...baseRequest, input: { text: "hello 世界" } });
  });

  it("UTF-8 多字节内容不会串码", () => {
    const module = new WasmStepModule(ECHO, { name: "echo" });
    const request = echoed(module.invokeJson({ ...baseRequest, input: { text: "猫逸 workflow 🐱" } }));
    expect((request["input"] as JsonObject)["text"]).toBe("猫逸 workflow 🐱");
  });

  it("mwf_reset 让模块复用工作区：调用 200 次内存不涨", () => {
    const module = new WasmStepModule(ECHO, { name: "echo" });
    const before = module.memory.buffer.byteLength;
    for (let i = 0; i < 200; i += 1) module.invokeJson(baseRequest);

    expect(module.memory.buffer.byteLength).toBe(before);
  });

  it("ABI 版本不符 → 加载失败", () => {
    const v2 = buildCannedModule('{"status":"completed"}', { abiVersion: 2 });
    expect(() => new WasmStepModule(v2, { name: "v2" })).toThrow(/ABI 版本/);
  });

  it("没有导出 memory → 加载失败", () => {
    const noMemoryExport = buildModule({
      pages: 1,
      memoryExport: "",
      functions: {
        mwf_abi_version: { body: op.i32Const(1) },
        mwf_alloc: { params: 1, body: op.i32Const(4096) },
        mwf_execute: { params: 2, body: op.i32Const(4096) },
      },
    });
    expect(() => new WasmStepModule(noMemoryExport, { name: "no-memory" })).toThrow(/必须导出 memory/);
  });

  it("缺 mwf_execute / mwf_alloc → 加载失败", () => {
    const noExecute = buildModule({
      pages: 1,
      functions: {
        mwf_abi_version: { body: op.i32Const(1) },
        mwf_alloc: { params: 1, body: op.i32Const(4096) },
      },
    });
    expect(() => new WasmStepModule(noExecute, { name: "no-execute" })).toThrow(/mwf_execute/);

    const noAlloc = buildModule({
      pages: 1,
      functions: {
        mwf_abi_version: { body: op.i32Const(1) },
        mwf_execute: { params: 2, body: op.i32Const(4096) },
      },
    });
    expect(() => new WasmStepModule(noAlloc, { name: "no-alloc" })).toThrow(/mwf_alloc/);
  });

  it("不是 wasm 二进制 → 加载失败", () => {
    expect(() => new WasmStepModule(new Uint8Array([1, 2, 3, 4]), { name: "junk" })).toThrow(/不是合法的 wasm/);
  });
});

describe("Phase F: 作为 StepHandler 跑在 engine 里", () => {
  it("output / patch / context 与普通 handler 完全一样", async () => {
    const h = createHarness();
    h.registry.register("test.after", h.tracked("after"));
    registerWasmHandlers(h.registry, { "wasm.echo": ECHO });

    const run = await h.engine.start(
      defineWorkflow({
        id: "wasm-in-engine",
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
    const echo = echoOf(stepRun?.output as JsonObject);
    expect(echo["stepId"]).toBe("extract");
    expect(echo["runId"]).toBe(run.id);
    expect(echo["stepRunId"]).toBe(stepRun?.id);
    expect(echo["attempt"]).toBe(1);
    expect(echo["visit"]).toBe(1);
    expect(echo["idempotencyKey"]).toBe(`${run.id}:extract:1`);
    expect(echo["input"]).toEqual({ text: "报价 1200 CNY" });
    expect(echo["config"]).toEqual({ currency: "CNY" });
    expect(echo["context"]).toEqual({});
    expect(echo["resume"]).toBeUndefined();
  });

  it("模块返回 waiting → run 挂起（不占进程）", async () => {
    const h = createHarness();
    registerWasmHandlers(h.registry, { "wasm.gate": buildCannedModule('{"status":"waiting","waitFor":"approval"}') });

    const run = await h.engine.start(
      defineWorkflow({ id: "wasm-wait", version: 1, start: "gate", steps: { gate: { uses: "wasm.gate" } } }),
    );
    await h.worker.tick();

    const waiting = await h.engine.get(run.id);
    expect(waiting.status).toBe("WAITING");
    expect(waiting.currentStepId).toBe("gate");
    expect((await h.storage.steps.listByRun(run.id))[0]?.waitFor).toBe("approval");
  });

  it("模块返回可重试失败 → 引擎按 retry policy 进 RETRYING", async () => {
    const h = createHarness();
    registerWasmHandlers(h.registry, {
      "wasm.flaky": buildCannedModule(
        '{"status":"failed","error":{"code":"STEP_FAILED","message":"下游 503","retryable":true}}',
      ),
    });

    const run = await h.engine.start(
      defineWorkflow({
        id: "wasm-retry",
        version: 1,
        start: "flaky",
        steps: {
          flaky: {
            uses: "wasm.flaky",
            retry: { maxAttempts: 3, backoff: "fixed", initialDelayMs: 1_000, jitter: false },
          },
        },
      }),
    );

    expect((await h.worker.tick()).handled).toBe(1);
    const retrying = await h.engine.get(run.id);
    expect(retrying.status).toBe("RETRYING");
    expect(retrying.wakeAt).toBe("2026-01-01T00:00:01.000Z");
  });

  it("UNKNOWN_OUTCOME 从 wasm 出来仍然是一等语义（不自动重试 + 可 reconcile）", async () => {
    const h = createHarness();
    registerWasmHandlers(h.registry, {
      "wasm.unknown": buildCannedModule(
        '{"status":"failed","error":{"code":"UNKNOWN_OUTCOME","message":"邮件结果未知"}}',
      ),
    });

    const run = await h.engine.start(
      defineWorkflow({
        id: "wasm-unknown",
        version: 1,
        start: "send",
        steps: { send: { uses: "wasm.unknown", retry: { maxAttempts: 5, initialDelayMs: 10 } } },
      }),
    );
    await h.worker.tick();

    const final = await h.engine.get(run.id);
    expect(final.status).toBe("FAILED");
    expect(final.error?.code).toBe("UNKNOWN_OUTCOME");
    expect((await h.engine.reconcile(run.id, "retry")).status).toBe("RUNNING");
  });

  it("白名单之外的错误码会被降级成 STEP_FAILED（模块不能发明语义）", async () => {
    const h = createHarness();
    registerWasmHandlers(h.registry, {
      "wasm.evil": buildCannedModule('{"status":"failed","error":{"code":"TOTALLY_FINE","message":"没事"}}'),
    });

    const run = await h.engine.start(
      defineWorkflow({ id: "wasm-evil", version: 1, start: "a", steps: { a: { uses: "wasm.evil" } } }),
    );
    await h.worker.tick();

    expect((await h.engine.get(run.id)).error?.code).toBe("STEP_FAILED");
  });

  it("trap → 不可重试的失败，details.kind = wasm.trap", async () => {
    const h = createHarness();
    registerWasmHandlers(h.registry, { "wasm.trap": buildTrapModule() });

    const run = await h.engine.start(
      defineWorkflow({
        id: "wasm-trap",
        version: 1,
        start: "a",
        steps: { a: { uses: "wasm.trap", retry: { maxAttempts: 3, initialDelayMs: 10 } } },
      }),
    );
    await h.worker.tick();

    const final = await h.engine.get(run.id);
    expect(final.status).toBe("FAILED");
    expect(final.error?.retryable).toBe(false);
    expect(final.error?.details?.["kind"]).toBe("wasm.trap");
  });

  it("内置 workflow.delay 与 wasm handler 混用也正常", async () => {
    const h = createHarness();
    registerWasmHandlers(h.registry, { "wasm.echo": ECHO });

    const run = await h.engine.start(
      defineWorkflow({
        id: "wasm-with-delay",
        version: 1,
        start: "pause",
        steps: {
          pause: { uses: "workflow.delay", config: { duration: "1s" }, next: "extract" },
          extract: { uses: "wasm.echo" },
        },
      }),
    );

    await h.worker.tick();
    expect((await h.engine.get(run.id)).status).toBe("WAITING");

    h.advance(1_000);
    await h.worker.tick();
    expect((await h.engine.get(run.id)).status).toBe("COMPLETED");
  });
});

describe("Phase F: resume 与失败语义", () => {
  it("被叫醒重新执行时，模块能拿到 resume（宿主把挂起信息也送过去）", async () => {
    const handler = createWasmHandler(ECHO, { handlerName: "wasm.echo" });
    const context: StepExecutionContext = {
      runId: "run-1",
      stepRunId: "sr-1",
      stepId: "gate",
      input: undefined,
      context: { approved: true },
      attempt: 2,
      visit: 1,
      idempotencyKey: "run-1:gate:1",
      signal: new AbortController().signal,
      resume: { waitFor: "approval", payload: { by: "gery" } },
    };

    const result = await handler.execute(context, undefined);
    expect(result.status).toBe("completed");
    const echo = echoed(result);
    expect(echo["resume"]).toEqual({ waitFor: "approval", payload: { by: "gery" } });
    expect(echo["attempt"]).toBe(2);
    expect(echo["context"]).toEqual({ approved: true });
  });

  it("越界 / 超大长度 / 非法 JSON / 非法 status 都有明确的错误", () => {
    expect(() => new WasmStepModule(buildHugeLengthModule(), { name: "huge" }).invokeJson(baseRequest)).toThrow(
      /超过上限/,
    );
    expect(() =>
      new WasmStepModule(buildEchoModule(), { name: "echo", maxResponseBytes: 16 }).invokeJson(baseRequest),
    ).toThrow(/超过上限/);

    for (const [response, pattern] of [
      ["这不是 JSON", /不是合法 JSON/],
      ['{"status":"whatever"}', /未知的 status/],
      ['{"status":"waiting"}', /waitFor/],
      ['{"status":"failed"}', /error 对象/],
      ['[1,2,3]', /必须是 JSON 对象/],
    ] as const) {
      expect(() => new WasmStepModule(buildCannedModule(response), { name: "bad" }).invokeJson(baseRequest)).toThrow(
        pattern,
      );
    }
  });

  it("超过 maxDurationMs 会被标成 STEP_TIMEOUT（事后审计，不是熔断）", () => {
    const module = new WasmStepModule(ECHO, { name: "slow", maxDurationMs: -1 });
    try {
      module.invokeJson(baseRequest);
      expect.unreachable("应该抛超时");
    } catch (error) {
      const hostError = error as WasmHostError;
      expect(hostError).toBeInstanceOf(WasmHostError);
      expect(hostError.kind).toBe("wasm.overrun");
      expect(hostError.code).toBe("STEP_TIMEOUT");
    }
  });

  it("wasm handler 失败不会污染 context", async () => {
    const h = createHarness();
    registerWasmHandlers(h.registry, { "wasm.bad": buildCannedModule('{"status":"nope"}') });

    const run = await h.engine.start(
      defineWorkflow({ id: "wasm-bad", version: 1, start: "a", steps: { a: { uses: "wasm.bad" } } }),
    );
    await h.worker.tick();

    const final = await h.engine.get(run.id);
    expect(final.status).toBe("FAILED");
    expect(final.context).toEqual({});
  });
});

describe("Phase F: 能力由宿主中介", () => {
  it("模块依赖 import 而宿主什么都不给 → 加载失败（沙箱默认没有 IO）", () => {
    try {
      new WasmStepModule(buildImportingModule(), { name: "needs-io" });
      expect.unreachable("应该拒绝加载");
    } catch (error) {
      const hostError = error as WasmHostError;
      expect(hostError).toBeInstanceOf(WasmHostError);
      expect(hostError.kind).toBe("wasm.imports");
    }
  });

  it("显式白名单化之后可以给能力（capability mediation）", async () => {
    const h = createHarness();
    let probes = 0;
    h.registry.register({
      "wasm.importing": createWasmHandler(buildImportingModule(), {
        handlerName: "wasm.importing",
        imports: {
          env: {
            mwf_probe: () => {
              probes += 1;
            },
          },
        },
      }),
    });

    const run = await h.engine.start(
      defineWorkflow({ id: "wasm-capability", version: 1, start: "a", steps: { a: { uses: "wasm.importing" } } }),
    );
    await h.worker.tick();

    expect(probes).toBe(1);
    const stepRun = (await h.storage.steps.listByRun(run.id))[0];
    expect(stepRun?.output).toEqual({ imported: true });
  });
});

describe("Phase F: 第三方接入入口", () => {
  it("registerWasmHandlers 一次注册多个模块（链式）", () => {
    const registry = new Registry();
    const returned = registerWasmHandlers(registry, {
      "text.extract": buildEchoModule(),
      "rules.evaluate": buildCannedModule('{"status":"completed","patch":{"ok":true}}'),
    });

    expect(returned).toBe(registry);
    expect(registry.handlerNames()).toEqual(["rules.evaluate", "text.extract"]);
  });
});
