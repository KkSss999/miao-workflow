import { beforeEach, describe, expect, it } from "vitest";

import {
  MemoryWorkflowStorage,
  StorageConflictError,
  buildIdempotencyKey,
  defineWorkflow,
  hashDefinition,
} from "../src/index.js";
import type { WorkflowDefinition, WorkflowEvent, WorkflowRun, WorkflowSignal, StepRun } from "../src/index.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");

let now: Date;
let storage: MemoryWorkflowStorage;

beforeEach(() => {
  now = new Date(START);
  storage = new MemoryWorkflowStorage({ now: () => now });
});

function advance(ms: number): void {
  now = new Date(now.getTime() + ms);
}

function definition(version = 1): WorkflowDefinition {
  return defineWorkflow({
    id: "test-workflow",
    version,
    start: "a",
    steps: {
      a: { uses: "test.a", next: "b" },
      b: { uses: "test.b" },
    },
  });
}

function run(id: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  const at = now.toISOString();
  return {
    id,
    workflowId: "test-workflow",
    workflowVersion: 1,
    status: "CREATED",
    input: undefined,
    context: {},
    currentStepId: null,
    currentStepRunId: null,
    wakeAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    ...overrides,
  };
}

describe("MemoryDefinitionStore", () => {
  it("同版本同内容重复发布是幂等的", async () => {
    const first = definition();
    await storage.definitions.save({ definition: first, definitionHash: hashDefinition(first) });
    await storage.definitions.save({ definition: first, definitionHash: hashDefinition(first) });

    expect(await storage.definitions.listVersions("test-workflow")).toEqual([1]);
    expect(await storage.definitions.get("test-workflow", 1)).toEqual(first);
  });

  it("已发布版本不可修改：同版本不同内容直接报错", async () => {
    const first = definition();
    await storage.definitions.save({ definition: first, definitionHash: hashDefinition(first) });

    const mutated = defineWorkflow({
      id: "test-workflow",
      version: 1,
      start: "a",
      steps: {
        a: { uses: "test.a", next: "b" },
        b: { uses: "test.changed" },
      },
    });

    await expect(
      storage.definitions.save({ definition: mutated, definitionHash: hashDefinition(mutated) }),
    ).rejects.toThrow(StorageConflictError);
  });

  it("getLatest 取最高版本，老 run 仍能取到 v1", async () => {
    for (const version of [1, 2, 3]) {
      const item = definition(version);
      await storage.definitions.save({ definition: item, definitionHash: hashDefinition(item) });
    }

    expect(await storage.definitions.listVersions("test-workflow")).toEqual([1, 2, 3]);
    expect((await storage.definitions.getLatest("test-workflow"))?.version).toBe(3);
    expect((await storage.definitions.get("test-workflow", 1))?.version).toBe(1);
    expect(await storage.definitions.get("test-workflow", 9)).toBeNull();
  });

  it("取出来的是副本，改不到库里", async () => {
    const item = definition();
    await storage.definitions.save({ definition: item, definitionHash: hashDefinition(item) });

    const fetched = (await storage.definitions.get("test-workflow", 1)) as WorkflowDefinition;
    delete fetched.steps["b"];

    expect((await storage.definitions.get("test-workflow", 1))?.steps["b"]).toBeDefined();
  });
});

describe("MemoryRunStore", () => {
  it("同一个 run 在租期内只会被一个 worker 抢到", async () => {
    await storage.runs.create(run("run-1"));
    await storage.runs.create(run("run-2"));

    const claimedByA = await storage.runs.claimDue({ owner: "A", limit: 10, leaseMs: 30_000 });
    expect(claimedByA.map((item) => item.id)).toEqual(["run-1", "run-2"]);
    expect(claimedByA.every((item) => item.leaseOwner === "A" && item.status === "RUNNING")).toBe(true);

    const claimedByB = await storage.runs.claimDue({ owner: "B", limit: 10, leaseMs: 30_000 });
    expect(claimedByB).toEqual([]);
  });

  it("租期过期后别的 worker 可以接手（crash recovery 的基础）", async () => {
    await storage.runs.create(run("run-1"));
    await storage.runs.claimDue({ owner: "A", limit: 1, leaseMs: 30_000 });

    advance(30_001);

    const claimedByB = await storage.runs.claimDue({ owner: "B", limit: 10, leaseMs: 30_000 });
    expect(claimedByB.map((item) => item.id)).toEqual(["run-1"]);
    expect(claimedByB[0]?.leaseOwner).toBe("B");
  });

  it("wake_at 未到点的 run 不会被抢走", async () => {
    await storage.runs.create(run("delayed", { status: "WAITING", wakeAt: new Date(START + 60_000).toISOString() }));

    expect(await storage.runs.claimDue({ owner: "A", limit: 10, leaseMs: 30_000 })).toEqual([]);

    advance(60_001);
    const claimed = await storage.runs.claimDue({ owner: "A", limit: 10, leaseMs: 30_000 });
    expect(claimed.map((item) => item.id)).toEqual(["delayed"]);
  });

  it("等信号的 WAITING（wakeAt 为 null）永远不会被抢走，否则就是空转", async () => {
    await storage.runs.create(run("waiting", { status: "WAITING", wakeAt: null }));
    advance(3_600_000);
    expect(await storage.runs.claimDue({ owner: "A", limit: 10, leaseMs: 30_000 })).toEqual([]);
  });

  it("只续自己的租：别人的 owner 续不动", async () => {
    await storage.runs.create(run("run-1"));
    await storage.runs.claimDue({ owner: "A", limit: 1, leaseMs: 1_000 });

    expect(await storage.runs.renewLease("run-1", "B", 60_000)).toBe(false);
    expect(await storage.runs.renewLease("run-1", "A", 60_000)).toBe(true);
  });

  it("release 之后别人立刻能接手", async () => {
    await storage.runs.create(run("run-1"));
    await storage.runs.claimDue({ owner: "A", limit: 1, leaseMs: 30_000 });
    await storage.runs.releaseLease("run-1", "A");

    const claimedByB = await storage.runs.claimDue({ owner: "B", limit: 1, leaseMs: 30_000 });
    expect(claimedByB.map((item) => item.id)).toEqual(["run-1"]);
  });
});

describe("MemorySignalStore", () => {
  function signal(id: string, name = "approval"): WorkflowSignal {
    return { id, runId: "run-1", name, payload: { decision: "approve" }, createdAt: now.toISOString(), consumedAt: null };
  }

  it("同一条信号只能被消费一次", async () => {
    await storage.signals.append(signal("s1"));
    await storage.signals.append(signal("s2"));

    expect(await storage.signals.countPending("run-1")).toBe(2);

    const first = await storage.signals.consumeNext("run-1", "approval");
    expect(first?.id).toBe("s1");
    expect(first?.consumedAt).not.toBeNull();

    const second = await storage.signals.consumeNext("run-1", "approval");
    expect(second?.id).toBe("s2");

    expect(await storage.signals.consumeNext("run-1", "approval")).toBeNull();
    expect(await storage.signals.countPending("run-1")).toBe(0);
  });

  it("按名字消费，别的名字不掺和", async () => {
    await storage.signals.append(signal("s1", "approval"));
    await storage.signals.append(signal("s2", "payment"));

    expect((await storage.signals.consumeNext("run-1", "payment"))?.id).toBe("s2");
    expect((await storage.signals.consumeNext("run-1", "approval"))?.id).toBe("s1");
  });
});

describe("MemoryStepRunStore", () => {
  function stepRun(overrides: Partial<StepRun> = {}): StepRun {
    const at = now.toISOString();
    return {
      id: "sr-1",
      runId: "run-1",
      stepId: "a",
      status: "COMPLETED",
      attempt: 1,
      visit: 1,
      input: undefined,
      output: { ok: true },
      patch: undefined,
      error: null,
      waitFor: null,
      idempotencyKey: buildIdempotencyKey("run-1", "a", 1),
      startedAt: at,
      finishedAt: at,
      wakeAt: null,
      createdAt: at,
      updatedAt: at,
      ...overrides,
    };
  }

  it("幂等键能查回同一次业务动作", async () => {
    const created = stepRun();
    await storage.steps.create(created);

    const found = await storage.steps.getByIdempotencyKey("run-1:a:1");
    expect(found?.id).toBe("sr-1");
    expect(await storage.steps.getByIdempotencyKey("run-1:a:2")).toBeNull();
  });

  it("findLatest 取 visit 最大的那次", async () => {
    await storage.steps.create(stepRun({ id: "sr-1", visit: 1 }));
    advance(1_000);
    await storage.steps.create(stepRun({ id: "sr-2", visit: 2, idempotencyKey: buildIdempotencyKey("run-1", "a", 2) }));

    expect((await storage.steps.findLatest("run-1", "a"))?.id).toBe("sr-2");
    expect(await storage.steps.countByRun("run-1")).toBe(2);
  });
});

describe("MemoryEventStore", () => {
  function event(id: string): WorkflowEvent {
    const at = now.toISOString();
    advance(1_000);
    return { id, runId: "run-1", stepId: null, type: "workflow.started", payload: {}, createdAt: at };
  }

  it("事件只追加，且支持 limit / after 翻页", async () => {
    await storage.events.append(event("e1"));
    await storage.events.append(event("e2"));
    await storage.events.append(event("e3"));

    const all = await storage.events.listByRun("run-1");
    expect(all.map((item) => item.id)).toEqual(["e1", "e2", "e3"]);

    const afterFirst = await storage.events.listByRun("run-1", { after: "e1" });
    expect(afterFirst.map((item) => item.id)).toEqual(["e2", "e3"]);

    const limited = await storage.events.listByRun("run-1", { limit: 1 });
    expect(limited.map((item) => item.id)).toEqual(["e1"]);
  });
});
