// 把 src/storage/schema.ts 里的 SCHEMA_SQL 同步到 docs/postgres-schema.sql。
//
// 权威来源永远是 TS（包只发布 dist/，运行时读 .sql 文件在消费方会失效）。
// tests/schema.test.ts 会断言两者一致 —— 手改了 .sql 忘了同步就会红。
//
// 用法：pnpm schema:sync
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "src/storage/schema.ts";
const TARGET = "docs/postgres-schema.sql";
const ANCHOR = "export const SCHEMA_SQL = `";

const source = readFileSync(SOURCE, "utf8");
const start = source.indexOf(ANCHOR);
if (start === -1) {
  console.error(`在 ${SOURCE} 里找不到 ${ANCHOR}`);
  process.exit(1);
}

const from = start + ANCHOR.length;
const to = source.indexOf("`;", from);
if (to === -1) {
  console.error("SCHEMA_SQL 模板字符串没有正常结束");
  process.exit(1);
}

const sql = source.slice(from, to);
writeFileSync(TARGET, sql);
console.log(`${TARGET} 已同步（${sql.length} bytes）`);
