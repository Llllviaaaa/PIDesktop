import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { Commands } from "@qianji/commands";
import type { PluginClientBundleResult, PluginInfo } from "@qianji/protocol";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import {
  installHostCrashGuards,
  writeHostCrashEntrySync,
  type HostCrashRecord,
  type ProcessEventTarget,
} from "../packages/host/src/crash-guard.ts";
import { diagnosticsEntries } from "../packages/host/src/diagnostics.ts";
import { createHost, type Host } from "../packages/host/src/host.ts";
import { logFileExporter } from "../packages/host/src/log-file.ts";
import { PluginManager } from "../packages/host/src/plugin-manager.ts";
import { RpcGateway } from "../packages/host/src/rpc.ts";
import { WebServer } from "../packages/host/src/web-server.ts";
import {
  createClientPluginRuntime,
  getClientPluginErrors,
  type ModuleLoaderGlobal,
} from "../src/lib/clientPluginRuntime.ts";
import { CrashLogLimiter } from "../src/lib/crashLogger.ts";

let tempRoot = "";
let host: Host | undefined;
let manager: PluginManager | undefined;

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  await host?.stop();
  host = undefined;
  if (tempRoot !== "") {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

function createFakeProcess(): ProcessEventTarget & {
  emitRejection(reason: unknown): void;
  emitException(error: Error): void;
} {
  const emitter = new EventEmitter();
  return {
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    emitRejection: (reason) => emitter.emit("unhandledRejection", reason, Promise.resolve()),
    emitException: (error) => emitter.emit("uncaughtException", error, "uncaughtException"),
  };
}

function parseJsonlRecords(raw: string): HostCrashRecord[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as HostCrashRecord);
}

describe("3-plane telemetry & plugin error persistence", () => {
  it("writes redacted HostCrashRecord JSONL with plugin attribution, prunes oversized crash files, and circuit-breaks unhandledRejection storms", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pid-telemetry-crash-guard-"));
    const logsDir = join(tempRoot, "logs");
    const proc = createFakeProcess();
    const exitCodes: number[] = [];
    const stormedPlugins: string[] = [];
    const attributedErrors: Array<{ pluginId: string; kind: string }> = [];
    let clockMs = new Date(2026, 10, 11, 14, 0, 0).getTime();

    const secretKey = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz012345"].join("-");

    const guard = installHostCrashGuards({
      getLogsDir: () => logsDir,
      isStarted: () => true,
      proc,
      stderr: { write: () => true },
      exit: (code) => exitCodes.push(code),
      now: () => new Date(clockMs),
      stormLimit: 3,
      stormWindowMs: 10_000,
      onPluginError: (reason, kind) => {
        const text = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason);
        if (!text.includes("noisy-reject-plugin")) return undefined;
        attributedErrors.push({ pluginId: "noisy-reject-plugin", kind });
        return { pluginId: "noisy-reject-plugin" };
      },
      onPluginStorm: (pluginId) => {
        stormedPlugins.push(pluginId);
      },
    });

    for (let idx = 0; idx < 3; idx += 1) {
      clockMs += 200;
      proc.emitRejection(
        new Error(`noisy-reject-plugin async failure #${idx} Authorization: Bearer ${secretKey}`),
      );
    }

    expect(exitCodes).toEqual([]);
    expect(attributedErrors).toHaveLength(3);
    expect(stormedPlugins).toEqual(["noisy-reject-plugin"]);

    const hostLog = readFileSync(join(logsDir, "host-2026-11-11.log"), "utf8");
    expect(hostLog).toContain("unhandledRejection (plugin:noisy-reject-plugin):");
    expect(hostLog).toContain('plugin "noisy-reject-plugin" triggered unhandledRejection storm; circuit-breaking plugin');
    expect(hostLog).toContain("[REDACTED]");
    expect(hostLog).not.toContain(secretKey);

    const crashRecords = parseJsonlRecords(readFileSync(join(logsDir, "host-crashes.jsonl"), "utf8"));
    expect(crashRecords).toHaveLength(3);
    expect(crashRecords[0]).toMatchObject({
      v: 1,
      plane: "host",
      kind: "unhandledRejection",
      pluginId: "noisy-reject-plugin",
      pid: process.pid,
    });
    expect(crashRecords[0]?.summary).toContain("(plugin:noisy-reject-plugin)");
    expect(crashRecords[0]?.summary).not.toContain(secretKey);
    expect(crashRecords[0]?.detail).not.toContain(secretKey);

    guard.dispose();

    // Verify bounded pruning (~200 lines) when host-crashes.jsonl exceeds maxCrashFileBytes
    const pruneLogsDir = join(tempRoot, "prune-logs");
    for (let i = 0; i < 245; i += 1) {
      writeHostCrashEntrySync(
        pruneLogsDir,
        "startupFailure",
        new Error(`startup crash #${i}`),
        new Date(2026, 10, 11, 15, 0, 0),
        "host",
        { exitCode: 1, maxCrashFileBytes: 1_024 },
      );
    }
    const pruned = parseJsonlRecords(readFileSync(join(pruneLogsDir, "host-crashes.jsonl"), "utf8"));
    expect(pruned.length).toBeLessThanOrEqual(200);
    expect(pruned.at(-1)?.summary).toContain("startup crash #244");
    expect(pruned.at(-1)?.exitCode).toBe(1);
  });

  it("persists Host plugin stacks, ClientBundleRegistry compile errors, and deduplicated reportClientError entries", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pid-telemetry-plugins-"));
    const dataDir = join(tempRoot, "data");
    const logsDir = join(dataDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    const fixedDate = new Date(2026, 10, 11, 16, 0, 0);
    const exporter = logFileExporter(logsDir, { now: () => fixedDate });

    host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        [WebServer, { pageOrigins: ["http://tauri.localhost"] }],
        [RpcGateway, { token: "a".repeat(32) }],
        [Sessions],
        [Ui],
        [Tools],
        [Commands],
        [SystemPrompt],
      ],
    });
    host.ctx.logger.exporter(exporter);
    await host.start();

    manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.3.0-test",
    });
    await manager.sync();

    const secretToken = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz987654"].join("-");

    // 1. Host plugin throwing inside apply() preserves stack in PluginInfo.error & logs
    const applyCrashDir = join(tempRoot, "apply-crash-plugin");
    mkdirSync(applyCrashDir, { recursive: true });
    writeFileSync(
      join(applyCrashDir, "package.json"),
      JSON.stringify({
        name: "apply-crash-plugin",
        version: "1.0.0",
        pid: {
          id: "apply-crash-plugin",
          name: "Apply Crash Plugin",
          host: "./host.ts",
        },
      }),
    );
    writeFileSync(
      join(applyCrashDir, "host.ts"),
      `
        function nestedApplyBoom() {
          throw new Error("apply failed with token=${secretToken}");
        }
        export function apply() {
          nestedApplyBoom();
        }
      `,
    );

    const applyInstalled = await manager.install({ channel: "local", spec: applyCrashDir, link: true });
    expect(applyInstalled.plugin?.status).toBe("errored");
    expect(applyInstalled.plugin?.error).toContain("apply failed");
    expect(applyInstalled.plugin?.error).toContain("nestedApplyBoom");
    expect(applyInstalled.plugin?.error).not.toContain(secretToken);

    // 2. Host plugin throwing during top-level module evaluation preserves stack
    const importCrashDir = join(tempRoot, "import-crash-plugin");
    mkdirSync(importCrashDir, { recursive: true });
    writeFileSync(
      join(importCrashDir, "package.json"),
      JSON.stringify({
        name: "import-crash-plugin",
        version: "1.0.0",
        pid: {
          id: "import-crash-plugin",
          name: "Import Crash Plugin",
          host: "./host.ts",
        },
      }),
    );
    writeFileSync(
      join(importCrashDir, "host.ts"),
      `
        function topLevelEvalCrash() {
          throw new Error("module evaluation exploded");
        }
        topLevelEvalCrash();
        export function apply() {}
      `,
    );

    const importInstalled = await manager.install({ channel: "local", spec: importCrashDir, link: true });
    expect(importInstalled.plugin?.status).toBe("errored");
    expect(importInstalled.plugin?.error).toContain("module evaluation exploded");
    expect(importInstalled.plugin?.error).toContain("topLevelEvalCrash");

    // 3. Client bundle compile failure logs via [plugins] logger
    const brokenClientDir = join(tempRoot, "broken-client-plugin");
    mkdirSync(brokenClientDir, { recursive: true });
    writeFileSync(
      join(brokenClientDir, "package.json"),
      JSON.stringify({
        name: "broken-client-plugin",
        version: "1.0.0",
        pid: {
          id: "broken-client-plugin",
          name: "Broken Client Plugin",
          client: "./client.tsx",
        },
      }),
    );
    writeFileSync(
      join(brokenClientDir, "client.tsx"),
      "export default { apply() { const broken = ; } };",
    );

    const brokenClientInstalled = await manager.install({ channel: "local", spec: brokenClientDir, link: true });
    expect(brokenClientInstalled.plugin?.status).toBe("errored");
    expect(brokenClientInstalled.plugin?.error).toBeTruthy();

    // 4. Valid client plugin reporting load/render errors deduplicates disk logs per (id, phase, etag, message)
    const validClientDir = join(tempRoot, "render-err-plugin");
    mkdirSync(validClientDir, { recursive: true });
    writeFileSync(
      join(validClientDir, "package.json"),
      JSON.stringify({
        name: "render-err-plugin",
        version: "1.0.0",
        pid: {
          id: "render-err-plugin",
          name: "Render Error Plugin",
          client: "./client.tsx",
        },
      }),
    );
    writeFileSync(
      join(validClientDir, "client.tsx"),
      "export default { name: 'render-err-plugin', apply() {} };",
    );

    const validInstalled = await manager.install({ channel: "local", spec: validClientDir, link: true });
    const etag = validInstalled.plugin?.clientEtag ?? "etag-1";

    for (let repeat = 0; repeat < 4; repeat += 1) {
      await manager.reportClientError("render-err-plugin", {
        phase: "render",
        etag,
        message: "Cannot read properties of undefined (reading 'map')",
        stack: "TypeError: Cannot read properties of undefined\n    at BadWidget (client.tsx:12:8)",
      });
    }

    // Clearing client error resets deduplication so a subsequent recurrence is logged again
    await manager.clearClientError("render-err-plugin");
    await manager.reportClientError("render-err-plugin", {
      phase: "render",
      etag,
      message: "Cannot read properties of undefined (reading 'map')",
      stack: "TypeError: Cannot read properties of undefined\n    at BadWidget (client.tsx:12:8)",
    });

    await exporter.close();

    const diskLog = readFileSync(join(logsDir, "host-2026-11-11.log"), "utf8");
    expect(diskLog).toContain("nestedApplyBoom");
    expect(diskLog).not.toContain(secretToken);
    expect(diskLog).toContain("topLevelEvalCrash");
    expect(diskLog).toContain("plugin=broken-client-plugin client bundle compile failed");

    const renderErrorMatches = diskLog.match(
      /\[client:render\] plugin=render-err-plugin: Cannot read properties of undefined/g,
    );
    expect(renderErrorMatches).toHaveLength(2);
    expect(diskLog).toContain("at BadWidget (client.tsx:12:8)");
  });

  it("includes redacted .jsonl crash journals alongside .log files in diagnosticsEntries", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pid-telemetry-diag-"));
    const logsDir = join(tempRoot, "logs");
    mkdirSync(logsDir, { recursive: true });

    const apiKey = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz555555"].join("-");
    writeFileSync(join(logsDir, "desktop-2026-11-11.log"), "[desktop] session_start version=0.3.0\n");
    writeFileSync(
      join(logsDir, "desktop-crashes.jsonl"),
      `${JSON.stringify({
        v: 1,
        id: "1-100",
        timestamp: "2026-11-11T10:00:00Z",
        plane: "desktop",
        kind: "unclean_desktop_exit",
        summary: `leaked ${apiKey}`,
      })}\n`,
    );
    writeFileSync(
      join(logsDir, "host-crashes.jsonl"),
      `${JSON.stringify({
        v: 1,
        id: "2-200",
        timestamp: "2026-11-11T10:01:00Z",
        plane: "host",
        kind: "uncaughtException",
        pluginId: "bad-plugin",
        summary: "boom password=topsecret",
      })}\n`,
    );
    writeFileSync(join(logsDir, "desktop-lifecycle.json"), JSON.stringify({ cleanExit: false }));

    const entries = diagnosticsEntries(tempRoot, { host: { version: "0.3.0-test" } });
    const names = entries.map((entry) => entry.name);
    expect(names).toEqual([
      "about.json",
      "logs/desktop-2026-11-11.log",
      "logs/desktop-crashes.jsonl",
      "logs/host-crashes.jsonl",
    ]);

    const desktopCrashText = entries
      .find((entry) => entry.name === "logs/desktop-crashes.jsonl")
      ?.data.toString("utf8");
    const hostCrashText = entries
      .find((entry) => entry.name === "logs/host-crashes.jsonl")
      ?.data.toString("utf8");

    expect(desktopCrashText).toContain("[REDACTED]");
    expect(desktopCrashText).not.toContain(apiKey);
    expect(hostCrashText).toContain("[REDACTED]");
    expect(hostCrashText).not.toContain("topsecret");
  });

  it("forwards client plugin activation failures to reportFrontendError even when Host RPC is unreachable", async () => {
    const root = new Context();
    const targetGlobal: { __ModuleLoader__?: ModuleLoaderGlobal } = {};
    const frontendPayloads: Array<{
      level: "error" | "warn";
      source: string;
      message: string;
      stack?: string;
    }> = [];

    const brokenPlugin: PluginInfo = {
      id: "offline-broken-ui",
      name: "Offline Broken UI",
      version: "1.0.0",
      tier: "user",
      enabled: true,
      status: "active",
      overridesBuiltin: false,
      removable: true,
      watch: false,
      hasHost: false,
      hasClient: true,
      clientEtag: "etag-broken-1",
      config: {},
    };

    const runtime = createClientPluginRuntime(root, {
      targetGlobal,
      modules: {
        "@deepseek-ai/cordis": async () => ({ Context }),
        react: async () => React,
        "react/jsx-runtime": async () => jsxRuntime,
      },
      frontendErrorLimiter: new CrashLogLimiter(),
      frontendErrorSink: async (payload) => {
        frontendPayloads.push(payload);
      },
      executeScript: async (_code) => {
        targetGlobal.__ModuleLoader__?.load({
          id: "offline-broken-ui",
          factory() {
            function clientBootExplosion(): never {
              throw new Error("Failed to initialize widget store");
            }
            return {
              default: {
                name: "offline-broken-ui",
                apply() {
                  clientBootExplosion();
                },
              },
            };
          },
        });
      },
      transport: {
        list: async () => [brokenPlugin],
        clientBundle: async (): Promise<PluginClientBundleResult> => ({
          notModified: false,
          etag: "etag-broken-1",
          code: "/* mocked */",
        }),
        reportClientError: async () => {
          throw new Error("WebSocket RPC disconnected");
        },
        onChanged: () => () => undefined,
        onTrustChanged: () => () => undefined,
      },
    });

    await runtime.sync();
    // Re-syncing unchanged broken ETag should not spam duplicate frontend error logs
    await runtime.sync();

    expect(getClientPluginErrors()["offline-broken-ui"]).toContain("Failed to initialize widget store");
    expect(frontendPayloads).toHaveLength(1);
    expect(frontendPayloads[0]).toMatchObject({
      level: "error",
      source: "plugin-load:offline-broken-ui",
      message: "Failed to initialize widget store",
    });
    expect(frontendPayloads[0]?.stack).toContain("clientBootExplosion");

    await runtime.dispose();
  });
});
