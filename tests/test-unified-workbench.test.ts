import { Context } from "@deepseek-ai/cordis";
import { ErrorCode } from "@qianji/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agent } from "../src/lib/agent";
import {
  ClientContributionRegistry,
  ClientContributionService,
} from "../src/lib/clientContributions";
import { BetterSidebarCompatService } from "../src/lib/clientPluginBootstrap";
import { HarnessRpcError } from "../src/lib/harnessClient";
import { HarnessRuntimes } from "../src/lib/harnessRuntime";
import {
  applyWorkbenchOpenNotification,
  useWorkbenchStore,
} from "../src/stores/workbenchStore";

afterEach(() => {
  useWorkbenchStore.getState().resetForTest();
  vi.restoreAllMocks();
});

describe("Unified Client Contribution Registry & Cordis Service", () => {
  it("orders contributions deterministically and cleans up safely across HMR overwrites and fiber disposal", async () => {
    const registry = new ClientContributionRegistry();
    let notifications = 0;
    const unsubscribe = registry.subscribe(() => {
      notifications += 1;
    });

    const disposeLatePage = registry.registerPage({
      id: "zeta",
      label: "Zeta",
      order: 20,
      render: () => null,
    });
    const disposeEarlyPage = registry.registerPage({
      id: "alpha",
      label: "Alpha",
      order: 5,
      render: () => null,
    });
    expect(registry.getSnapshot().pages.map((p) => p.id)).toEqual(["alpha", "zeta"]);
    expect(notifications).toBe(2);

    // Overwriting an id during HMR and calling the stale disposer must NOT delete the newer registration.
    const staleDispose = registry.registerRightWorkbenchTab({
      id: "custom-tab",
      label: "v1",
      render: () => "v1",
    });
    const freshDispose = registry.registerRightWorkbenchTab({
      id: "custom-tab",
      label: "v2",
      render: () => "v2",
    });
    staleDispose();
    expect(registry.getSnapshot().rightWorkbenchTabs.map((t) => t.label)).toEqual(["v2"]);
    freshDispose();
    expect(registry.getSnapshot().rightWorkbenchTabs).toEqual([]);

    // Cordis plugin integration: disposing a child plugin fiber automatically removes its UI/theme/pet contributions,
    // even when a plugin calls `ctx.contributions.registerRightWorkbenchTab` directly without `ctx.effect(...)`!
    const ctx = new Context();
    await ctx.plugin(ClientContributionService, registry);
    await ctx.plugin(BetterSidebarCompatService, registry);

    const pluginFiber = ctx.plugin({
      name: "test-ui-plugin",
      inject: ["contributions"],
      apply(pluginCtx: Context) {
        pluginCtx.contributions.registerRightWorkbenchTab({
          id: "auto-tracked-tab",
          label: "Auto Tracked",
          render: () => null,
        });
        pluginCtx.effect(() => pluginCtx.contributions.registerBottomPanelTab({
          id: "inspector",
          label: "Inspector",
          render: () => null,
        }));
        pluginCtx.effect(() => pluginCtx.contributions.registerTopbarAction({
          id: "quick-btn",
          render: () => null,
        }));
        pluginCtx.effect(() => pluginCtx.contributions.registerComposerToolbar({
          id: "prompt-chip",
          render: () => null,
        }));
        pluginCtx.effect(() => pluginCtx.contributions.registerLeftSidebar({
          id: "nav-card",
          render: () => null,
        }));
        pluginCtx.effect(() => pluginCtx.contributions.registerTheme({
          id: "solar-plugin",
          label: "Solar Plugin",
          mode: "dark",
          scope: "user",
          palette: {
            app: "#101010",
            panel: "#181818",
            panelStrong: "#202020",
            panelSoft: "#141414",
            hover: "#262626",
            active: "#303030",
            border: "#2c2c2c",
            borderStrong: "#3a3a3a",
            text: "#f5f5f5",
            text2: "#c0c0c0",
            text3: "#8a8a8a",
            accent: "#6687a8",
            accentText: "#ffffff",
            sidebar: "#121212",
          },
        }));
      },
    });
    await pluginFiber;

    expect(registry.getSnapshot().rightWorkbenchTabs.map((t) => t.id)).toEqual(["auto-tracked-tab"]);
    expect(registry.getSnapshot().bottomPanelTabs.map((t) => t.id)).toEqual(["inspector"]);
    expect(registry.getSnapshot().topbarActions.map((a) => a.id)).toEqual(["quick-btn"]);
    expect(registry.getSnapshot().composerToolbar.map((a) => a.id)).toEqual(["prompt-chip"]);
    expect(registry.getSnapshot().leftSidebar.map((s) => s.id)).toEqual(["nav-card"]);
    expect(registry.getSnapshot().themes.map((t) => t.id)).toEqual(["solar-plugin"]);

    await pluginFiber.dispose();
    expect(registry.getSnapshot().rightWorkbenchTabs).toEqual([]);
    expect(registry.getSnapshot().bottomPanelTabs).toEqual([]);
    expect(registry.getSnapshot().topbarActions).toEqual([]);
    expect(registry.getSnapshot().composerToolbar).toEqual([]);
    expect(registry.getSnapshot().leftSidebar).toEqual([]);
    expect(registry.getSnapshot().themes).toEqual([]);

    // Legacy `betterSidebar` compatibility shim maps tabs into unified right/bottom slots and auto-disposes.
    const compatFiber = ctx.plugin({
      name: "legacy-sidebar-plugin",
      inject: ["betterSidebar"],
      apply(compatCtx: Context) {
        compatCtx.betterSidebar.registerTab({
          id: "office-viewer",
          title: () => "Office Viewer",
          component: ({ scope }) => `cwd:${String((scope as { cwd?: string }).cwd)}`,
        });
        compatCtx.betterSidebar.registerTab({
          id: "bottom-log",
          title: "Bottom Log",
          bottomOnly: true,
          component: () => "bottom-content",
        });
      },
    });
    await compatFiber;

    expect(registry.getSnapshot().rightWorkbenchTabs.map((t) => [t.id, t.label])).toEqual([
      ["office-viewer", "Office Viewer"],
    ]);
    expect(registry.getSnapshot().bottomPanelTabs.map((t) => [t.id, t.label])).toEqual([
      ["bottom-log", "Bottom Log"],
    ]);
    expect(
      registry.getSnapshot().rightWorkbenchTabs[0]?.render({ cwd: "D:/Demo", sessionFile: "harness:s1" }),
    ).toBe("cwd:D:/Demo");

    ctx.betterSidebar.activateTab("office-viewer");
    expect(useWorkbenchStore.getState().rightOpen).toBe(true);
    expect(useWorkbenchStore.getState().activeTab).toBe("office-viewer");

    await compatFiber.dispose();
    expect(registry.getSnapshot().rightWorkbenchTabs).toEqual([]);
    expect(registry.getSnapshot().bottomPanelTabs).toEqual([]);

    disposeEarlyPage();
    disposeLatePage();
    unsubscribe();
    await ctx.fiber.dispose();
  });
});

describe("Unified Workbench Store & Host Notification Routing", () => {
  it("normalizes workspace paths with :line suffixes, preserves dirty edits, saves via writeWorkspaceFile, and selects neighbor on close", async () => {
    const readSpy = vi.spyOn(agent, "readWorkspaceFile").mockImplementation(async (_cwd, path) => ({
      path,
      fileName: path.split("/").pop() ?? path,
      text: `initial:${path}`,
      size: 16,
      truncated: false,
      isBinary: false,
    }));
    const writeSpy = vi.spyOn(agent, "writeWorkspaceFile").mockResolvedValue(undefined);

    const cwd = "D:\\Workspace\\Demo";
    await useWorkbenchStore.getState().openFile(cwd, "D:\\Workspace\\Demo\\src\\App.tsx:48:5");

    let state = useWorkbenchStore.getState();
    expect(state.rightOpen).toBe(true);
    expect(state.activeTab).toBe("editor");
    expect(state.activeFilePath).toBe("src/App.tsx");
    expect(state.openFiles[0]).toMatchObject({
      path: "src/App.tsx",
      content: "initial:src/App.tsx",
      savedContent: "initial:src/App.tsx",
      line: 48,
      loading: false,
    });

    // User edits the file -> re-opening at another line preserves unsaved edits without re-reading disk.
    useWorkbenchStore.getState().updateFileContent("src/App.tsx", "edited content");
    readSpy.mockClear();
    await useWorkbenchStore.getState().openFile(cwd, "src/App.tsx", { line: 99, endLine: 105 });
    expect(readSpy).not.toHaveBeenCalled();
    state = useWorkbenchStore.getState();
    expect(state.openFiles[0]?.content).toBe("edited content");
    expect(state.openFiles[0]?.line).toBe(99);
    expect(state.openFiles[0]?.endLine).toBe(105);

    // Save writes to disk and marks buffer clean.
    const saved = await useWorkbenchStore.getState().saveFile(cwd, "src/App.tsx");
    expect(saved).toBe(true);
    expect(writeSpy).toHaveBeenCalledWith(cwd, "src/App.tsx", "edited content");
    expect(useWorkbenchStore.getState().openFiles[0]?.savedContent).toBe("edited content");

    // Open two more files and verify neighbor selection on close.
    await useWorkbenchStore.getState().openFile(cwd, "src/second.ts");
    await useWorkbenchStore.getState().openFile(cwd, "src/third.ts");
    useWorkbenchStore.getState().selectFile("src/second.ts");
    useWorkbenchStore.getState().closeFile("src/second.ts");
    expect(useWorkbenchStore.getState().activeFilePath).toBe("src/third.ts");

    useWorkbenchStore.getState().closeFile("src/third.ts");
    expect(useWorkbenchStore.getState().activeFilePath).toBe("src/App.tsx");
  });

  it("refuses to overwrite binary or truncated files on saveFile", async () => {
    vi.spyOn(agent, "readWorkspaceFile").mockResolvedValueOnce({
      path: "assets/logo.png",
      fileName: "logo.png",
      text: null,
      size: 512,
      truncated: false,
      isBinary: true,
      mimeType: "image/png",
      data: "AAAA",
    });
    const writeSpy = vi.spyOn(agent, "writeWorkspaceFile");

    const cwd = "D:\\Workspace\\Demo";
    await useWorkbenchStore.getState().openFile(cwd, "assets/logo.png");
    const saved = await useWorkbenchStore.getState().saveFile(cwd, "assets/logo.png");
    expect(saved).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("routes all Host workbench/open notification targets accurately", async () => {
    vi.spyOn(agent, "readWorkspaceFile").mockResolvedValue({
      path: "README.md",
      fileName: "README.md",
      text: "# Demo",
      size: 6,
      truncated: false,
      isBinary: false,
    });

    const cwd = "D:\\Workspace\\Demo";
    applyWorkbenchOpenNotification({ target: "files" }, cwd);
    expect(useWorkbenchStore.getState().activeTab).toBe("files");

    applyWorkbenchOpenNotification({ target: "review" }, cwd);
    expect(useWorkbenchStore.getState().activeTab).toBe("review");

    applyWorkbenchOpenNotification({ target: "preview", url: "http://127.0.0.1:4173/" }, cwd);
    expect(useWorkbenchStore.getState().activeTab).toBe("preview");
    expect(useWorkbenchStore.getState().previewUrl).toBe("http://127.0.0.1:4173/");

    applyWorkbenchOpenNotification({ target: "summary" }, cwd);
    expect(useWorkbenchStore.getState().activeTab).toBe("summary");

    applyWorkbenchOpenNotification({ target: "side-chat" }, cwd);
    expect(useWorkbenchStore.getState().activeTab).toBe("side-chat");

    applyWorkbenchOpenNotification({ target: "terminal" }, cwd);
    expect(useWorkbenchStore.getState().bottomOpen).toBe(true);
    expect(useWorkbenchStore.getState().activeBottomTab).toBe("terminal");

    applyWorkbenchOpenNotification({ target: "editor", path: "README.md", line: 3 }, cwd);
    await vi.waitFor(() => {
      expect(useWorkbenchStore.getState().activeTab).toBe("editor");
      expect(useWorkbenchStore.getState().activeFilePath).toBe("README.md");
      expect(useWorkbenchStore.getState().openFiles[0]?.line).toBe(3);
    });
  });

  it("degrades rewind and setPermission cleanly when checkpoints or permissions plugins are disabled", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const runtimes = new HarnessRuntimes(async () => ({
      host: { protocolVersion: "1.0", host: { name: "test", version: "0.5.0" }, capabilities: { methods: [] } },
      call: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
        calls.push({ method, ...(params === undefined ? {} : { params }) });
        if (method === "session.subscribe") {
          return { status: { running: false }, events: [] } as unknown as T;
        }
        if (method === "checkpoint.list" || method === "permission.set") {
          throw new HarnessRpcError({ code: ErrorCode.MethodNotFound, message: `Method not found: ${method}` });
        }
        return {} as T;
      },
      onNotification: () => () => undefined,
      onClose: () => undefined,
      close: () => undefined,
    }));

    const { runtimeId } = await runtimes.start("D:\\Workspace\\Demo", "harness:s-1");
    await expect(runtimes.setPermission(runtimeId, { permission: "ask" })).resolves.toBeUndefined();
    await expect(runtimes.rewind(runtimeId, "3")).resolves.toBe(true);
    expect(calls.some((c) => c.method === "session.rewind" && c.params?.toSeq === 2)).toBe(true);
    runtimes.close();
  });

  it("opens .html and .svg files in dynamic preview mode by default and switches between preview, split, and code", async () => {
    vi.spyOn(agent, "readWorkspaceFile").mockImplementation(async (_cwd, path) => ({
      path,
      fileName: path.split("/").pop() ?? path,
      text: path.endsWith(".svg")
        ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
        : "<!doctype html><html><body><h1>Pelican</h1></body></html>",
      size: 64,
      truncated: false,
      isBinary: false,
    }));

    const cwd = "D:\\Workspace\\Demo";
    await useWorkbenchStore.getState().openFile(cwd, "pelican-bicycle.html");
    expect(useWorkbenchStore.getState().openFiles[0]?.viewMode).toBe("preview");

    useWorkbenchStore.getState().setFileViewMode("pelican-bicycle.html", "split");
    expect(useWorkbenchStore.getState().openFiles[0]?.viewMode).toBe("split");

    useWorkbenchStore.getState().setFileViewMode("pelican-bicycle.html", "code");
    expect(useWorkbenchStore.getState().openFiles[0]?.viewMode).toBe("code");

    // Opening with an explicit line number jumps straight to source code view.
    await useWorkbenchStore.getState().openFile(cwd, "chart.html:18");
    expect(useWorkbenchStore.getState().openFiles.find((f) => f.path === "chart.html")?.viewMode).toBe("code");

    // Standalone .svg also opens in preview mode when clicked without a line anchor.
    await useWorkbenchStore.getState().openFile(cwd, "diagram.svg");
    expect(useWorkbenchStore.getState().openFiles.find((f) => f.path === "diagram.svg")?.viewMode).toBe("preview");
  });
});
