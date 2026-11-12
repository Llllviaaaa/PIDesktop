import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { Context } from "@deepseek-ai/cordis";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginInfo, PluginListResult } from "@qianji/protocol";
import { ScriptedProvider, textReply } from "@qianji/testkit";
import { textOutput, type ToolEnv } from "@qianji/tools";
import { builtinPluginDefinitions, corePlugins } from "../packages/host/src/agent-plugins.ts";
import { ClientBundleRegistry } from "../packages/host/src/client-bundles.ts";
import { readEffectiveHarnessConfig } from "../packages/host/src/harness-config.ts";
import { createHost } from "../packages/host/src/host.ts";
import * as pluginDevTools from "../packages/host/src/plugin-dev-tools.ts";
import { verifyPluginDirectory } from "../packages/host/src/plugin-dev-tools.ts";
import { PluginManager } from "../packages/host/src/plugin-manager.ts";
import * as pluginsRpc from "../packages/host/src/plugins-rpc.ts";
import { startE2eHost } from "../packages/host/test/e2e-host.ts";
import observabilityClient from "../plugins/observability/client.tsx";
import {
  collectDiagnosticsSnapshot,
  loadDateLogEntries,
  localDayString,
  parseDesktopLogText,
  parseHostLogText,
} from "../plugins/observability/log-parser.ts";
import type {
  ObservabilityAckResult,
  ObservabilityExportResult,
  ObservabilityOverviewResult,
  ObservabilityQueryLogsResult,
} from "../plugins/observability/types.ts";
import { LogsTab } from "../plugins/observability/ui-logs.tsx";
import { OverviewTab } from "../plugins/observability/ui-overview.tsx";
import { PluginsHealthTab } from "../plugins/observability/ui-plugins.tsx";
import { SlotEntryHost } from "../src/components/common/ErrorBoundary.tsx";
import { PluginSlot } from "../src/components/common/PluginSlot.tsx";
import {
  ClientContributionService,
  ClientStylesService,
  clientContributions,
} from "../src/lib/clientContributions.ts";
import { tagFiberPluginId } from "../src/lib/clientPluginRuntime.ts";
import { connectHarness } from "../src/lib/harnessClient.ts";
import { HarnessRuntimes } from "../src/lib/harnessRuntime.ts";
import { useWorkbenchStore } from "../src/stores/workbenchStore.ts";

const PLUGINS_ROOT = resolve(process.cwd(), "plugins");
const OBSERVABILITY_DIR = resolve(PLUGINS_ROOT, "observability");

interface MockStyleNode {
  tagName: string;
  textContent: string;
  isConnected: boolean;
  attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  remove(): void;
}

function installMockStyleDom() {
  const headChildren: MockStyleNode[] = [];
  const head = {
    children: headChildren,
    appendChild(node: MockStyleNode) {
      if (!headChildren.includes(node)) headChildren.push(node);
      node.isConnected = true;
      return node;
    },
    querySelector(selector: string): MockStyleNode | null {
      const attrMatch = /^style\[data-qj-plugin-style="([^"]+)"\]$/.exec(selector);
      if (!attrMatch) return null;
      return headChildren.find((item) => item.attributes.get("data-qj-plugin-style") === attrMatch[1]) ?? null;
    },
  };
  const mockDoc = {
    head,
    createElement(tag: string): MockStyleNode {
      const attrs = new Map<string, string>();
      const node: MockStyleNode = {
        tagName: tag.toUpperCase(),
        textContent: "",
        isConnected: false,
        attributes: attrs,
        setAttribute(name: string, value: string) {
          attrs.set(name, value);
        },
        getAttribute(name: string) {
          return attrs.get(name) ?? null;
        },
        remove() {
          node.isConnected = false;
          const idx = headChildren.indexOf(node);
          if (idx >= 0) headChildren.splice(idx, 1);
        },
      };
      return node;
    },
    querySelectorAll(selector: string): MockStyleNode[] {
      const found = head.querySelector(selector);
      return found ? [found] : [];
    },
  };

  const prevDocument = globalThis.document;
  const prevWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).document = mockDoc;
  (globalThis as Record<string, unknown>).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };

  return {
    head,
    restore() {
      if (prevDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        globalThis.document = prevDocument;
      }
      if (prevWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = prevWindow;
      }
    },
  };
}

/** Minimal ZIP reader over local file headers (`0x04034b50`) to verify exported diagnostics archives. */
function unpackZipArchive(zipBuffer: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;
  while (offset + 4 <= zipBuffer.length) {
    const sig = zipBuffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const compression = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const nameLen = zipBuffer.readUInt16LE(offset + 26);
    const extraLen = zipBuffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = zipBuffer.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const rawSlice = zipBuffer.subarray(dataStart, dataStart + compressedSize);
    const unzipped = compression === 8 ? inflateRawSync(rawSlice) : rawSlice;
    files.set(name, unzipped.toString("utf8"));
    offset = dataStart + compressedSize;
  }
  return files;
}

describe("observability bundled official plugin", () => {
  afterEach(() => {
    clientContributions.clear();
    useWorkbenchStore.getState().resetForTest();
  });

  it("passes verifyPluginDirectory and compiles client.tsx cleanly via ClientBundleRegistry", async () => {
    const report = await verifyPluginDirectory(OBSERVABILITY_DIR);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.pluginId).toBe("observability");
    expect(report.hasHost).toBe(true);
    expect(report.hasClient).toBe(true);
    expect(report.clientBundleBytes ?? 0).toBeGreaterThan(0);

    const registry = new ClientBundleRegistry();
    const compiled = await registry.compile(
      "observability",
      OBSERVABILITY_DIR,
      join(OBSERVABILITY_DIR, "client.tsx"),
    );
    expect(compiled.etag.length).toBeGreaterThan(4);
    expect(compiled.code).toContain('window.__ModuleLoader__.load({ id: "observability"');
    expect(compiled.code).toContain("observability-status-pill");
    expect(compiled.code).toContain("observability-panel");
    expect(compiled.code).toContain("observability-slash");
  });

  it("parses RFC3339 desktop logs + UTC host logs, folds multi-line stacks, deduplicates mirrored [harness] stderr, and merges JSONL crash records", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pid-obs-parser-"));
    const logsDir = join(tempDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    try {
      const date = "2026-11-11";
      const desktopLog = [
        "2026-11-11T20:00:01.100+08:00 [desktop] session_start version=0.3.0 pid=4100",
        "2026-11-11T20:00:02.200+08:00 [harness] [I] host server listening on 127.0.0.1:19800",
        "2026-11-11T20:00:03.300+08:00 [webview] ProcessFailed label=main kind=render_process_exited(3) reason=crashed(2) exit_code=-1073741819 (0xC0000005 Access Violation) desc=\"renderer\" action=reload",
        "2026-11-11T20:00:04.400+08:00 [renderer:error] (plugin-slot:bad-widget:status.bar) TypeError: Cannot read properties of null",
        "    at BadWidget (plugins/bad-widget/client.tsx:18:7)",
        "    at SlotRenderBody (src/components/common/ErrorBoundary.tsx:43:10)",
        "2026-11-11T20:00:05.500+08:00 [panic] pid=4100 thread=main at src/lib.rs:88:9: simulated rust panic",
        "Backtrace:",
        "   0: rust_begin_unwind",
        "   1: qianji_lib::run",
        "2026-11-11T20:00:06.600+08:00 [harness] Harness Host exited unexpectedly with code -1073741819 (0xC0000005 Access Violation); scheduling restart (prior crashes in window: 0)",
      ].join("\n");

      // Note: 20:00:02.500+08:00 == 12:00:02.500Z, so this UTC entry sorts right between 20:00:02.200+08:00 and 20:00:03.300+08:00!
      const hostLog = [
        "2026-11-11T12:00:02.500Z info  [host] listening on 127.0.0.1:19800",
        "2026-11-11T12:00:04.800Z error [plugins] plugin bad-widget apply failed: ReferenceError: brokenRef is not defined",
        "    at apply (/repo/plugins/bad-widget/host.ts:12:3)",
        "    at PluginManager.mount (/repo/packages/host/src/plugin-manager.ts:1250:9)",
      ].join("\n");

      writeFileSync(join(logsDir, `desktop-${date}.log`), `${desktopLog}\n`, "utf8");
      writeFileSync(join(logsDir, `host-${date}.log`), `${hostLog}\n`, "utf8");

      writeFileSync(
        join(logsDir, "desktop-crashes.jsonl"),
        `${JSON.stringify({
          v: 1,
          id: "desk-unclean-1",
          timestamp: "2026-11-11T19:59:50+08:00",
          plane: "desktop",
          kind: "unclean_desktop_exit",
          summary: "上次桌面进程异常终止（原生闪退、驱动崩溃或被系统强制结束）",
          detail: "tail line 1\ntail line 2",
          pid: 3999,
        })}\n`,
        "utf8",
      );
      writeFileSync(
        join(logsDir, "host-crashes.jsonl"),
        `${JSON.stringify({
          v: 1,
          id: "host-reject-1",
          timestamp: "2026-11-11T12:00:07.000Z",
          plane: "host",
          kind: "unhandledRejection",
          pluginId: "bad-widget",
          summary: "(plugin:bad-widget) unhandledRejection: async crash",
          detail: "Error: async crash\n    at tick (/repo/plugins/bad-widget/host.ts:44:5)",
          pid: 4105,
        })}\n`,
        "utf8",
      );

      // Direct unit checks on desktop & host parsers
      const parsedDesktop = parseDesktopLogText(desktopLog, `desktop-${date}.log`);
      expect(parsedDesktop.find((e) => e.component === "panic")?.stack).toContain("0: rust_begin_unwind");
      expect(parsedDesktop.find((e) => e.plane === "renderer")?.pluginId).toBe("bad-widget");
      expect(parsedDesktop.find((e) => e.plane === "renderer")?.stack).toContain("at BadWidget");

      const parsedHost = parseHostLogText(hostLog, `host-${date}.log`);
      expect(parsedHost).toHaveLength(2);
      expect(parsedHost[1]?.pluginId).toBe("bad-widget");
      expect(parsedHost[1]?.stack).toContain("at apply (/repo/plugins/bad-widget/host.ts:12:3)");

      // Merged chronological order & [harness] stderr deduplication
      const deduped = loadDateLogEntries(logsDir, date, true);
      expect(deduped.some((e) => e.message.includes("server listening on 127.0.0.1:19800"))).toBe(false);
      // Desktop supervisor crash line must NEVER be dropped by mirrored-stderr deduplication
      expect(deduped.some((e) => e.message.includes("Harness Host exited unexpectedly"))).toBe(true);

      // Verify chronological epochMs sorting across +08:00 and Z
      for (let i = 1; i < deduped.length; i += 1) {
        const prev = deduped[i - 1];
        const curr = deduped[i];
        expect((curr?.epochMs ?? 0) >= (prev?.epochMs ?? 0)).toBe(true);
      }

      const unDeduped = loadDateLogEntries(logsDir, date, false);
      expect(unDeduped.length).toBe(deduped.length + 1);

      // Snapshot incident timeline & pluginErrorCounts
      const snap = collectDiagnosticsSnapshot(logsDir, {
        dedupeMirroredStderr: true,
        liveEntries: [],
        now: new Date("2026-11-11T12:05:00Z"),
      });
      const kinds = snap.recentIncidents.map((inc) => inc.kind);
      expect(kinds).toContain("unclean_desktop_exit");
      expect(kinds).toContain("unhandledRejection");
      expect(kinds).toContain("rust_panic");
      expect(kinds).toContain("webview_process_failed");
      expect(kinds).toContain("harness_unexpected_exit");
      expect((snap.pluginErrorCounts["bad-widget"] ?? 0)).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("mounts automatically from bundledPluginsDirs as active builtin and serves RPCs, observability_inspect tool, /logs command, and redacted .zip export", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pid-obs-bundled-data-"));
    const workspace = mkdtempSync(join(tmpdir(), "pid-obs-bundled-ws-"));
    const logsDir = join(dataDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(workspace, "README.md"), "# Observability E2E Workspace\n", "utf8");

    const today = localDayString();
    const fakeApiKey = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    const fakeBearer = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz987654"].join("-");

    writeFileSync(
      join(dataDir, "harness.json"),
      `${JSON.stringify({ logLevel: "info", leakedHeader: `Bearer ${fakeBearer}` }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(logsDir, `desktop-${today}.log`),
      [
        `${today}T09:00:01.000+08:00 [desktop] session_start version=0.3.0 pid=5001`,
        `${today}T09:00:02.000+08:00 [harness] [I] host duplicate mirrored line`,
        `${today}T09:00:03.000+08:00 [renderer:error] (plugin-load:broken-demo) SyntaxError: Unexpected token`,
        `    at evaluateBundle (clientPluginRuntime.ts:510:11)`,
        `${today}T09:00:04.000+08:00 [harness] Harness Host exited unexpectedly with code -1073741819 (0xC0000005 Access Violation); scheduling restart (prior crashes in window: 0)`,
      ].join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      join(logsDir, `host-${today}.log`),
      [
        `${today}T01:00:01.500Z info  [host] booted`,
        `${today}T01:00:03.500Z error [plugins] plugin broken-demo apply failed with key ${fakeApiKey}`,
        `    at apply (/plugins/broken-demo/host.ts:9:5)`,
      ].join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      join(logsDir, "desktop-crashes.jsonl"),
      `${JSON.stringify({
        v: 1,
        id: "crash-desk-1",
        timestamp: `${today}T00:59:00.000Z`,
        plane: "desktop",
        kind: "unclean_desktop_exit",
        summary: "上次桌面进程异常终止（原生闪退、驱动崩溃或被系统强制结束）",
        detail: `last log line token=${fakeApiKey}`,
        pid: 4900,
      })}\n`,
      "utf8",
    );
    writeFileSync(
      join(logsDir, "host-crashes.jsonl"),
      `${JSON.stringify({
        v: 1,
        id: "crash-host-1",
        timestamp: `${today}T01:00:05.000Z`,
        plane: "host",
        kind: "uncaughtException",
        pluginId: "broken-demo",
        summary: "(plugin:broken-demo) uncaughtException: Worker exploded",
        detail: `Error: Worker exploded (${fakeBearer})\n    at run (/plugins/broken-demo/host.ts:22:7)`,
        pid: 5002,
      })}\n`,
      "utf8",
    );

    const token = Buffer.alloc(32, 7).toString("base64url");
    const pageOrigin = "http://localhost:1420";
    const defaultModel = () => ({ provider: "scripted", model: "m" });
    let reload: () => Promise<string[]> = async () => [];
    const managerRef: { current?: PluginManager } = {};

    const host = createHost({
      version: "0.3.0-e2e",
      dataDir,
      plugins: corePlugins(),
    });
    await host.start();

    const pluginManager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.3.0-e2e",
      bundledPluginsDirs: [PLUGINS_ROOT],
      builtins: (trustedWorkspace) =>
        builtinPluginDefinitions(
          dataDir,
          readEffectiveHarnessConfig(dataDir, trustedWorkspace).config,
          {
            scheduler: { defaultModel },
            gateway: {
              pageOrigins: [pageOrigin],
              token,
              defaultModel,
              manager: () => managerRef.current,
              reload: () => reload(),
            },
          },
        ),
      onChanged: (payload) => host.ctx.get("rpc")?.broadcast("plugin/changed", payload),
      onTrustChanged: (payload) => host.ctx.get("rpc")?.broadcast("workspace/trustChanged", payload),
    });
    managerRef.current = pluginManager;
    await host.ctx.plugin(pluginsRpc, { manager: pluginManager });
    await host.ctx.plugin(pluginDevTools, { manager: () => managerRef.current });
    reload = () => pluginManager.sync({ reason: "reloaded" });
    await pluginManager.sync();

    // Register a temporary failing tool to verify live `tools/result` failure capture
    host.ctx.tools.register({
      name: "simulated_failing_tool",
      description: "Simulated failing tool for observability test",
      readOnly: true,
      parameters: { type: "object", properties: {} },
      async execute() {
        return textOutput(`tool failed with secret ${fakeApiKey}`, true);
      },
    });

    const port = await host.ctx.webServer.listen(0);
    const baseUrl = `http://127.0.0.1:${port}/`;
    const runtimes = new HarnessRuntimes(
      () => connectHarness({ baseUrl, token }, { name: "obs-e2e", version: "1" }),
      [20],
    );

    try {
      // (d) Verify automatic builtin discovery from `bundledPluginsDirs: [resolve("plugins")]`
      const listed = await runtimes.call<PluginListResult>("plugin.list", { workspace });
      const obsPlugin = listed.plugins.find((p) => p.id === "observability");
      expect(obsPlugin).toBeDefined();
      expect(obsPlugin?.tier).toBe("builtin");
      expect(obsPlugin?.status).toBe("active");
      expect(obsPlugin?.enabled).toBe(true);
      expect(obsPlugin?.removable).toBe(false);
      expect(obsPlugin?.hasHost).toBe(true);
      expect(obsPlugin?.hasClient).toBe(true);
      expect(obsPlugin?.error).toBeUndefined();
      expect(obsPlugin?.clientError).toBeUndefined();
      expect(obsPlugin?.clientPath).toBe("/plugins/observability/client.js");

      // Verify compiled client bundle is served over HTTP with zero errors
      const bundleResp = await fetch(new URL("/plugins/observability/client.js", baseUrl));
      expect(bundleResp.status).toBe(200);
      const bundleJs = await bundleResp.text();
      expect(bundleJs).toContain("observability-panel");

      // Trigger simulated tool failure so `recentToolIssues` & `toolFailuresSession` populate
      const toolEnv: ToolEnv = {
        sessionId: "test-session",
        cwd: workspace,
        signal: new AbortController().signal,
      };
      const failOut = await host.ctx.tools.execute(
        { id: "call-fail-1", name: "simulated_failing_tool", args: {} },
        toolEnv,
      );
      expect(failOut.isError).toBe(true);

      // (b.1) `observability.overview`
      const overview = await runtimes.call<ObservabilityOverviewResult>("observability.overview", {});
      expect(overview.host.version).toBe("0.3.0-e2e");
      expect(overview.host.logsDir).toBe(logsDir);
      expect(overview.lastAckedAt).toBeNull();
      expect(overview.counts.unackedCrashes).toBeGreaterThanOrEqual(2);
      expect(overview.counts.totalIncidents).toBeGreaterThanOrEqual(2);
      expect(overview.counts.errorLogsToday).toBeGreaterThanOrEqual(2);
      expect(overview.counts.toolFailuresSession).toBe(1);
      expect(overview.pluginErrorCounts["broken-demo"] ?? 0).toBeGreaterThanOrEqual(2);
      expect(overview.recentToolIssues).toHaveLength(1);
      expect(overview.recentToolIssues[0]?.toolName).toBe("simulated_failing_tool");
      expect(overview.recentToolIssues[0]?.preview).toContain("[REDACTED]");
      expect(overview.recentToolIssues[0]?.preview).not.toContain(fakeApiKey);

      // (b.2) `observability.queryLogs` — deduplication, stack folding & `pluginId` filtering
      const logsDeduped = await runtimes.call<ObservabilityQueryLogsResult>("observability.queryLogs", {
        date: today,
        dedupeMirroredStderr: true,
      });
      expect(logsDeduped.availableDates).toContain(today);
      expect(logsDeduped.entries.some((e) => e.message.includes("duplicate mirrored line"))).toBe(false);
      expect(logsDeduped.entries.some((e) => e.message.includes("Harness Host exited unexpectedly"))).toBe(true);

      const logsWithMirrored = await runtimes.call<ObservabilityQueryLogsResult>("observability.queryLogs", {
        date: today,
        dedupeMirroredStderr: false,
      });
      expect(logsWithMirrored.entries.some((e) => e.message.includes("duplicate mirrored line"))).toBe(true);

      const pluginFiltered = await runtimes.call<ObservabilityQueryLogsResult>("observability.queryLogs", {
        date: today,
        pluginId: "broken-demo",
      });
      expect(pluginFiltered.entries.length).toBeGreaterThanOrEqual(2);
      expect(pluginFiltered.entries.every((e) => e.pluginId === "broken-demo")).toBe(true);
      expect(pluginFiltered.entries.some((e) => (e.stack ?? "").includes("evaluateBundle"))).toBe(true);
      expect(pluginFiltered.entries.some((e) => (e.stack ?? "").includes("/plugins/broken-demo/host.ts"))).toBe(true);

      // (b.3) `observability.ackIncidents` clears unackedCrashes
      const ackRes = await runtimes.call<ObservabilityAckResult>("observability.ackIncidents", {});
      expect(ackRes.acknowledgedAt.length).toBeGreaterThan(10);
      const afterAck = await runtimes.call<ObservabilityOverviewResult>("observability.overview", {});
      expect(afterAck.lastAckedAt).toBe(ackRes.acknowledgedAt);
      expect(afterAck.counts.unackedCrashes).toBe(0);

      // (b.4) `observability.exportDiagnostics` writes a valid redacted `.zip`
      const exported = await runtimes.call<ObservabilityExportResult>("observability.exportDiagnostics", {});
      expect(existsSync(exported.path)).toBe(true);
      expect(exported.sizeBytes).toBeGreaterThan(100);
      expect(exported.files).toContain("about.json");
      expect(exported.files).toContain("harness.json");
      expect(exported.files).toContain(`logs/desktop-${today}.log`);
      expect(exported.files).toContain(`logs/host-${today}.log`);
      expect(exported.files).toContain("logs/desktop-crashes.jsonl");
      expect(exported.files).toContain("logs/host-crashes.jsonl");

      const archiveEntries = unpackZipArchive(readFileSync(exported.path));
      expect(JSON.parse(archiveEntries.get("about.json") ?? "{}")).toMatchObject({
        host: { version: "0.3.0-e2e" },
      });
      for (const content of archiveEntries.values()) {
        expect(content).not.toContain(fakeApiKey);
        expect(content).not.toContain(fakeBearer);
      }
      expect(archiveEntries.get("harness.json")).toContain("[REDACTED]");
      expect(archiveEntries.get("logs/desktop-crashes.jsonl")).toContain("[REDACTED]");
      expect(archiveEntries.get("logs/host-crashes.jsonl")).toContain("[REDACTED]");

      // (c.1) Read-only Agent tool `observability_inspect`
      const inspectDef = host.ctx.tools.get("observability_inspect");
      expect(inspectDef).toBeDefined();
      expect(inspectDef?.readOnly).toBe(true);

      const crashesToolOut = await host.ctx.tools.execute(
        { id: "t-crashes", name: "observability_inspect", args: { topic: "crashes", pluginId: "broken-demo" } },
        toolEnv,
      );
      expect(crashesToolOut.isError).toBeFalsy();
      const crashesJson = JSON.parse(
        crashesToolOut.content[0]?.type === "text" ? crashesToolOut.content[0].text : "{}",
      ) as { matchedCount: number; incidents: Array<{ pluginId?: string }> };
      expect(crashesJson.matchedCount).toBeGreaterThanOrEqual(1);
      expect(crashesJson.incidents[0]?.pluginId).toBe("broken-demo");

      const pluginsToolOut = await host.ctx.tools.execute(
        { id: "t-plugins", name: "observability_inspect", args: { topic: "plugins" } },
        toolEnv,
      );
      const pluginsJson = JSON.parse(
        pluginsToolOut.content[0]?.type === "text" ? pluginsToolOut.content[0].text : "{}",
      ) as {
        livePluginsAvailable: boolean;
        allPlugins: Array<{ id?: string; status?: string }>;
        pluginErrorCounts: Record<string, number>;
      };
      expect(pluginsJson.livePluginsAvailable).toBe(true);
      expect(pluginsJson.allPlugins.some((p) => p.id === "observability" && p.status === "active")).toBe(true);
      expect(pluginsJson.pluginErrorCounts["broken-demo"] ?? 0).toBeGreaterThanOrEqual(2);

      const toolsTopicOut = await host.ctx.tools.execute(
        { id: "t-tools", name: "observability_inspect", args: { topic: "tools" } },
        toolEnv,
      );
      const toolsJson = JSON.parse(
        toolsTopicOut.content[0]?.type === "text" ? toolsTopicOut.content[0].text : "{}",
      ) as { toolFailuresSession: number; matchedCount: number };
      expect(toolsJson.toolFailuresSession).toBe(1);
      expect(toolsJson.matchedCount).toBe(1);

      // (c.2) `/logs` slash command execution via HarnessRuntimes
      const commands = await runtimes.commands(workspace);
      expect(commands.some((cmd) => cmd.name === "logs" && cmd.source === "plugin")).toBe(true);

      const { runtimeId } = await runtimes.start(workspace);
      const defaultSlash = await runtimes.runCommand(runtimeId, "logs", "");
      expect(defaultSlash.handled).toBe(true);
      expect(defaultSlash.output).toContain("系统可观测与诊断概览");

      const crashesSlash = await runtimes.runCommand(runtimeId, "logs", "crashes");
      expect(crashesSlash.handled).toBe(true);
      expect(crashesSlash.output).toContain("闪退与异常取证报告");
      expect(crashesSlash.output).toContain("unclean_desktop_exit");

      const pluginsSlash = await runtimes.runCommand(runtimeId, "logs", "plugins");
      expect(pluginsSlash.handled).toBe(true);
      expect(pluginsSlash.output).toContain("插件健康诊断摘要");
      expect(pluginsSlash.output).toContain("broken-demo");

      const searchSlash = await runtimes.runCommand(runtimeId, "logs", "Access Violation");
      expect(searchSlash.handled).toBe(true);
      expect(searchSlash.output).toContain("Access Violation");
    } finally {
      runtimes.close();
      await pluginManager.dispose();
      await host.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("also installs and runs cleanly inside startE2eHost with ScriptedProvider", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pid-obs-e2ehost-"));
    const token = Buffer.alloc(32, 5).toString("base64url");
    const provider = new ScriptedProvider([textReply("诊断完成。")]);
    const e2eHost = await startE2eHost({
      dataDir,
      pageOrigin: "http://localhost:1420",
      token,
      provider,
    });
    const runtimes = new HarnessRuntimes(
      () => connectHarness({ baseUrl: e2eHost.baseUrl, token }, { name: "obs-start-e2e", version: "1" }),
      [20],
    );

    try {
      const installRes = await runtimes.call<{ plugin?: PluginInfo }>("plugin.install", {
        channel: "local",
        spec: OBSERVABILITY_DIR,
        link: true,
      });
      expect(installRes.plugin?.id).toBe("observability");
      expect(installRes.plugin?.status).toBe("active");
      expect(installRes.plugin?.clientError).toBeUndefined();

      const overview = await runtimes.call<ObservabilityOverviewResult>("observability.overview", {});
      expect(overview.host.dataDir).toBe(dataDir);
    } finally {
      runtimes.close();
      await e2eHost.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("mounts observability-client in <PluginSlot> and <SlotEntryHost> without Hook/ErrorBoundary errors and cleans up on fiber.dispose()", async () => {
    const env = installMockStyleDom();
    try {
      const root = new Context();
      await root.plugin(ClientContributionService, clientContributions);
      await root.plugin(ClientStylesService);

      root.on("internal/plugin", (createdFiber: object) => {
        tagFiberPluginId(createdFiber, "observability");
      });

      const fiber = await root.plugin(observabilityClient);

      // 1. Scoped CSS injected under `@layer plugin-ui { @scope ([data-qj-plugin="observability"]) }`
      const styleNode = env.head.querySelector('style[data-qj-plugin-style="observability"]');
      expect(styleNode).not.toBeNull();
      expect(styleNode?.textContent).toContain("@layer plugin-ui");
      expect(styleNode?.textContent).toContain('@scope ([data-qj-plugin="observability"])');

      // 2. Render `status.bar` pill through `<PluginSlot>`
      const statusBarHtml = renderToStaticMarkup(
        createElement(PluginSlot, {
          name: "status.bar",
          align: "right",
          context: { cwd: "/workspace/demo", sessionFile: null },
        }),
      );
      expect(statusBarHtml).toContain('data-qj-plugin="observability"');
      expect(statusBarHtml).toContain('data-testid="observability-status-pill"');
      expect(statusBarHtml).toContain("观测");
      expect(statusBarHtml).not.toContain("plugin-slot-fallback-");

      // 3. Render `rightWorkbenchTabs` `"observability-panel"` through `<SlotEntryHost>`
      const snap = clientContributions.getSnapshot();
      const panelTab = snap.rightWorkbenchTabs.find((tab) => tab.id === "observability-panel");
      expect(panelTab).toBeDefined();
      expect(panelTab?.label).toBe("可观测");
      if (panelTab === undefined) {
        throw new Error("Expected observability-panel rightWorkbenchTab to be registered");
      }

      const slotContext = { cwd: "/workspace/demo", sessionFile: null };

      const panelHtml = renderToStaticMarkup(
        <SlotEntryHost
          entry={panelTab}
          context={slotContext}
          slotName="rightWorkbenchTabs"
        />,
      );
      expect(panelHtml).toContain('data-qj-plugin="observability"');
      expect(panelHtml).toContain('data-testid="observability-panel"');
      expect(panelHtml).toContain("概览与闪退");
      expect(panelHtml).toContain("三端日志");
      expect(panelHtml).toContain("插件健康");
      expect(panelHtml).not.toContain("plugin-slot-fallback-");

      // 4. Render sub-views with rich telemetry data to verify zero SSR/Hook issues
      const populatedOverviewHtml = renderToStaticMarkup(
        createElement(OverviewTab, {
          loading: false,
          error: null,
          onRefresh: async () => undefined,
          onOpenPluginLogs: () => undefined,
          overview: {
            host: {
              version: "0.3.0",
              protocolVersion: "1",
              startedAt: "2026-11-11T12:00:00Z",
              uptimeMs: 125_000,
              pid: 4242,
              memoryRssBytes: 128 * 1024 * 1024,
              heapUsedBytes: 64 * 1024 * 1024,
              dataDir: "/tmp/qj",
              logsDir: "/tmp/qj/logs",
            },
            logFiles: [{ name: "desktop-2026-11-11.log", sizeBytes: 2048, updatedAt: "2026-11-11T12:01:00Z" }],
            counts: {
              unackedCrashes: 1,
              totalIncidents: 1,
              errorLogsToday: 3,
              warnLogsToday: 1,
              toolFailuresSession: 1,
            },
            pluginErrorCounts: { "bad-plugin": 2 },
            recentIncidents: [
              {
                v: 1,
                id: "inc-1",
                timestamp: "2026-11-11T12:00:30Z",
                plane: "desktop",
                kind: "unclean_desktop_exit",
                summary: "上次桌面进程异常终止",
                detail: "0xC0000005 Access Violation",
              },
            ],
            recentToolIssues: [
              {
                id: "ti-1",
                timestamp: "2026-11-11T12:00:40Z",
                toolName: "bash",
                durationMs: 6200,
                isError: true,
                preview: "Exit code 1",
              },
            ],
            lastAckedAt: null,
          },
        }),
      );
      expect(populatedOverviewHtml).toContain("上次异常闪退");
      expect(populatedOverviewHtml).toContain("发送给 AI 诊断");

      const populatedLogsHtml = renderToStaticMarkup(
        createElement(LogsTab, {
          defaultTailLines: 200,
          defaultDedupeStderr: true,
          autoRefreshMs: 3000,
          pluginIdFilter: "bad-plugin",
          onPluginIdFilterChange: () => undefined,
        }),
      );
      expect(populatedLogsHtml).toContain("插件过滤: bad-plugin");

      const populatedPluginsHtml = renderToStaticMarkup(
        createElement(PluginsHealthTab, {
          cwd: "/workspace/demo",
          loading: false,
          error: null,
          pluginErrorCounts: { "bad-plugin": 4 },
          onRefreshAll: async () => undefined,
          onOpenPluginLogs: () => undefined,
          plugins: [
            {
              id: "bad-plugin",
              name: "Bad Plugin",
              version: "1.0.0",
              tier: "user",
              enabled: true,
              status: "errored",
              overridesBuiltin: false,
              removable: true,
              watch: false,
              hasHost: true,
              hasClient: true,
              error: "Error: Host apply boom\n    at host.ts:4:1",
              clientError: {
                phase: "render",
                etag: "e1",
                message: "Render crashed",
                stack: "at BadComp (client.tsx:9:3)",
              },
              config: {},
            },
          ],
        }),
      );
      expect(populatedPluginsHtml).toContain("Bad Plugin");
      expect(populatedPluginsHtml).toContain("清除渲染熔断");
      expect(populatedPluginsHtml).toContain("AI 修复诊断");

      // 5. Verify `/logs` and `/obs` bare slash interceptor opens `observability-panel`
      const slash = snap.slashInterceptors.find((item) => item.id === "observability-slash");
      expect(slash).toBeDefined();
      expect(slash?.onSlashCommand("logs", "crash", slotContext)).toBe(false);
      expect(slash?.onSlashCommand("unknown", "", slotContext)).toBe(false);
      expect(slash?.onSlashCommand("logs", "", slotContext)).toBe(true);
      expect(useWorkbenchStore.getState().rightOpen).toBe(true);
      expect(useWorkbenchStore.getState().activeTab).toBe("observability-panel");

      useWorkbenchStore.getState().resetForTest();
      expect(slash?.onSlashCommand("obs", "   ", slotContext)).toBe(true);
      expect(useWorkbenchStore.getState().activeTab).toBe("observability-panel");

      // 6. Disposing the plugin fiber removes all slot entries and scoped <style> cleanly
      await fiber.dispose();
      const afterDispose = clientContributions.getSnapshot();
      expect(afterDispose.statusBarItems.find((i) => i.id === "observability-status-pill")).toBeUndefined();
      expect(afterDispose.rightWorkbenchTabs.find((i) => i.id === "observability-panel")).toBeUndefined();
      expect(afterDispose.slashInterceptors.find((i) => i.id === "observability-slash")).toBeUndefined();
      expect(env.head.querySelector('style[data-qj-plugin-style="observability"]')).toBeNull();
    } finally {
      env.restore();
    }
  });
});
