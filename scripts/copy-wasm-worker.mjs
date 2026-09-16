// worker 入口是纯 JS（理由见文件头注释），tsc 不会把它拷进 dist —— 这里补上。
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SOURCE = "src/extensions/wasm/worker-entry.js";
const TARGET = "dist/extensions/wasm/worker-entry.js";

mkdirSync(dirname(TARGET), { recursive: true });
copyFileSync(SOURCE, TARGET);
console.log(`已拷贝 ${SOURCE} → ${TARGET}`);
