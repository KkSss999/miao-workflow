import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SCHEMA_SQL } from "../src/index.js";

/**
 * `src/storage/schema.ts` 是权威来源，`docs/postgres-schema.sql` 是给人看的副本。
 * 这个测试就是防止两边漂移 —— 手改 .sql 而不改 TS 会立刻红。
 */
describe("postgres schema", () => {
  it("docs/postgres-schema.sql 与 SCHEMA_SQL 完全一致", () => {
    const path = fileURLToPath(new URL("../docs/postgres-schema.sql", import.meta.url));
    expect(readFileSync(path, "utf8")).toBe(SCHEMA_SQL);
  });

  it("五张表都在，且都带 IF NOT EXISTS（migrate 必须可重复跑）", () => {
    for (const table of [
      "workflow_definitions",
      "workflow_runs",
      "workflow_step_runs",
      "workflow_signals",
      "workflow_events",
    ]) {
      expect(SCHEMA_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(5);
  });
});
