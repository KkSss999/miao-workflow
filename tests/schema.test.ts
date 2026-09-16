import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/index.js";

/**
 * `src/storage/schema.ts` 是权威来源，`docs/postgres-schema.sql` 是给人看的副本。
 * 这个测试就是防止两边漂移 —— 手改 .sql 而不改 TS 会立刻红。
 */
describe("postgres schema", () => {
  it("docs/postgres-schema.sql 与 SCHEMA_SQL 完全一致", () => {
    const path = fileURLToPath(new URL("../docs/postgres-schema.sql", import.meta.url));
    expect(readFileSync(path, "utf8")).toBe(SCHEMA_SQL);
  });

  it("业务五张表 + 迁移记录表都在，且都带 IF NOT EXISTS（migrate 必须可重复跑）", () => {
    const tables = [
      "workflow_definitions",
      "workflow_runs",
      "workflow_step_runs",
      "workflow_signals",
      "workflow_events",
      "workflow_schema_migrations",
    ];
    for (const table of tables) {
      expect(SCHEMA_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(tables.length);
  });

  it("SCHEMA_VERSION 存在且为正整数（migrate 会把它写进迁移表）", () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });
});
