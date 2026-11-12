/**
 * File-size ratchet for the renderer (src/) and the Harness packages
 * (packages/<name>/src). A new file stays within FILE_LINE_BUDGET physical
 * lines. Files that were already larger when the ratchet was introduced are
 * listed in OVERSIZED_CEILINGS and may not grow past their ceiling. Once a
 * file shrinks well below its ceiling, the ceiling has to come down with it,
 * so the reduction cannot quietly grow back.
 *
 * This complements the stricter budgets in test-architecture-guardrails
 * (<= 350 lines for the 7 shell entry files) and ESLint max-lines (400
 * non-blank lines in the modular component folders).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..");
const FILE_LINE_BUDGET = 500;
/** How far below its ceiling a file may drop before the ceiling must be lowered. */
const RATCHET_SLACK = 50;

/** Physical line counts on 2026-11-12. Lower these as the files get split; never raise them. */
const OVERSIZED_CEILINGS: Record<string, number> = {
  "packages/host/src/plugin-manager.ts": 1229,
  "packages/host/src/plugin-dev-tools.ts": 623,
  "src/lib/intelligentUi.ts": 533,
  "src/lib/clientPluginRuntime.ts": 636,
  "src/lib/harnessRuntime.ts": 858,
  "packages/protocol/src/methods.ts": 865,
  "packages/browser/src/driver.ts": 860,
  "packages/protocol/src/self-guard.ts": 849,
  "src/components/SideChatPanel.tsx": 789,
  "packages/mcp/src/index.ts": 760,
  "packages/mcp/src/client.ts": 682,
  "packages/host/src/client-bundles.ts": 657,
  "packages/host/src/agent-plugins.ts": 644,
  "src/store/runtime.ts": 625,
  "src/stores/workbenchStore.ts": 581,
  "packages/prompt-context/src/index.ts": 569,
  "src/components/ModelPicker.tsx": 522,
  "src/types.ts": 501,
  "packages/permissions/src/rules.ts": 501,
};

function countPhysicalLines(absolutePath: string): number {
  return readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const roots = [
  join(REPO_ROOT, "src"),
  ...readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(REPO_ROOT, "packages", entry.name, "src")),
];

const SIZES = new Map(
  roots.flatMap(sourceFiles).map((file) => [relative(REPO_ROOT, file).split(sep).join("/"), countPhysicalLines(file)] as const),
);

describe("source file size ratchet", () => {
  it(`keeps new files within ${FILE_LINE_BUDGET} lines and listed files within their ceilings`, () => {
    const violations: string[] = [];
    for (const [file, lines] of SIZES) {
      const ceiling = OVERSIZED_CEILINGS[file] ?? FILE_LINE_BUDGET;
      if (lines > ceiling) {
        violations.push(
          file in OVERSIZED_CEILINGS
            ? `${file}: ${lines} lines, above its ceiling of ${ceiling}; split it instead of growing it`
            : `${file}: ${lines} lines, above the ${FILE_LINE_BUDGET}-line budget; split it into smaller modules`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("lowers ceilings as files shrink, and drops entries that no longer need one", () => {
    const stale: string[] = [];
    for (const [file, ceiling] of Object.entries(OVERSIZED_CEILINGS)) {
      const lines = SIZES.get(file);
      if (lines === undefined) stale.push(`${file}: no longer exists; remove its entry`);
      else if (lines <= FILE_LINE_BUDGET) stale.push(`${file}: ${lines} lines, within the budget; remove its entry`);
      else if (ceiling - lines > RATCHET_SLACK) stale.push(`${file}: ${lines} lines; lower its ceiling from ${ceiling} to ${lines}`);
    }
    expect(stale).toEqual([]);
  });
});
