import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 架构边界 —— 这些规矩靠人记是记不住的，用测试钉住。
 *
 * 1. Core 不认识扩展（wasm 宿主是扩展，不是 Core）
 * 2. 包的默认入口不导出扩展
 * 3. 运行时零依赖（src/ 里只能 import node: 内置模块和相对路径）
 */

const root = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  walk(join(root, "src"));
  return out.sort();
}

describe("架构边界", () => {
  it("Core 里没有任何一行 import 扩展目录", () => {
    const offenders = sourceFiles()
      .filter((file) => !file.includes("/extensions/"))
      .filter((file) => /from\s+"[^"]*extensions\//.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file));

    expect(offenders).toEqual([]);
  });

  it("默认入口不导出 wasm 宿主（它是 @catease/workflow/wasm 子路径）", () => {
    const index = readFileSync(join(root, "src/index.ts"), "utf8");
    expect(index).not.toMatch(/extensions\/wasm/);
    expect(index).not.toMatch(/wasm/i);
  });

  it("src/ 里只能 import node: 内置模块与相对路径 —— 运行时零依赖", () => {
    const external: string[] = [];

    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm)) {
        const specifier = match[1] ?? "";
        if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
        external.push(`${relative(root, file)} → ${specifier}`);
      }
    }

    expect(external).toEqual([]);
  });

  it("src/ 里不出现业务词与厂商标（Core 不认识业务）", () => {
    // 只禁「项目名 / 厂商名」。示例里出现 email / approval / order 这种通用业务词是正常的 ——
    // 例子总得有个领域，但 Core 不该知道任何具体产品。
    const banned = [
      "IntakeOps",
      "Intake",
      "Lead",
      "Slack",
      "Resend",
      "HubSpot",
      "OpenAI",
      "Stripe",
      "Twilio",
      "SendGrid",
      "n8n",
    ];
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const word of banned) {
        const pattern = new RegExp(`\\b${word}\\b`, "i");
        if (pattern.test(text)) offenders.push(`${relative(root, file)} → ${word}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("package.json 里没有 dependencies / peerDependencies", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it("wasm 子路径已经导出（第三方接入的入口）", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports ?? {})).toContain("./wasm");
  });
});
