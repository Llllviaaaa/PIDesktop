import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  buildThemeCssVariables,
  resolveAppearanceTheme,
  type AppearanceCatalog,
} from "../../lib/appearanceCatalog";
import { ensureClientPluginRuntime } from "../../lib/clientPluginBootstrap";
import { applyUiScale } from "../../lib/panelLayout";
import { scheduleClient } from "../../lib/scheduleClient";
import { useAppStore } from "../../store";
import { bindWorkbenchNotifications } from "../../stores/workbenchStore";
import type { AppSettings, ConnectionState } from "../../types";
import type { AppMenu, HubView } from "./shellTypes";

export interface ShellEffectsOptions {
  isTauri: boolean;
  anyTaskStreaming: boolean;
  workspaceCwd: string;
  cwd: string;
  moreOpen: boolean;
  setMoreOpen: (next: boolean) => void;
  appMenu: AppMenu | null;
  setAppMenu: (next: AppMenu | null) => void;
  settingsOpen: boolean;
  setSettingsOpen: (next: boolean) => void;
  setSidebarVisible: (next: boolean | ((prev: boolean) => boolean)) => void;
  appearanceCatalog: AppearanceCatalog;
  settings: AppSettings | null;
  connection: ConnectionState;
  canOpenWorkspace: boolean;
  openWorkspaceInPreferredApp: () => void;
  pinPrimarySidebar: () => void;
  setSidebarSearchRequested: (next: boolean) => void;
  cycleTranscriptDensity: () => void;
  toggleBottomPanel: () => void;
  toggleWorkspaceSidebar: () => void;
  openBrowserAt: (url?: string) => void;
  openReview: () => void;
  togglePrimarySidebar: () => void;
  prepareNewTask: () => void;
  setDraftMode: (next: boolean) => void;
  setQuickChat: (next: boolean) => void;
  setHubView: (next: HubView | null) => void;
}

export function useAppearanceAndShellEffects({
  isTauri,
  anyTaskStreaming,
  workspaceCwd,
  cwd,
  moreOpen,
  setMoreOpen,
  appMenu,
  setAppMenu,
  settingsOpen,
  setSettingsOpen,
  setSidebarVisible,
  appearanceCatalog,
  settings,
  connection,
  canOpenWorkspace,
  openWorkspaceInPreferredApp,
  pinPrimarySidebar,
  setSidebarSearchRequested,
  cycleTranscriptDensity,
  toggleBottomPanel,
  toggleWorkspaceSidebar,
  openBrowserAt,
  openReview,
  togglePrimarySidebar,
  prepareNewTask,
  setDraftMode,
  setQuickChat,
  setHubView,
}: ShellEffectsOptions) {
  useEffect(() => {
    if (!isTauri) return;
    void invoke("set_streaming_guard", { active: anyTaskStreaming }).catch(() => undefined);
  }, [anyTaskStreaming, isTauri]);

  useEffect(() => {
    if (isTauri) return;
    void useAppStore.getState().loadSettings();
  }, [isTauri]);

  const activeWorkspaceRef = useRef(workspaceCwd || cwd);
  useEffect(() => {
    const nextWorkspace = workspaceCwd || cwd;
    activeWorkspaceRef.current = nextWorkspace;
    ensureClientPluginRuntime().setWorkspace(nextWorkspace || undefined);
  }, [cwd, workspaceCwd]);

  useEffect(() => {
    ensureClientPluginRuntime();
    return bindWorkbenchNotifications(() => ({ cwd: activeWorkspaceRef.current }));
  }, []);

  useEffect(() => {
    if (!moreOpen && !appMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (moreOpen && !target.closest(".title-actions")) setMoreOpen(false);
      if (appMenu && !target.closest(".app-menu-bar, .app-menu-dropdown")) setAppMenu(null);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || settingsOpen) return;
      if (moreOpen) setMoreOpen(false);
      else if (appMenu) setAppMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [appMenu, moreOpen, setAppMenu, setMoreOpen, settingsOpen]);

  useEffect(() => {
    const narrowWindow = window.matchMedia("(max-width: 900px)");
    const collapseSidebar = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setSidebarVisible(false);
    };
    collapseSidebar(narrowWindow);
    narrowWindow.addEventListener("change", collapseSidebar);
    return () => narrowWindow.removeEventListener("change", collapseSidebar);
  }, [setSidebarVisible]);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void scheduleClient.onRunUpdated((run) => {
      if (run.status === "running") return;
      void useAppStore.getState().refreshSessions();
      useAppStore.getState().showToast(
        run.status === "success"
          ? `计划任务“${run.taskName}”已完成`
          : `计划任务“${run.taskName}”${run.status === "interrupted" ? "已中断" : "失败"}`,
        run.status === "success" ? "info" : "error",
      );
      useAppStore.getState().addNotification({
        id: `scheduled:${run.id}:${run.status}`,
        kind: "completion",
        title: run.status === "success" ? "计划任务已完成" : "计划任务未完成",
        body: run.taskName,
        cwd: run.cwd,
        sessionFile: run.sessionFile ?? null,
      });
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isTauri]);

  useEffect(() => {
    const root = document.documentElement;
    const syncWindowBlur = () => {
      root.toggleAttribute("data-window-blur", !document.hasFocus());
    };
    document.body.setAttribute("data-dsh-claude-style", "");
    syncWindowBlur();
    window.addEventListener("focus", syncWindowBlur);
    window.addEventListener("blur", syncWindowBlur);
    return () => {
      window.removeEventListener("focus", syncWindowBlur);
      window.removeEventListener("blur", syncWindowBlur);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const fixtureTheme = import.meta.env.DEV && !isTauri
        ? new URLSearchParams(window.location.search).get("theme")
        : null;
      const requestedTheme = fixtureTheme && appearanceCatalog.themes.some((theme) => theme.id === fixtureTheme)
        ? fixtureTheme
        : settings?.theme ?? "system";
      const theme = resolveAppearanceTheme(appearanceCatalog, requestedTheme, systemTheme?.matches ?? false);
      const palette = theme.palette;
      if (!palette) return;
      root.dataset.theme = theme.mode;
      const variables = buildThemeCssVariables(palette);
      for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
      root.style.setProperty(
        "--code-font",
        settings?.codeFont || '"JetBrains Mono Variable", "JetBrains Mono", "Cascadia Code", "SF Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, monospace',
      );
      const messageFontSize = Number(settings?.messageFontSize);
      root.style.setProperty(
        "--dsh-content-font-size",
        `${Number.isFinite(messageFontSize) ? Math.min(22, Math.max(10, messageFontSize)) : 15}px`,
      );
      root.style.fontFamily = settings?.uiFont || "var(--font-ui)";
      root.style.color = palette.text;
      root.style.background = palette.app;
      applyUiScale(root, document.getElementById("root"), settings?.uiScale);
    };
    applyTheme();
    systemTheme?.addEventListener("change", applyTheme);
    return () => systemTheme?.removeEventListener("change", applyTheme);
  }, [appearanceCatalog, isTauri, settings]);

  useEffect(() => {
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "").replace("control", "ctrl");
    const shortcuts = {
      newChat: settings?.shortcutNewChat ?? "Ctrl+Shift+N",
      settings: settings?.shortcutSettings ?? "Ctrl+,",
      terminal: settings?.shortcutTerminal ?? "Ctrl+Shift+T",
      changes: settings?.shortcutChanges ?? "Ctrl+Shift+G",
      toggleSidebar: settings?.shortcutToggleSidebar ?? "Ctrl+B",
    };
    const ctrlKBound = Object.values(shortcuts).some((value) => normalize(value) === "ctrl+k");
    const shortcutFor = (event: KeyboardEvent) => [
      event.ctrlKey ? "Ctrl" : "",
      event.altKey ? "Alt" : "",
      event.shiftKey ? "Shift" : "",
      event.metaKey ? "Meta" : "",
      event.key.length === 1 ? event.key.toUpperCase() : event.key,
    ].filter(Boolean).join("+");
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = normalize(shortcutFor(event));
      const ctrl = event.ctrlKey || event.metaKey;
      const inTerminal = Boolean((event.target as Element | null)?.closest?.(".xterm"));
      if (ctrl && event.shiftKey && !event.altKey && event.key.toLowerCase() === "o" && !inTerminal && canOpenWorkspace) {
        event.preventDefault();
        openWorkspaceInPreferredApp();
        return;
      }
      if (shortcut === normalize(shortcuts.settings) || (event.ctrlKey && event.key === ",")) {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (settingsOpen && event.key === "Escape") {
        if (document.querySelector("[data-escape-layer]")) return;
        event.preventDefault();
        setSettingsOpen(false);
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k" && !inTerminal && !settingsOpen && !ctrlKBound) {
        event.preventDefault();
        pinPrimarySidebar();
        setSidebarSearchRequested(true);
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "o" && !inTerminal) {
        event.preventDefault();
        cycleTranscriptDensity();
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && (event.key.toLowerCase() === "j" || event.code === "Backquote" || event.key === "`")) {
        event.preventDefault();
        toggleBottomPanel();
        return;
      }
      if (ctrl && event.altKey && !event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleWorkspaceSidebar();
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "t" && !inTerminal) {
        event.preventDefault();
        openBrowserAt();
        return;
      }
      if (shortcut === normalize(shortcuts.newChat) && connection === "running") {
        event.preventDefault();
        setSettingsOpen(false);
        prepareNewTask();
        setDraftMode(true);
        setQuickChat(false);
        setHubView(null);
      } else if (shortcut === normalize(shortcuts.terminal) || shortcut === "ctrl+j") {
        event.preventDefault();
        setSettingsOpen(false);
        toggleBottomPanel();
      } else if (shortcut === normalize(shortcuts.changes) && !inTerminal) {
        event.preventDefault();
        setSettingsOpen(false);
        openReview();
      } else if (shortcut === normalize(shortcuts.toggleSidebar) && !inTerminal) {
        event.preventDefault();
        togglePrimarySidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    canOpenWorkspace,
    connection,
    cycleTranscriptDensity,
    openBrowserAt,
    openReview,
    openWorkspaceInPreferredApp,
    pinPrimarySidebar,
    prepareNewTask,
    setDraftMode,
    setHubView,
    setQuickChat,
    setSettingsOpen,
    setSidebarSearchRequested,
    settings,
    settingsOpen,
    toggleBottomPanel,
    togglePrimarySidebar,
    toggleWorkspaceSidebar,
  ]);
}
