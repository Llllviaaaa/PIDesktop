import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedProvider, textReply } from "@qianji/testkit";
import { ClientBundleRegistry } from "../packages/host/src/client-bundles.ts";
import { corePlugins } from "../packages/host/src/agent-plugins.ts";
import { applyDesktopMessage, resolveDesktopBundledPluginRoots } from "../packages/host/src/control.ts";
import { createHost } from "../packages/host/src/host.ts";
import { PluginManager } from "../packages/host/src/plugin-manager.ts";
import { startE2eHost } from "../packages/host/test/e2e-host.ts";
import {
  estimateTextTokens,
  inferContextWindow,
  type SessionUsageInspectResult,
} from "../plugins/session-usage/host.ts";
import {
  formatApproxTokens,
  formatContextCapacity,
  formatCurrencyAmount,
  formatDuration,
  formatTps,
  formatTtft,
} from "../plugins/session-usage/client.tsx";
import { connectHarness } from "../src/lib/harnessClient";
import { HARNESS_SESSION_PREFIX, HarnessRuntimes } from "../src/lib/harnessRuntime";
import type { TranscriptEvent } from "../src/lib/transcript";

const SESSION_USAGE_DIR = resolve(process.cwd(), "plugins", "session-usage");

describe("session-usage official plugin", () => {
  it("compiles plugins/session-usage/client.tsx cleanly via ClientBundleRegistry", async () => {
    const registry = new ClientBundleRegistry();
    const compiled = await registry.compile(
      "session-usage",
      SESSION_USAGE_DIR,
      join(SESSION_USAGE_DIR, "client.tsx"),
    );
    expect(compiled.etag.length).toBeGreaterThan(4);
    expect(compiled.code).toContain('window.__ModuleLoader__.load({ id: "session-usage"');
    expect(compiled.code).toContain("session-usage:cost");
    expect(compiled.code).toContain("session-usage:ring");
    expect(compiled.code).toContain("session-usage:slash");
  });

  it("formats DSH-style tokens, context capacities, durations, TTFT, TPS, and CNY/USD costs accurately", () => {
    expect(estimateTextTokens("检查一下当前板端 trace 状态")).toBeGreaterThan(6);
    expect(inferContextWindow("gemini-2.5-pro")).toBe(1_000_000);
    expect(inferContextWindow("kimi-k3.1-pro")).toBe(256_000);
    expect(inferContextWindow("claude-sonnet-4-6")).toBe(200_000);

    expect(formatApproxTokens(0)).toBe("0");
    expect(formatApproxTokens(5_120)).toBe("~5.1K");
    expect(formatApproxTokens(21_610)).toBe("~21.6K");
    expect(formatApproxTokens(155_200)).toBe("~155K");
    expect(formatContextCapacity(1_000_000)).toBe("1M");
    expect(formatContextCapacity(1_048_576)).toBe("1M");
    expect(formatContextCapacity(262_144)).toBe("256K");

    expect(formatDuration((259 * 60 + 5) * 1_000, false)).toBe("259分5秒");
    expect(formatTtft(7_120)).toBe("7.1秒");
    expect(formatTps(43.2)).toBe("43 tok/s");
    expect(formatCurrencyAmount(20.634, "CNY", 7.25)).toBe("¥149.6");
    expect(formatCurrencyAmount(20.634, "USD", 7.25)).toBe("$20.6");
  });

  it("loads session-usage directly as builtin from bundled-plugins and cleans unmodified legacy .seeded-session-usage-v1 copies", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pid-su-seed-data-"));
    const fakeInstallRoot = mkdtempSync(join(tmpdir(), "pid-su-seed-exe-"));
    const host = createHost({
      version: "0.0.0-test",
      dataDir,
      plugins: corePlugins(),
    });
    await host.start();
    try {
      const bundledRoot = join(fakeInstallRoot, "harness", "bundled-plugins");
      const bundledTarget = join(bundledRoot, "session-usage");
      mkdirSync(bundledTarget, { recursive: true });
      cpSync(SESSION_USAGE_DIR, bundledTarget, { recursive: true });
      const fakeExe = join(fakeInstallRoot, "qianji.exe");
      writeFileSync(fakeExe, "");

      // 1) Fresh boot does not copy files into <dataDir>/plugins/session-usage;
      //    PluginManager loads session-usage directly as a read-only builtin plugin.
      const freshNotes = applyDesktopMessage(dataDir, {
        settings: {},
        configDir: dataDir,
        executable: fakeExe,
      });
      expect(freshNotes.some((note) => note.includes("seeded bundled plugin"))).toBe(false);
      expect(existsSync(join(dataDir, "plugins", "session-usage", "package.json"))).toBe(false);

      const roots = resolveDesktopBundledPluginRoots(fakeExe);
      const manager = new PluginManager(host.ctx, {
        dataDir,
        version: "0.0.0-test",
        bundledPluginsDirs: roots,
      });
      await manager.sync();
      const plugins = await manager.list();
      const builtinEntry = plugins.find((plugin) => plugin.id === "session-usage");
      expect(builtinEntry?.tier).toBe("builtin");
      expect(builtinEntry?.enabled).toBe(true);
      expect(builtinEntry?.removable).toBe(false);
      expect(builtinEntry?.clientPath).toBe("/plugins/session-usage/client.js");
      await manager.dispose();

      // 2) An unmodified legacy .seeded-session-usage-v1 copy is cleaned up automatically.
      const legacyDir = join(dataDir, "plugins", "session-usage");
      cpSync(SESSION_USAGE_DIR, legacyDir, { recursive: true });
      writeFileSync(join(dataDir, "plugins", ".seeded-session-usage-v1"), "1");
      const cleanupNotes = applyDesktopMessage(dataDir, {
        settings: {},
        configDir: dataDir,
        executable: fakeExe,
      });
      expect(cleanupNotes.some((note) => note.includes("cleaned unmodified legacy seeded plugin session-usage"))).toBe(true);
      expect(existsSync(join(legacyDir, "package.json"))).toBe(false);
      expect(existsSync(join(dataDir, "plugins", ".seeded-session-usage-v1"))).toBe(false);

      // 3) A user-modified copy under <dataDir>/plugins/session-usage is preserved.
      cpSync(SESSION_USAGE_DIR, legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "host.ts"), "// user customized\n");
      writeFileSync(join(dataDir, "plugins", ".seeded-session-usage-v1"), "1");
      const preserveNotes = applyDesktopMessage(dataDir, {
        settings: {},
        configDir: dataDir,
        executable: fakeExe,
      });
      expect(preserveNotes.some((note) => note.includes("preserved user-modified plugin session-usage"))).toBe(true);
      expect(existsSync(join(legacyDir, "package.json"))).toBe(true);
    } finally {
      await host.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(fakeInstallRoot, { recursive: true, force: true });
    }
  });

  it("tracks context breakdown, TTFT, TPS, cache hit rate, CNY cost, and /usage command end-to-end", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pid-su-data-"));
    const workspace = mkdtempSync(join(tmpdir(), "pid-su-work-"));
    writeFileSync(join(workspace, "README.md"), "# Demo Project\n");

    const provider = new ScriptedProvider(
      [
        textReply("第一轮回复：已检查板端采集进程与 trace 状态。", {
          inputTokens: 4_500,
          cacheReadTokens: 145_500,
          cacheWriteTokens: 0,
          outputTokens: 420,
        }),
        textReply("第二轮回复：已保存暂停进度到 PAUSE.md。", {
          inputTokens: 5_000,
          cacheReadTokens: 150_000,
          cacheWriteTokens: 0,
          outputTokens: 380,
        }),
      ],
      { chunkDelayMs: 12 },
    );

    const token = Buffer.alloc(32, 9).toString("base64url");
    const e2eHost = await startE2eHost({
      dataDir,
      pageOrigin: "http://localhost:1420",
      token,
      provider,
    });

    const runtimes = new HarnessRuntimes(
      () => connectHarness({ baseUrl: e2eHost.baseUrl, token }, { name: "su-test", version: "1" }),
      [20],
    );

    try {
      const installRes = await runtimes.call<{ plugin?: { id: string; status: string } }>("plugin.install", {
        channel: "local",
        spec: SESSION_USAGE_DIR,
        link: false,
      });
      expect(installRes.plugin?.id).toBe("session-usage");
      expect(installRes.plugin?.status).toBe("active");

      // 1) Pre-session draft inspection reports baseline system prompt + tool definitions overhead.
      const draftInspect = await runtimes.call<SessionUsageInspectResult>("sessionUsage.inspect", {
        cwd: workspace,
        provider: "scripted",
        model: "kimi-k3-1-pro",
        contextWindowHint: 1_000_000,
      });
      expect(draftInspect.hasSession).toBe(false);
      expect(draftInspect.context.contextWindow).toBe(1_000_000);
      expect(draftInspect.context.systemTokens).toBeGreaterThan(0);
      expect(draftInspect.context.toolTokens).toBeGreaterThan(0);
      expect(draftInspect.context.messageTokens).toBe(0);
      expect(draftInspect.context.usedTokens).toBe(
        draftInspect.context.systemTokens + draftInspect.context.toolTokens,
      );

      // 2) Start a session with a priced model (`kimi-k3-1-pro`) and run 2 turns.
      const events: TranscriptEvent[] = [];
      const waiters: Array<() => void> = [];
      runtimes.subscribe((_id, event) => {
        events.push(event);
        for (const w of waiters.splice(0)) w();
      });
      const waitTurnEnd = async () => {
        for (;;) {
          if (events.some((ev) => ev.type === "turn-end")) {
            events.length = 0;
            return;
          }
          await new Promise<void>((res) => waiters.push(res));
        }
      };

      const { runtimeId } = await runtimes.start(workspace);
      await runtimes.setModel(runtimeId, "scripted", "kimi-k3-1-pro");

      await runtimes.prompt(runtimeId, { message: "检查当前开发板 trace 状态", images: [] });
      await waitTurnEnd();

      await runtimes.prompt(runtimeId, { message: "保存进度并准备断电", images: [] });
      await waitTurnEnd();

      const sessionFile = runtimes.sessionFileOf(runtimeId);
      const sessionId = sessionFile && sessionFile.startsWith(HARNESS_SESSION_PREFIX)
        ? sessionFile.slice(HARNESS_SESSION_PREFIX.length)
        : "";
      expect(sessionId.length).toBeGreaterThan(0);

      const inspected = await runtimes.call<SessionUsageInspectResult>("sessionUsage.inspect", {
        sessionId,
        cwd: workspace,
        contextWindowHint: 1_000_000,
      });

      expect(inspected.hasSession).toBe(true);
      expect(inspected.sessionId).toBe(sessionId);
      expect(inspected.context.contextWindow).toBe(1_000_000);
      expect(inspected.context.systemTokens).toBeGreaterThan(0);
      expect(inspected.context.toolTokens).toBeGreaterThan(0);
      expect(inspected.context.messageTokens).toBeGreaterThan(100_000);
      expect(inspected.context.usedTokens).toBe(
        inspected.context.systemTokens + inspected.context.toolTokens + inspected.context.messageTokens,
      );
      expect(inspected.context.percent).toBe(16);

      // Total prompt tokens across 2 turns: (4500 + 145500) + (5000 + 150000) = 305000; cacheRead = 295500 -> 97%!
      expect(inspected.telemetry.turnCount).toBe(2);
      expect(inspected.telemetry.cacheHitPercent).toBe(97);
      expect(inspected.telemetry.activeDurationMs).toBeGreaterThan(15);
      expect(inspected.telemetry.avgTtftMs).not.toBeNull();
      expect(inspected.telemetry.avgTtftMs ?? 0).toBeGreaterThanOrEqual(1);
      expect(inspected.telemetry.outputTps).not.toBeNull();
      expect(inspected.telemetry.outputTps ?? 0).toBeGreaterThan(0);
      expect(inspected.telemetry.costUsd).toBeGreaterThan(0);
      expect(inspected.telemetry.totalCostUsd).toBeCloseTo(inspected.telemetry.costUsd, 6);

      // 3) Child subagent sessions roll up into `totalCostUsd` while keeping `costUsd` as main session cost.
      const subSession = await e2eHost.host.ctx.sessions.create({
        cwd: workspace,
        parent: { sessionId, callId: "sub-call-1" },
      });
      subSession.append("model", { provider: "scripted", model: "kimi-k3-1-pro" });
      subSession.append("assistant", {
        model: { provider: "scripted", model: "kimi-k3-1-pro" },
        content: [{ type: "text", text: "子代理已完成日志扫描。" }],
        stop: "stop",
        usage: { inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });

      const withSubagent = await runtimes.call<SessionUsageInspectResult>("sessionUsage.inspect", {
        sessionId,
        cwd: workspace,
        contextWindowHint: 1_000_000,
      });
      expect(withSubagent.telemetry.subagentCount).toBe(1);
      expect(withSubagent.telemetry.subagentCostUsd).toBeGreaterThan(0);
      expect(withSubagent.telemetry.totalCostUsd).toBeCloseTo(
        withSubagent.telemetry.costUsd + withSubagent.telemetry.subagentCostUsd,
        6,
      );

      // 4) `/usage` command is registered and emits a localized Markdown telemetry report.
      const commands = await runtimes.commands(workspace);
      expect(commands.some((cmd) => cmd.name === "usage" && cmd.source === "plugin")).toBe(true);
      const slashRes = await runtimes.runCommand(runtimeId, "usage", "print");
      expect(slashRes.handled).toBe(true);
      expect(slashRes.output).toContain("上下文已用");
      expect(slashRes.output).toContain("系统提示词");
      expect(slashRes.output).toContain("工具定义");
      expect(slashRes.output).toContain("对话消息");
      expect(slashRes.output).toContain("总用时");
      expect(slashRes.output).toContain("首 token 平均 (TTFT)");
      expect(slashRes.output).toContain("输出速度 (TPS)");
      expect(slashRes.output).toContain("97%");
      expect(slashRes.output).toContain("¥");
    } finally {
      runtimes.close();
      await e2eHost.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
