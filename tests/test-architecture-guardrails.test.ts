import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { ESLint } from "eslint";
import ts from "typescript";
import { describe, it } from "vitest";
import {
  scaffoldPluginFiles,
  THEME_TOKENS_CATALOG,
  verifyPluginDirectory,
  type PluginTemplateKind,
} from "../packages/host/src/plugin-dev-tools";
import { generatePluginTypes } from "../scripts/generate-plugin-types.mjs";
import * as UiPrimitives from "../src/components/ui";

const REPO_ROOT = resolve(__dirname, "..");
const LEGACY_STYLES_WATERMARK = 8451;

function countPhysicalLines(relPath: string): number {
  const raw = readFileSync(join(REPO_ROOT, relPath), "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
  return raw.split("\n").length;
}

function runProgrammaticTypecheck(projectDir: string): string[] {
  const configPath = join(projectDir, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    return [ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")];
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectDir);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return diagnostics.map((diag) => {
    const msg = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
    if (!diag.file || diag.start === undefined) return msg;
    const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
    return `${diag.file.fileName}:${pos.line + 1}:${pos.character + 1} - ${msg}`;
  });
}

function writeExternalPluginTsconfig(targetDir: string, pluginTypesDir: string, include: string[]): void {
  const typesRel = relative(targetDir, pluginTypesDir).replace(/\\/g, "/");
  const tsconfig = {
    extends: `${typesRel}/tsconfig.plugin.json`,
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "react/jsx-runtime": [`${typesRel}/react/jsx-runtime.d.ts`],
        "react/jsx-dev-runtime": [`${typesRel}/react/jsx-dev-runtime.d.ts`],
        "*": [`${typesRel}/*/index.d.ts`, `${typesRel}/*`],
      },
    },
    include,
  };
  writeFileSync(join(targetDir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`, "utf8");
}

describe("Phase 5: Architectural guardrails, watermarks, ESLint gates & template compilation", () => {
  it("locks legacy src/styles.css line watermark and @layer cascade ordering", () => {
    const legacyLines = countPhysicalLines("src/styles.css");
    assert.ok(
      legacyLines <= LEGACY_STYLES_WATERMARK,
      `src/styles.css grew to ${legacyLines} lines (watermark: ${LEGACY_STYLES_WATERMARK}). Place new UI styles in @layer components or plugin @scope styles.`,
    );

    const indexCss = readFileSync(join(REPO_ROOT, "src/styles/index.css"), "utf8");
    assert.match(
      indexCss,
      /@layer\s+theme,\s*base,\s*plugin-ui,\s*legacy,\s*skin,\s*components,\s*utilities\s*;/,
      "src/styles/index.css must declare the authoritative @layer order with plugin-ui strictly before legacy/skin/components/utilities",
    );
  });

  it("enforces <= 350 physical line budget across all 7 decomposed monolith entry files", () => {
    const entryBudgets = [
      "src/App.tsx",
      "src/components/PluginsSettingsPanel.tsx",
      "src/components/ModelsPage.tsx",
      "src/components/IntelligentUiCard.tsx",
      "src/components/Sidebar.tsx",
      "src/components/Message.tsx",
      "src/components/Composer.tsx",
    ];
    for (const relPath of entryBudgets) {
      const lines = countPhysicalLines(relPath);
      assert.ok(
        lines <= 350,
        `${relPath} is ${lines} physical lines (budget <= 350). Extract subcomponents or hooks into its feature folder.`,
      );
    }
  });

  it("enforces ESLint guardrail forbidding raw contribution .render() outside ErrorBoundary.tsx", async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const badCode = [
      'import type { ReactNode } from "react";',
      "export function UnsafeHost({ item }: { item: { render: (ctx: object) => ReactNode } }) {",
      "  return <div>{item.render({})}</div>;",
      "}",
      "",
    ].join("\n");

    const [badResult] = await eslint.lintText(badCode, {
      filePath: join(REPO_ROOT, "src/components/UnsafeSlotCaller.tsx"),
    });
    assert.ok(badResult, "expected lint result for virtual component");
    assert.ok(
      badResult.messages.some(
        (m) => m.ruleId === "no-restricted-syntax" && m.message.includes("<SlotEntryHost>"),
      ),
      `expected no-restricted-syntax error for raw item.render(), got: ${JSON.stringify(badResult.messages)}`,
    );

    const [allowedBoundaryResult] = await eslint.lintFiles([
      join(REPO_ROOT, "src/components/common/ErrorBoundary.tsx"),
    ]);
    assert.ok(allowedBoundaryResult);
    assert.deepEqual(allowedBoundaryResult.messages, []);
  });

  it("verifies --qj-* semantic token parity across qianji_inspect and tokens.css plus all 8 UI primitives", () => {
    const tokensCss = readFileSync(join(REPO_ROOT, "src/styles/tokens.css"), "utf8");
    const lightSplitIndex = tokensCss.indexOf(':root[data-theme="light"]');
    assert.ok(lightSplitIndex > 0, 'tokens.css must contain :root and :root[data-theme="light"] blocks');

    const rootDarkSection = tokensCss.slice(0, lightSplitIndex);
    const rootLightSection = tokensCss.slice(lightSplitIndex);

    const colorTokenGroups = [
      ...THEME_TOKENS_CATALOG.tokens.backgrounds,
      ...THEME_TOKENS_CATALOG.tokens.text,
      ...THEME_TOKENS_CATALOG.tokens.borders,
      ...THEME_TOKENS_CATALOG.tokens.brandAndStatus,
    ];
    for (const token of colorTokenGroups) {
      assert.ok(rootDarkSection.includes(`${token}:`), `missing ${token} in :root dark block of tokens.css`);
      assert.ok(
        rootLightSection.includes(`${token}:`),
        `missing ${token} in :root[data-theme="light"] block of tokens.css`,
      );
    }
    for (const token of THEME_TOKENS_CATALOG.tokens.typographyAndRadius) {
      assert.ok(rootDarkSection.includes(`${token}:`), `missing ${token} in :root block of tokens.css`);
    }

    const requiredPrimitives = [
      "Button",
      "Dialog",
      "Tabs",
      "Select",
      "Switch",
      "Input",
      "Badge",
      "Tooltip",
    ] as const;
    for (const primitive of requiredPrimitives) {
      assert.ok(
        primitive in UiPrimitives && UiPrimitives[primitive] !== undefined,
        `src/components/ui/index.ts must export ${primitive}`,
      );
    }
  });

  it("compiles all 3 skill templates and all 3 scaffold templates with zero-dependency tsc --noEmit and ClientBundleRegistry", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "qj-guardrail-templates-"));
    try {
      const pluginTypesDir = join(tempRoot, "plugin-types");
      generatePluginTypes({ repoRoot: REPO_ROOT, targetDir: pluginTypesDir });

      const templateSpecs: Array<{ kind: PluginTemplateKind; include: string[] }> = [
        { kind: "tool-only", include: ["index.ts"] },
        { kind: "ui-slot-widget", include: ["client.tsx"] },
        { kind: "fullstack-panel", include: ["index.ts", "client.tsx"] },
      ];

      for (const spec of templateSpecs) {
        // 1. Verify static template in skills/qianji-plugin-development/templates/<kind>
        const staticCopyDir = join(tempRoot, `skill-template-${spec.kind}`);
        cpSync(
          join(REPO_ROOT, "skills/qianji-plugin-development/templates", spec.kind),
          staticCopyDir,
          { recursive: true },
        );
        writeExternalPluginTsconfig(staticCopyDir, pluginTypesDir, spec.include);
        const staticDiagnostics = runProgrammaticTypecheck(staticCopyDir);
        assert.deepEqual(
          staticDiagnostics,
          [],
          `skill template "${spec.kind}" failed tsc --noEmit:\n${staticDiagnostics.join("\n")}`,
        );
        const staticVerify = await verifyPluginDirectory(staticCopyDir);
        assert.equal(
          staticVerify.ok,
          true,
          `skill template "${spec.kind}" failed verifyPluginDirectory: ${staticVerify.errors.join("; ")}`,
        );

        // 2. Verify dynamic scaffoldPluginFiles output for <kind>
        const scaffoldDir = join(tempRoot, `scaffold-${spec.kind}`);
        scaffoldPluginFiles({
          pluginId: `ci-check-${spec.kind}`,
          displayName: `CI Check ${spec.kind}`,
          template: spec.kind,
          targetDir: scaffoldDir,
          pluginTypesDir,
        });
        const scaffoldDiagnostics = runProgrammaticTypecheck(scaffoldDir);
        assert.deepEqual(
          scaffoldDiagnostics,
          [],
          `scaffoldPluginFiles("${spec.kind}") failed tsc --noEmit:\n${scaffoldDiagnostics.join("\n")}`,
        );
        const scaffoldVerify = await verifyPluginDirectory(scaffoldDir);
        assert.equal(
          scaffoldVerify.ok,
          true,
          `scaffoldPluginFiles("${spec.kind}") failed verifyPluginDirectory: ${scaffoldVerify.errors.join("; ")}`,
        );
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("ensures session Markdown export is deduplicated in WindowMenubar and StageTopbar", () => {
    const menubarSource = readFileSync(join(REPO_ROOT, "src/components/shell/WindowMenubar.tsx"), "utf8");
    const topbarSource = readFileSync(join(REPO_ROOT, "src/components/shell/StageTopbar.tsx"), "utf8");
    const appSource = readFileSync(join(REPO_ROOT, "src/App.tsx"), "utf8");

    const menubarCalls = menubarSource.match(/exportConversationMarkdown\(/g) ?? [];
    const topbarCalls = topbarSource.match(/exportConversationMarkdown\(/g) ?? [];
    assert.equal(
      menubarCalls.length,
      1,
      `WindowMenubar.tsx must invoke exportConversationMarkdown() in exactly one menu item (found ${menubarCalls.length})`,
    );
    assert.equal(
      topbarCalls.length,
      1,
      `StageTopbar.tsx must invoke exportConversationMarkdown() in exactly one menu item (found ${topbarCalls.length})`,
    );
    assert.ok(
      !menubarSource.includes("exportSessionMarkdown")
        && !topbarSource.includes("exportSessionMarkdown")
        && !appSource.includes("exportSessionMarkdown"),
      "duplicate exportSessionMarkdown handler must stay removed",
    );
  });

  it("verifies skill reference docs have zero hallucinated register* methods and type-checks reference snippets against plugin-types", async () => {
    const { ClientContributionService } = await import("../src/lib/clientContributions");
    const { CLIENT_SLOT_CATALOG } = await import("@qianji/protocol");
    const protoMethods = new Set(
      Object.getOwnPropertyNames(ClientContributionService.prototype).filter((m) => m.startsWith("register")),
    );
    for (const entry of CLIENT_SLOT_CATALOG) {
      const bareMethod = entry.method.replace(/^ctx\.contributions\./, "");
      assert.ok(
        protoMethods.has(bareMethod),
        `CLIENT_SLOT_CATALOG method "${entry.method}" does not exist on ClientContributionService.prototype`,
      );
    }

    const refFiles = [
      "skills/qianji-plugin-development/SKILL.md",
      "skills/qianji-plugin-development/references/manifest-and-host.md",
      "skills/qianji-plugin-development/references/client-slots-and-sdk.md",
      "skills/qianji-plugin-development/references/appearance-and-pets.md",
    ];
    for (const relPath of refFiles) {
      const content = readFileSync(join(REPO_ROOT, relPath), "utf8");
      for (const match of content.matchAll(/contributions\.(register[A-Za-z0-9_]+)/g)) {
        const methodName = match[1] ?? "";
        assert.ok(
          protoMethods.has(methodName),
          `${relPath} references non-existent ctx.contributions.${methodName} (real methods: ${[...protoMethods].join(", ")})`,
        );
      }
    }

    // Typecheck fenced ts/tsx code blocks in reference docs against generated plugin-types
    const tempRoot = mkdtempSync(join(tmpdir(), "qj-guardrail-doc-snippets-"));
    try {
      const pluginTypesDir = join(tempRoot, "plugin-types");
      generatePluginTypes({ repoRoot: REPO_ROOT, targetDir: pluginTypesDir });
      const snippetsDir = join(tempRoot, "snippets");
      cpSync(join(REPO_ROOT, "skills/qianji-plugin-development/templates/fullstack-panel"), snippetsDir, {
        recursive: true,
      });

      const includeFiles: string[] = [];
      let blockIdx = 0;
      for (const relPath of [
        "skills/qianji-plugin-development/references/manifest-and-host.md",
        "skills/qianji-plugin-development/references/appearance-and-pets.md",
      ]) {
        const md = readFileSync(join(REPO_ROOT, relPath), "utf8");
        for (const match of md.matchAll(/```(ts|tsx)\r?\n([\s\S]*?)```/g)) {
          const ext = match[1] === "tsx" ? "tsx" : "ts";
          const code = match[2] ?? "";
          blockIdx += 1;
          const fileName = `doc_snippet_${blockIdx}.${ext}`;
          writeFileSync(join(snippetsDir, fileName), code, "utf8");
          includeFiles.push(fileName);
        }
      }
      assert.ok(includeFiles.length >= 3, "expected at least 3 ts/tsx snippets across reference docs");
      writeExternalPluginTsconfig(snippetsDir, pluginTypesDir, includeFiles);
      const diagnostics = runProgrammaticTypecheck(snippetsDir);
      assert.deepEqual(
        diagnostics,
        [],
        `Reference doc ts/tsx snippets failed tsc --noEmit against plugin-types:\n${diagnostics.join("\n")}`,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
