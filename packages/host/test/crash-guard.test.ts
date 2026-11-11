import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractDataDirFromArgv,
  installHostCrashGuards,
  type ProcessEventTarget,
} from "../src/crash-guard.ts";

let tempDir = "";
afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
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

describe("Harness Host crash-guard", () => {
  it("extracts --data-dir in both separate-arg and inline forms", () => {
    expect(extractDataDirFromArgv(["--port", "0", "--data-dir", "D:/tmp/qj"])).toBe(
      resolve("D:/tmp/qj"),
    );
    expect(extractDataDirFromArgv(["--data-dir=D:/tmp/qj-inline"])).toBe(
      resolve("D:/tmp/qj-inline"),
    );
    expect(extractDataDirFromArgv(["--port", "0"])).toBeUndefined();
  });

  it("persists redacted unhandledRejection and isolated uncaughtException to disk without killing active sessions", () => {
    tempDir = mkdtempSync(join(tmpdir(), "pid-host-crash-"));
    const proc = createFakeProcess();
    const stderrChunks: string[] = [];
    const exitCodes: number[] = [];
    const fixedDate = new Date(2026, 10, 11, 10, 30, 0);

    const guard = installHostCrashGuards({
      getLogsDir: () => tempDir,
      isStarted: () => true,
      proc,
      stderr: { write: (chunk) => stderrChunks.push(chunk) },
      exit: (code) => exitCodes.push(code),
      now: () => fixedDate,
    });

    const apiKey = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz012345"].join("-");
    proc.emitRejection(new Error(`Plugin fetch failed with Authorization: Bearer ${apiKey}`));
    proc.emitException(new Error("WebSocket socket reset with password=supersecret"));

    expect(exitCodes).toEqual([]);
    const logContent = readFileSync(join(tempDir, "host-2026-11-11.log"), "utf8");
    expect(logContent).toContain("unhandledRejection:");
    expect(logContent).toContain("uncaughtException:");
    expect(logContent).toContain("[REDACTED]");
    expect(logContent).not.toContain(apiKey);
    expect(logContent).not.toContain("supersecret");
    expect(stderrChunks.join("")).not.toContain(apiKey);

    guard.dispose();
  });

  it("exits cleanly on pre-start crash, OOM error, or exception storm so supervisor can restart", () => {
    tempDir = mkdtempSync(join(tmpdir(), "pid-host-storm-"));
    const proc = createFakeProcess();
    const exitCodes: number[] = [];
    let started = false;
    let clockMs = new Date(2026, 10, 11, 12, 0, 0).getTime();

    const guard = installHostCrashGuards({
      getLogsDir: () => tempDir,
      isStarted: () => started,
      proc,
      stderr: { write: () => true },
      exit: (code) => exitCodes.push(code),
      now: () => new Date(clockMs),
      stormLimit: 4,
      stormWindowMs: 2_000,
    });

    // 1. Pre-start exception triggers immediate exit(1)
    proc.emitException(new Error("EADDRINUSE before listen"));
    expect(exitCodes).toEqual([1]);

    // 2. Once started, isolated exceptions keep Host alive until stormLimit (4 in 2s)
    started = true;
    clockMs += 5_000;
    exitCodes.length = 0;

    proc.emitException(new Error("transient 1"));
    clockMs += 100;
    proc.emitException(new Error("transient 2"));
    clockMs += 100;
    proc.emitException(new Error("transient 3"));
    expect(exitCodes).toEqual([]);

    clockMs += 100;
    proc.emitException(new Error("transient 4 trips storm breaker"));
    expect(exitCodes).toEqual([1]);

    // 3. Fatal OOM triggers immediate exit(1) even outside storm
    clockMs += 10_000;
    exitCodes.length = 0;
    proc.emitException(new Error("FATAL ERROR: JavaScript heap out of memory"));
    expect(exitCodes).toEqual([1]);

    const logContent = readFileSync(join(tempDir, "host-2026-11-11.log"), "utf8");
    expect(logContent).toContain("before host finished starting");
    expect(logContent).toContain("uncaughtException storm");
    expect(logContent).toContain("unrecoverable out-of-memory error");

    guard.dispose();
  });

  it("isolates an external plugin uncaughtException storm via circuit breaker and escalates if a quarantined plugin keeps storming", () => {
    tempDir = mkdtempSync(join(tmpdir(), "pid-host-plugin-storm-"));
    const proc = createFakeProcess();
    const exitCodes: number[] = [];
    const brokenPlugins: string[] = [];
    let quarantined = false;
    let clockMs = new Date(2026, 10, 11, 14, 0, 0).getTime();

    const guard = installHostCrashGuards({
      getLogsDir: () => tempDir,
      isStarted: () => true,
      proc,
      stderr: { write: () => true },
      exit: (code) => exitCodes.push(code),
      now: () => new Date(clockMs),
      stormLimit: 3,
      stormWindowMs: 2_000,
      onPluginError: (reason) => {
        if (reason instanceof Error && reason.message.includes("rogue-plugin")) {
          return { pluginId: "rogue-plugin", alreadyCircuitBroken: quarantined };
        }
        return undefined;
      },
      onPluginStorm: (pluginId) => {
        quarantined = true;
        brokenPlugins.push(pluginId);
      },
    });

    // First storm from external plugin circuit-breaks the plugin WITHOUT exiting Host
    proc.emitException(new Error("rogue-plugin tick 1"));
    clockMs += 50;
    proc.emitException(new Error("rogue-plugin tick 2"));
    clockMs += 50;
    proc.emitException(new Error("rogue-plugin tick 3"));

    expect(brokenPlugins).toEqual(["rogue-plugin"]);
    expect(exitCodes).toEqual([]);

    // If a leaked global timer inside the already-quarantined plugin causes a second storm, escalate to exit(1)
    clockMs += 50;
    proc.emitException(new Error("rogue-plugin leaked 1"));
    clockMs += 50;
    proc.emitException(new Error("rogue-plugin leaked 2"));
    clockMs += 50;
    proc.emitException(new Error("rogue-plugin leaked 3"));

    expect(brokenPlugins).toEqual(["rogue-plugin"]);
    expect(exitCodes).toEqual([1]);

    const logContent = readFileSync(join(tempDir, "host-2026-11-11.log"), "utf8");
    expect(logContent).toContain('plugin "rogue-plugin" triggered uncaughtException storm; circuit-breaking plugin');
    expect(logContent).toContain('circuit-broken plugin "rogue-plugin" continued uncaughtException storm; exiting for restart');

    guard.dispose();
  });
});
