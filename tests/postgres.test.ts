import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresWorkflowStorage } from "../src/index.js";
import { describeStorageConformance } from "./support/storage-conformance.js";

/**
 * 跑真 Postgres。没有 `MWF_TEST_POSTGRES_URL` 就整体跳过 —— 不假装测过。
 *
 * 起环境：`pnpm test:postgres`（脚本会拉一个临时容器，用完删掉）。
 */
const url = process.env["MWF_TEST_POSTGRES_URL"];
const suite = url === undefined ? describe.skip : describe;

suite("PostgresWorkflowStorage", () => {
  const pool = new Pool({ connectionString: url, max: 8 });
  const storage = new PostgresWorkflowStorage({ client: pool });

  beforeAll(async () => {
    await storage.migrate();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("migrate 是幂等的", async () => {
    await storage.migrate();
    await storage.migrate();
  });

  it("并发抢占走的是真连接池：FOR UPDATE SKIP LOCKED 不会分给两个人", async () => {
    await pool.query(
      "TRUNCATE workflow_events, workflow_signals, workflow_step_runs, workflow_runs, workflow_definitions RESTART IDENTITY CASCADE",
    );
    await storage.definitions.save({
      definition: { id: "w", version: 1, start: "a", steps: { a: { uses: "test.a", next: [] } } },
      definitionHash: "hash-w",
    });
    const at = new Date("2026-01-01T00:00:00.000Z").toISOString();
    await storage.runs.create({
      id: "run-1",
      workflowId: "w",
      workflowVersion: 1,
      status: "CREATED",
      input: undefined,
      context: {},
      currentStepId: "a",
      currentStepRunId: null,
      wakeAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      error: null,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        storage.runs.claimDue({ owner: `worker-${index}`, limit: 1, leaseMs: 30_000, now: at }),
      ),
    );

    const winners = results.flat();
    expect(winners).toHaveLength(1);
    expect(winners[0]?.id).toBe("run-1");
  });

  describeStorageConformance("conformance（与 memory 同一套断言）", {
    create: () => storage,
    reset: async () => {
      await pool.query(
        "TRUNCATE workflow_events, workflow_signals, workflow_step_runs, workflow_runs, workflow_definitions RESTART IDENTITY CASCADE",
      );
    },
  });
});
