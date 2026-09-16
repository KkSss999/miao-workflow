import { describe, expect, it } from "vitest";

import { MemoryWorkflowStorage, defineWorkflow, hashDefinition } from "../src/index.js";
import type { WorkflowDefinition } from "../src/index.js";
import { describeStorageConformance } from "./support/storage-conformance.js";
import { memoryHarness } from "./support/storage-fixtures.js";

/** 语义一致性：与 Postgres 跑同一套 conformance */
describeStorageConformance("MemoryWorkflowStorage", memoryHarness());

/** 内存实现特有的保证 */
describe("MemoryWorkflowStorage：隔离性", () => {
  it("取出来的是副本，改不到库里", async () => {
    const storage = new MemoryWorkflowStorage();
    const definition = defineWorkflow({
      id: "test-workflow",
      version: 1,
      start: "a",
      steps: { a: { uses: "test.a", next: "b" }, b: { uses: "test.b" } },
    });
    await storage.definitions.save({ definition, definitionHash: hashDefinition(definition) });

    const fetched = (await storage.definitions.get("test-workflow", 1)) as WorkflowDefinition;
    delete fetched.steps["b"];

    expect((await storage.definitions.get("test-workflow", 1))?.steps["b"]).toBeDefined();
  });
});
