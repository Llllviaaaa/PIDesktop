import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcGateway, WebServer, createHost, type Host } from "@qianji/host";
import { openWorkbenchTab } from "../src/sdk";
import { formatShortcutChord } from "../src/components/SettingsModal";
import { sanitizePreviewUrl } from "../src/components/workbench/BrowserPreviewTab";
import { agent } from "../src/lib/agent";
import { clientContributions } from "../src/lib/clientContributions";
import { ensureClientPluginRuntime } from "../src/lib/clientPluginBootstrap";
import { deriveTurnPlans } from "../src/lib/envSources";
import { connectHarness } from "../src/lib/harnessClient";
import { HarnessRuntimes } from "../src/lib/harnessRuntime";
import {
  deriveSessionIntelligentUis,
  messageMayContainIntelligentUi,
} from "../src/lib/intelligentUi";
import {
  SIDEBAR_NARROW_BREAKPOINT,
  SIDEBAR_PINNED_KEY,
  isCollapsibleNarrowViewport,
  readStoredSidebarPinned,
  resolveEffectiveSidebarVisible,
  writeStoredSidebarPinned,
} from "../src/lib/panelLayout";
import { sessionEditedPaths } from "../src/lib/sessionEdits";
import { groupTranscriptMessages } from "../src/lib/transcriptTurns";
import { useAppStore } from "../src/store";
import { useIntelligentUiStore } from "../src/stores/intelligentUiStore";
import {
  applyWorkbenchOpenNotification,
  matchesWorkbenchFileCwd,
  resolveWorkspaceActiveFilePath,
  useWorkbenchStore,
} from "../src/stores/workbenchStore";
import type { TranscriptEvent } from "../src/lib/transcript";
import type { ExtensionUIRequest, UiMessage } from "../src/types";

const token = Buffer.alloc(32, 7).toString("base64url");
let host: Host | undefined;
let hungServer: Server | undefined;
const hungSockets = new Set<Socket>();

afterEach(async () => {
  useWorkbenchStore.getState().resetForTest();
  vi.restoreAllMocks();
  await host?.stop();
  host = undefined;
  for (const sock of hungSockets) {
    sock.destroy();
  }
  hungSockets.clear();
  if (hungServer) {
    await new Promise<void>((resolve) => hungServer?.close(() => resolve()));
    hungServer = undefined;
  }
});

describe("Sidebar Persistence, Minimize Guard & Reversible Narrow Viewport", () => {
  it("ignores Windows 0x0 / degenerate minimize bounds and only collapses below 760px", () => {
    expect(isCollapsibleNarrowViewport(0, 0)).toBe(false);
    expect(isCollapsibleNarrowViewport(0, 900)).toBe(false);
    expect(isCollapsibleNarrowViewport(1280, 0)).toBe(false);
    expect(isCollapsibleNarrowViewport(-10, 800)).toBe(false);
    expect(isCollapsibleNarrowViewport(Number.NaN, 800)).toBe(false);

    expect(isCollapsibleNarrowViewport(SIDEBAR_NARROW_BREAKPOINT, 800)).toBe(true);
    expect(isCollapsibleNarrowViewport(640, 480)).toBe(true);

    // 800px-900px split-screen and DPI-scaled windows keep the sidebar docked.
    expect(isCollapsibleNarrowViewport(SIDEBAR_NARROW_BREAKPOINT + 1, 800)).toBe(false);
    expect(isCollapsibleNarrowViewport(840, 900)).toBe(false);
    expect(isCollapsibleNarrowViewport(1440, 900)).toBe(false);

    // High uiScale (`zoom`) reduces effective layout width (`width / scale`).
    expect(isCollapsibleNarrowViewport(900, 800, 1.25)).toBe(true); // 900 / 1.25 = 720 <= 760
    expect(isCollapsibleNarrowViewport(1000, 800, 1.25)).toBe(false); // 1000 / 1.25 = 800 > 760
    expect(isCollapsibleNarrowViewport(900, 800, 0)).toBe(false); // invalid scale safely falls back to 1
  });

  it("keeps floating preview transition-free in @layer components and overrides legacy <=900px absolute positioning", () => {
    const motionCss = readFileSync(resolve(__dirname, "../src/styles/motion.css"), "utf8");
    const skinShellCss = readFileSync(resolve(__dirname, "../src/styles/skin-shell.css"), "utf8");

    expect(motionCss).toContain('.codex-shot .primary-sidebar-panel[data-sidebar-panel-state="pinned"]');
    expect(motionCss).toContain('.codex-shot .primary-sidebar-panel:not([data-sidebar-panel-state="pinned"])');
    expect(skinShellCss).toMatch(
      /\.codex-shot\s+\.primary-sidebar-panel\s*>\s*\.sidebar\.codex-sidebar\s*\{[^}]*position:\s*relative;[^}]*inset:\s*auto;/s,
    );
  });

  it("keeps tauri unstable multiwebview disabled in Cargo.toml and capabilities so Windows minimize preserves WebView2 bounds", () => {
    const cargoToml = readFileSync(resolve(__dirname, "../src-tauri/Cargo.toml"), "utf8");
    const tauriLib = readFileSync(resolve(__dirname, "../src-tauri/src/lib.rs"), "utf8");
    const defaultCapability = readFileSync(
      resolve(__dirname, "../src-tauri/capabilities/default.json"),
      "utf8",
    );

    expect(cargoToml).not.toMatch(/tauri\s*=\s*\{[^}]*"unstable"/);
    expect(tauriLib).not.toContain("browser_webview_action");
    expect(defaultCapability).not.toContain("core:webview:allow-create-webview");
  });

  it("formats valid shortcut chords for Settings recorder and guards capture-phase global shortcuts while recording", () => {
    expect(formatShortcutChord({ key: "b", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe("Ctrl+Shift+B");
    expect(formatShortcutChord({ key: "s", ctrlKey: false, metaKey: false, altKey: true, shiftKey: false })).toBe("Alt+S");
    expect(formatShortcutChord({ key: "f9", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe("F9");
    expect(formatShortcutChord({ key: " ", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe("Ctrl+Space");

    // Modifier-only presses and plain typing keys are ignored so typing/focus navigation cannot be hijacked.
    expect(formatShortcutChord({ key: "Control", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(formatShortcutChord({ key: "Shift", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })).toBeNull();
    expect(formatShortcutChord({ key: "b", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(formatShortcutChord({ key: "Enter", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBeNull();

    const settingsSource = readFileSync(resolve(__dirname, "../src/components/settings/AppearanceSettingsPage.tsx"), "utf8");
    const effectsSource = readFileSync(resolve(__dirname, "../src/components/shell/useAppearanceAndShellEffects.ts"), "utf8");
    const modelPickerSource = readFileSync(resolve(__dirname, "../src/components/ModelPicker.tsx"), "utf8");
    expect(settingsSource).toContain("shortcutToggleSidebar");
    expect(effectsSource).toContain('[data-shortcut-recorder="true"]');
    expect(modelPickerSource).toContain('if (customInputOpen || levelsOpen === "keyboard") return;');
  });

  it("reversibly restores effective visibility when returning from narrow to wide viewport", () => {
    // Pinned user preference: narrow -> temporarily hidden; wide again -> automatically visible.
    expect(resolveEffectiveSidebarVisible(true, false)).toBe(true);
    expect(resolveEffectiveSidebarVisible(true, true)).toBe(false);
    expect(resolveEffectiveSidebarVisible(true, false)).toBe(true);

    // Explicitly unpinned by user: stays hidden even on wide viewports.
    expect(resolveEffectiveSidebarVisible(false, true)).toBe(false);
    expect(resolveEffectiveSidebarVisible(false, false)).toBe(false);
  });

  it("persists sidebarPinned in storage and falls back to true when unset, malformed, or blocked", () => {
    const map = new Map<string, string>();
    let blocked = false;
    const storage = {
      getItem(key: string) {
        if (blocked) throw new Error("storage blocked");
        return map.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (blocked) throw new Error("storage blocked");
        map.set(key, value);
      },
    };

    expect(readStoredSidebarPinned(storage)).toBe(true);

    writeStoredSidebarPinned(false, storage);
    expect(map.get(SIDEBAR_PINNED_KEY)).toBe("0");
    expect(readStoredSidebarPinned(storage)).toBe(false);

    writeStoredSidebarPinned(true, storage);
    expect(map.get(SIDEBAR_PINNED_KEY)).toBe("1");
    expect(readStoredSidebarPinned(storage)).toBe(true);

    map.set(SIDEBAR_PINNED_KEY, "false");
    expect(readStoredSidebarPinned(storage)).toBe(false);

    map.set(SIDEBAR_PINNED_KEY, "corrupt-value");
    expect(readStoredSidebarPinned(storage)).toBe(true);

    blocked = true;
    expect(readStoredSidebarPinned(storage)).toBe(true);
    expect(() => writeStoredSidebarPinned(false, storage)).not.toThrow();
  });
});

describe("Cross-Workspace Workbench Isolation, Line Nonce & Tab Normalization", () => {
  it("isolates same-named relative buffers across workspaces and prevents cross-workspace save overwrite", async () => {
    vi.spyOn(agent, "readWorkspaceFile").mockImplementation(async (cwd, path) => ({
      path,
      fileName: path.split("/").pop() ?? path,
      text: `disk(${cwd}):${path}`,
      size: 24,
      truncated: false,
      isBinary: false,
    }));
    const writeSpy = vi.spyOn(agent, "writeWorkspaceFile").mockResolvedValue(undefined);

    const projA = "D:\\Workspaces\\ProjectA";
    const projB = "D:\\Workspaces\\ProjectB";

    await useWorkbenchStore.getState().openFile(projA, "package.json");
    useWorkbenchStore.getState().updateFileContent("package.json", '{"name":"dirty-a"}', projA);

    // Attempting to save package.json under ProjectB when only ProjectA has it open MUST NOT write to ProjectB!
    const wrongSave = await useWorkbenchStore.getState().saveFile(projB, "package.json");
    expect(wrongSave).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();

    // Opening package.json in ProjectB loads ProjectB's own copy without clobbering ProjectA's dirty buffer.
    await useWorkbenchStore.getState().openFile(projB, "package.json");
    const files = useWorkbenchStore.getState().openFiles;
    expect(files).toHaveLength(2);
    expect(
      files.find((item) => matchesWorkbenchFileCwd(item.cwd, projA))?.content,
    ).toBe('{"name":"dirty-a"}');
    expect(
      files.find((item) => matchesWorkbenchFileCwd(item.cwd, projB))?.content,
    ).toBe(`disk(${projB}):package.json`);

    // Saving ProjectA writes strictly to ProjectA.
    const savedA = await useWorkbenchStore.getState().saveFile(projA, "package.json");
    expect(savedA).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith(projA, "package.json", '{"name":"dirty-a"}');

    // Empty targetCwd does not leak workspace-scoped buffers, and resolveWorkspaceActiveFilePath isolates per workspace.
    expect(matchesWorkbenchFileCwd(projA, "")).toBe(false);
    expect(matchesWorkbenchFileCwd(undefined, projA)).toBe(true);
    expect(resolveWorkspaceActiveFilePath(useWorkbenchStore.getState(), "D:\\Workspaces\\ProjectC")).toBeNull();
    expect(resolveWorkspaceActiveFilePath(useWorkbenchStore.getState(), projA)).toBe("package.json");
  });

  it("increments lineNonce when re-opening an already-open file at the same line number and when disk content grows", async () => {
    let diskLines = 30;
    vi.spyOn(agent, "readWorkspaceFile").mockImplementation(async () => ({
      path: "src/index.ts",
      fileName: "index.ts",
      text: "const x = 1;\n".repeat(diskLines),
      size: diskLines * 13,
      truncated: false,
      isBinary: false,
    }));

    const cwd = "D:\\Workspaces\\ProjectA";
    await useWorkbenchStore.getState().openFile(cwd, "src/index.ts:20");
    const firstNonce = useWorkbenchStore.getState().openFiles[0]?.lineNonce ?? 0;
    expect(useWorkbenchStore.getState().openFiles[0]?.line).toBe(20);
    expect(firstNonce).toBeGreaterThan(0);

    await useWorkbenchStore.getState().openFile(cwd, "src/index.ts:20");
    const secondNonce = useWorkbenchStore.getState().openFiles[0]?.lineNonce ?? 0;
    expect(secondNonce).toBeGreaterThan(firstNonce);

    // If the file grew on disk from 30 -> 160 lines and is re-opened at :150, background refresh bumps lineNonce again
    // so CodeMirror re-scrolls to line 150 after replacing the buffer with the 160-line content.
    diskLines = 160;
    const openPromise = useWorkbenchStore.getState().openFile(cwd, "src/index.ts:150");
    const preRefreshNonce = useWorkbenchStore.getState().openFiles[0]?.lineNonce ?? 0;
    await openPromise;
    const postRefreshNonce = useWorkbenchStore.getState().openFiles[0]?.lineNonce ?? 0;
    expect(postRefreshNonce).toBeGreaterThan(preRefreshNonce);
  });

  it("normalizes 'code' tab alias to 'editor' unless a plugin explicitly registered 'code'", () => {
    openWorkbenchTab("code");
    expect(useWorkbenchStore.getState().rightOpen).toBe(true);
    expect(useWorkbenchStore.getState().activeTab).toBe("editor");

    useWorkbenchStore.getState().openTab("files");
    applyWorkbenchOpenNotification({ target: "code" as never }, "D:\\Workspaces\\ProjectA");
    expect(useWorkbenchStore.getState().activeTab).toBe("editor");

    const disposeCustom = clientContributions.registerRightWorkbenchTab({
      id: "code",
      label: "Custom Code",
      render: () => null,
    });
    try {
      openWorkbenchTab("code");
      expect(useWorkbenchStore.getState().activeTab).toBe("code");
    } finally {
      disposeCustom();
    }
  });
});

describe("Browser Preview URL Sanitization", () => {
  it("allows external/local dev http(s) URLs while blocking dangerous schemes, Tauri IPC hosts, and same-origin host URLs", () => {
    const hostOrigin = "http://127.0.0.1:1420";

    expect(sanitizePreviewUrl("http://localhost:5173/app", hostOrigin)).toBe("http://localhost:5173/app");
    expect(sanitizePreviewUrl("https://example.com/docs?tab=1", hostOrigin)).toBe("https://example.com/docs?tab=1");

    expect(sanitizePreviewUrl("", hostOrigin)).toBeNull();
    expect(sanitizePreviewUrl("   ", hostOrigin)).toBeNull();
    expect(sanitizePreviewUrl("not a valid url", hostOrigin)).toBeNull();
    expect(sanitizePreviewUrl("javascript:alert(document.cookie)", hostOrigin)).toBeNull();
    expect(sanitizePreviewUrl("data:text/html,<script>alert(1)</script>", hostOrigin)).toBeNull();
    expect(sanitizePreviewUrl("file:///C:/Windows/System32/drivers/etc/hosts", hostOrigin)).toBeNull();
    expect(sanitizePreviewUrl("blob:http://localhost:5173/abc", hostOrigin)).toBeNull();

    // Tauri / WebView2 internal origins
    expect(sanitizePreviewUrl("http://tauri.localhost/index.html", hostOrigin)).toBeNull();
    expect(sanitizePreviewUrl("https://tauri.localhost/index.html", hostOrigin)).toBeNull();
    expect(sanitizePreviewUrl("http://ipc.localhost/custom", hostOrigin)).toBeNull();
    expect(sanitizePreviewUrl("http://asset.localhost/C%3A/Windows/win.ini", hostOrigin)).toBeNull();
    expect(sanitizePreviewUrl("https://plugin.tauri.localhost/view", hostOrigin)).toBeNull();
    expect(sanitizePreviewUrl("http://bridge.ipc.localhost/call", hostOrigin)).toBeNull();
    expect(sanitizePreviewUrl("https://local.asset.localhost/secret", hostOrigin)).toBeNull();

    // Same-origin escape prevention in sandbox="allow-scripts allow-same-origin"
    expect(sanitizePreviewUrl("http://127.0.0.1:1420/index.html", hostOrigin)).toBeNull();
    expect(sanitizePreviewUrl("http://127.0.0.1:1420/", hostOrigin)).toBeNull();
  });
});

describe("Streaming Reference Stability & Incremental Caches", () => {
  it("preserves === object identity for completed historical turns while a later turn streams", () => {
    const u1: UiMessage = { id: "u1", role: "user", content: "First prompt", timestamp: 100 };
    const a1Step: UiMessage = {
      id: "a1-1",
      role: "assistant",
      content: "",
      thinking: "Checking files",
      toolCalls: [{ id: "tc1", name: "read", args: { path: "README.md" }, running: false, isError: false }],
      timestamp: 110,
    };
    const a1Final: UiMessage = {
      id: "a1-2",
      role: "assistant",
      content: "First answer complete.",
      timestamp: 150,
    };
    const u2: UiMessage = { id: "u2", role: "user", content: "Second prompt", timestamp: 200 };
    const a2Tick1: UiMessage = {
      id: "a2-1",
      role: "assistant",
      content: "Streaming part 1",
      isStreaming: true,
      timestamp: 210,
    };
    const a2Tick2: UiMessage = {
      ...a2Tick1,
      content: "Streaming part 1 + part 2",
    };

    const tick1Messages = [u1, a1Step, a1Final, u2, a2Tick1];
    const grouped1 = groupTranscriptMessages(tick1Messages);
    expect(grouped1).toBe(groupTranscriptMessages(tick1Messages));

    const grouped2 = groupTranscriptMessages([u1, a1Step, a1Final, u2, a2Tick2]);
    expect(grouped2).toHaveLength(4);
    expect(grouped2[0]).toBe(grouped1[0]);
    expect(grouped2[1]).toBe(grouped1[1]);
    expect(grouped2[2]).toBe(grouped1[2]);
    expect(grouped2[3]).not.toBe(grouped1[3]);
    expect(grouped2[3]?.content).toBe("Streaming part 1 + part 2");
  });

  it("caches deriveSessionIntelligentUis and sessionEditedPaths and fast-checks plain messages", () => {
    const plainAssistant: UiMessage = {
      id: "m-plain",
      role: "assistant",
      content: "Normal markdown explanation",
      toolCalls: [
        { id: "t-edit-ok", name: "edit", args: { path: "src/App.tsx" }, running: false, isError: false },
        { id: "t-write-running", name: "write", args: { path: "src/wip.ts" }, running: true, isError: false },
        { id: "t-write-err", name: "write", args: { path: "src/fail.ts" }, running: false, isError: true },
      ],
      timestamp: 1_000,
    };
    const uiAssistant: UiMessage = {
      id: "m-ui",
      role: "assistant",
      content:
        '```intelligent-ui\n{"id":"roi","title":"ROI","blocks":[{"type":"stats","items":[{"label":"ROI","value":"42%"}]}]}\n```',
      timestamp: 2_000,
    };

    expect(messageMayContainIntelligentUi(plainAssistant)).toBe(false);
    expect(messageMayContainIntelligentUi(uiAssistant)).toBe(true);

    const list = [plainAssistant, uiAssistant];
    const uiSummary1 = deriveSessionIntelligentUis(list);
    const uiSummary2 = deriveSessionIntelligentUis(list);
    expect(uiSummary2).toBe(uiSummary1);
    expect(uiSummary1.orderedGroups.map((g) => g.id)).toEqual(["roi"]);

    const edited1 = sessionEditedPaths(list);
    const edited2 = sessionEditedPaths(list);
    expect(edited2).toBe(edited1);
    expect(edited1).toEqual(["src/App.tsx"]);

    // Historical TaskPlanSummary references stay === identical while later turns stream.
    const planTurnUser: UiMessage = { id: "pu1", role: "user", content: "Plan", timestamp: 100 };
    const planTurnAssistant: UiMessage = {
      id: "pa1",
      role: "assistant",
      content: "Planned.",
      toolCalls: [{
        id: "plan-1",
        name: "update_plan",
        args: { items: [{ id: "s1", text: "Step 1", status: "completed" }] },
        running: false,
        isError: false,
      }],
      timestamp: 120,
    };
    const nextUser: UiMessage = { id: "pu2", role: "user", content: "Execute", timestamp: 200 };
    const streamTickA: UiMessage = { id: "pa2", role: "assistant", content: "A", isStreaming: true, timestamp: 210 };
    const streamTickB: UiMessage = { ...streamTickA, content: "AB" };

    const plans1 = deriveTurnPlans([planTurnUser, planTurnAssistant, nextUser, streamTickA], true);
    const plans2 = deriveTurnPlans([planTurnUser, planTurnAssistant, nextUser, streamTickB], true);
    expect(plans1.get("pa1")).toBeDefined();
    expect(plans2.get("pa1")).toBe(plans1.get("pa1"));
  });

  it("does not auto-pop Right Workbench Canvas on two-phase idle session switches with historical HTML artifacts", () => {
    ensureClientPluginRuntime();
    useIntelligentUiStore.setState({
      pluginEnabled: true,
      selectedWidgetId: null,
      selectedVersionById: {},
    });
    useWorkbenchStore.getState().resetForTest();

    // Phase 1 of switching to a saved session (`connect()` clears messages first while idle).
    useAppStore.setState({
      sessionFile: "harness:saved-html-session",
      messages: [],
      isStreaming: false,
    });

    // Phase 2 (`localHistory` / `syncSession` populates historical messages containing an HTML artifact while idle).
    const historicalHtmlMsg: UiMessage = {
      id: "hist-html-1",
      role: "assistant",
      content: "Saved artifact",
      toolCalls: [{
        id: "tc-html-hist",
        name: "render_ui",
        args: { id: "hist-chart", title: "Saved Chart", engine: "html", html: "<div>saved</div>" },
        running: false,
        isError: false,
      }],
      timestamp: 1_000,
    };
    useAppStore.setState({
      sessionFile: "harness:saved-html-session",
      messages: [historicalHtmlMsg],
      isStreaming: false,
    });

    expect(useWorkbenchStore.getState().rightOpen).toBe(false);
    expect(useIntelligentUiStore.getState().selectedWidgetId).toBeNull();

    // Subsequent live artifact emitted in the already-hydrated session MUST open Canvas.
    const liveHtmlMsg: UiMessage = {
      id: "live-html-2",
      role: "assistant",
      content: "Live artifact",
      toolCalls: [{
        id: "tc-html-live",
        name: "render_ui",
        args: { id: "live-chart", title: "Live Chart", engine: "html", html: "<div>live</div>" },
        running: false,
        isError: false,
      }],
      timestamp: 2_000,
    };
    useAppStore.setState({
      sessionFile: "harness:saved-html-session",
      messages: [historicalHtmlMsg, liveHtmlMsg],
      isStreaming: true,
    });

    expect(useWorkbenchStore.getState().rightOpen).toBe(true);
    expect(useIntelligentUiStore.getState().selectedWidgetId).toBe("live-chart");

    // Non-tail message mutation during streaming (e.g. an earlier step completing `render_ui` while a plain
    // steering/tail message sits at `messages[length - 1]`) MUST NOT be skipped by the tail-only fast path!
    useWorkbenchStore.getState().resetForTest();
    useIntelligentUiStore.setState({ selectedWidgetId: null, selectedVersionById: {} });
    const pendingStep: UiMessage = {
      id: "step-pending",
      role: "assistant",
      content: "Generating dashboard",
      timestamp: 3_000,
    };
    const plainTail1: UiMessage = {
      id: "tail-plain",
      role: "assistant",
      content: "Summarizing...",
      isStreaming: true,
      timestamp: 3_100,
    };
    useAppStore.setState({
      sessionFile: "harness:saved-html-session",
      messages: [historicalHtmlMsg, pendingStep, plainTail1],
      isStreaming: true,
    });
    expect(useWorkbenchStore.getState().rightOpen).toBe(false);

    const completedStepWithHtml: UiMessage = {
      ...pendingStep,
      toolCalls: [{
        id: "tc-html-prefix",
        name: "render_ui",
        args: { id: "prefix-chart", title: "Prefix Chart", engine: "html", html: "<div>prefix</div>" },
        running: false,
        isError: false,
      }],
    };
    const plainTail2: UiMessage = {
      ...plainTail1,
      content: "Summarizing metrics...",
    };
    useAppStore.setState({
      sessionFile: "harness:saved-html-session",
      messages: [historicalHtmlMsg, completedStepWithHtml, plainTail2],
      isStreaming: true,
    });
    expect(useWorkbenchStore.getState().rightOpen).toBe(true);
    expect(useIntelligentUiStore.getState().selectedWidgetId).toBe("prefix-chart");

    // Clean up AppStore slice mutated during test.
    useAppStore.setState({ sessionFile: null, messages: [], isStreaming: false });
  });
});

describe("Harness WebSocket RPC & Runtime Hardening", () => {
  it("isolates throwing notification listeners and enforces per-call RPC timeouts", async () => {
    host = createHost({
      version: "1.0.0",
      dataDir: "unused",
      plugins: [
        [WebServer, { pageOrigins: [] }],
        [RpcGateway, { token }],
      ],
    });
    await host.start();
    host.ctx.rpc.method("test.hang", () => new Promise(() => undefined));
    const baseUrl = `http://127.0.0.1:${await host.ctx.webServer.listen(0)}/`;

    const connection = await connectHarness({ baseUrl, token }, { name: "hardening-test", version: "1" });
    const receivedBySecond: unknown[] = [];

    connection.onNotification(() => {
      throw new Error("rogue plugin notification listener boom");
    });
    connection.onNotification((method, params) => {
      receivedBySecond.push({ method, params });
    });

    host.ctx.rpc.broadcast("custom/ping", { ok: true });
    await connection.call("host.ping");
    expect(receivedBySecond).toEqual([{ method: "custom/ping", params: { ok: true } }]);

    await expect(
      connection.call("test.hang", {}, { timeoutMs: 60 }),
    ).rejects.toThrow(/timed out after 60ms/i);

    connection.close();
  });

  it("aborts connectHarness when handshake stalls past connectTimeoutMs", async () => {
    // A server that stalls the HTTP/WS upgrade indefinitely without replying.
    hungServer = createServer(() => undefined);
    hungServer.on("connection", (sock) => {
      hungSockets.add(sock);
      sock.on("close", () => hungSockets.delete(sock));
    });
    hungServer.on("upgrade", () => {
      // Intentionally hold socket open without completing 101 Switching Protocols.
    });
    await new Promise<void>((resolve) => hungServer?.listen(0, "127.0.0.1", () => resolve()));
    const port = (hungServer.address() as AddressInfo).port;

    await expect(
      connectHarness(
        { baseUrl: `http://127.0.0.1:${port}/`, token },
        { name: "stall-test", version: "1" },
        { connectTimeoutMs: 80 },
      ),
    ).rejects.toThrow(/timed out after 80ms/i);
  });

  it("unsubscribes previous session on newSession() and cancels pending local confirmations on stop()", async () => {
    const rpcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const runtimes = new HarnessRuntimes(async () => ({
      host: { protocolVersion: "1.0", host: { name: "mock", version: "1.0.0" }, capabilities: { methods: [] } },
      call: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
        rpcCalls.push({ method, ...(params === undefined ? {} : { params }) });
        if (method === "session.subscribe") {
          return { status: { running: false }, events: [] } as unknown as T;
        }
        if (method === "checkpoint.list") {
          return {
            checkpoints: [{ userSeq: 1 }],
          } as unknown as T;
        }
        if (method === "checkpoint.diff") {
          return {
            changed: true,
            files: ["src/App.tsx"],
          } as unknown as T;
        }
        return {} as T;
      },
      onNotification: () => () => undefined,
      onClose: () => undefined,
      close: () => undefined,
    }));

    const uiRequests: ExtensionUIRequest[] = [];
    runtimes.subscribe((_id: string, event: TranscriptEvent) => {
      if (event.type === "ui-request") uiRequests.push(event.request);
    });

    const { runtimeId } = await runtimes.start("D:\\Workspaces\\Demo", "harness:s-old");
    expect(rpcCalls.some((c) => c.method === "session.subscribe" && c.params?.sessionId === "s-old")).toBe(true);

    // Switching to a fresh session on the same runtime must unsubscribe `s-old`.
    runtimes.newSession(runtimeId);
    await vi.waitFor(() => {
      expect(
        rpcCalls.some((c) => c.method === "session.unsubscribe" && c.params?.sessionId === "s-old"),
      ).toBe(true);
    });

    // Re-open a session, trigger a local rewind confirmation, and stop the runtime before answering:
    // the pending rewind promise must settle cleanly to `false` instead of hanging forever.
    const second = await runtimes.start("D:\\Workspaces\\Demo", "harness:s-2");
    const rewindPromise = runtimes.rewind(second.runtimeId, "1");
    await vi.waitFor(() => {
      expect(uiRequests).toHaveLength(1);
    });

    await runtimes.stop(second.runtimeId);
    await expect(rewindPromise).resolves.toBe(false);
    runtimes.close();
  });
});
