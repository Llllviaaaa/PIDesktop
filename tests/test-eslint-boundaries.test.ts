import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

describe("ESLint renderer import boundaries (ADR 0005)", () => {
  const eslint = new ESLint({ cwd: repoRoot });

  async function boundaryMessages(code: string, relativeFile = "src/__boundary_probe__.ts"): Promise<string[]> {
    const results = await eslint.lintText(code, {
      filePath: resolve(repoRoot, relativeFile),
    });
    return (results[0]?.messages ?? [])
      .filter((msg) => msg.ruleId === "no-restricted-imports" || msg.ruleId === "no-restricted-syntax")
      .map((msg) => msg.message);
  }

  it("allows @pid/protocol static, dynamic, and TS inline type imports in src/", async () => {
    const code = [
      'import { redactSensitiveText, type SessionInfo } from "@pid/protocol";',
      'export const loadProtocol = () => import("@pid/protocol");',
      "export const loadProtocolTemplate = () => import(`@pid/protocol`);",
      'export type InlineSessionInfo = import("@pid/protocol").SessionInfo;',
      "export function demo(info: SessionInfo): string {",
      "  return redactSensitiveText(info.cwd);",
      "}",
      "",
    ].join("\n");
    expect(await boundaryMessages(code)).toEqual([]);
  });

  it("forbids importing any non-protocol @pid/* package, subpath, relative packages/ path, dynamic import(), or TSImportType in src/", async () => {
    const forbiddenImports = [
      'import { createHost } from "@pid/host";\nexport const x = createHost;\n',
      'import type { Session } from "@pid/session";\nexport type X = Session;\n',
      'import { PluginManager } from "@pid/kernel";\nexport const x = PluginManager;\n',
      'import * as fts from "@pid/session-search-fts";\nexport const x = fts;\n',
      'import type { SessionInfo } from "@pid/protocol/src/methods.ts";\nexport type X = SessionInfo;\n',
      'import { Sessions } from "../packages/session/src/index.ts";\nexport const x = Sessions;\n',
      'import * as protoInternals from "../packages/protocol/src/methods.ts";\nexport const x = protoInternals;\n',
      'export const loadHost = () => import("@pid/host");\n',
      "export const loadSessionTemplate = () => import(`@pid/session`);\n",
      'export const loadSubpath = () => import("@pid/protocol/src/methods.ts");\n',
      'export const loadRelativePkg = () => import("../packages/session/src/index.ts");\n',
      'export type BackendSession = import("@pid/session").Session;\n',
      'export type RelativeProto = import("../packages/protocol/src/methods.ts").SessionInfo;\n',
    ];

    for (const snippet of forbiddenImports) {
      const violations = await boundaryMessages(snippet, "src/components/__probe__.tsx");
      expect(violations.length, `expected ESLint violation for:\n${snippet}`).toBeGreaterThan(0);
    }
  });

  it("removes obsolete src-tauri/resources/*.ts rule blocks from eslint.config.js", () => {
    const configSource = readFileSync(resolve(repoRoot, "eslint.config.js"), "utf8");
    expect(configSource).not.toContain("src-tauri/resources");
  });
});
