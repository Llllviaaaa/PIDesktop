/**
 * Authoritative `@qianji/client` Frontend Plugin SDK (`src/sdk/index.ts`).
 *
 * Exposes semantically frozen read-only hooks, controlled host actions, and
 * slot contribution types to dynamic client plugins without coupling external
 * plugins to internal Zustand slices or private host UI components.
 */
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { agent as internalAgent } from "../lib/agent";
import {
  CLIENT_SLOT_CATALOG,
  clientContributions,
  useClientContributions,
  type AppearanceThemeInput,
  type BuiltinSettingsPageId,
  type ClientActionContribution,
  type ClientCodeBlockRendererContribution,
  type ClientComposerStatusContribution,
  type ClientContributionsSnapshot,
  type ClientFileViewerContribution,
  type ClientHomeQuickActionContribution,
  type ClientKeybindingContribution,
  type ClientMenuContextMap,
  type ClientMenuItemContribution,
  type ClientMenuItemFor,
  type ClientMenuLocation,
  type ClientMessageActionContribution,
  type ClientPageContribution,
  type ClientRewindHandlerContribution,
  type ClientSettingsPageContribution,
  type ClientSettingsSectionContribution,
  type ClientSidebarSectionContribution,
  type ClientSlashInterceptorContribution,
  type ClientSlotMetadata,
  type ClientStatusBarContribution,
  type ClientToolRendererContribution,
  type ClientWorkbenchTabContribution,
  type CodeBlockRendererSlotContext,
  type FileMenuContext,
  type FileViewerSlotContext,
  type HomeQuickActionSlotContext,
  type MessageActionSlotContext,
  type ProjectMenuContext,
  type SessionMenuContext,
  type SettingsSlotContext,
  type ToolRendererSlotContext,
  type WorkbenchSlotContext,
} from "../lib/clientContributions";
import type {
  AppearanceScope,
  AppearanceThemeDefinition,
  ThemePalette,
} from "../lib/appearanceCatalog";
import { harnessRuntimes as internalHarnessRuntimes } from "../lib/harnessRuntime";
import { pluginClient } from "../lib/pluginClient";
import { requestOpenHubPage, requestOpenSettings } from "../lib/shellBridge";
import {
  messageImagesToAttachments,
  rewindController,
  type ComposerDraftSnapshot,
  type PerformedRewindResult,
  type RewindExecutionResult,
  type RewindInspection,
  type RewindMode,
  type RewindTargetSummary,
  type RewindTurnSummary,
} from "../lib/rewindController";
import { useAppStore as internalUseAppStore } from "../store";
import { useWorkbenchStore as internalUseWorkbenchStore } from "../stores/workbenchStore";
import type { AttachmentPayload, SessionStats, UiMessage, UiToolCall } from "../types";
import { useHostRpcQuery, type HostRpcQueryOptions, type HostRpcQueryResult } from "./hostRpcQuery";
export type { SessionStats };
export { useHostRpcQuery, type HostRpcQueryOptions, type HostRpcQueryResult };

export interface ActiveSessionModelSummary {
  provider: string;
  id: string;
  contextWindow?: number;
}

export interface ActiveSessionSnapshot {
  sessionId: string | null;
  sessionFile: string | null;
  cwd: string;
  isStreaming: boolean;
  isCompacting: boolean;
  model: ActiveSessionModelSummary | null;
  stats: SessionStats | null;
  messageCount: number;
}

export interface ActiveWorkspaceSnapshot {
  cwd: string;
  connected: boolean;
  hostConnected: boolean;
}

export interface AppearanceThemeSnapshot {
  themeId: string;
  resolvedScheme: "light" | "dark";
  accentColor: string;
}

export interface SendChatPromptOptions {
  prefillOnly?: boolean;
  attachments?: AttachmentPayload[];
  behavior?: "steer" | "followUp";
}

function buildActiveSessionSnapshot(): ActiveSessionSnapshot {
  const state = internalUseAppStore.getState();
  return {
    sessionId: state.sessionId,
    sessionFile: state.sessionFile,
    cwd: state.cwd,
    isStreaming: state.isStreaming,
    isCompacting: state.isCompacting,
    model: state.model
      ? {
          provider: state.model.provider,
          id: state.model.id,
          ...(typeof state.model.contextWindow === "number" ? { contextWindow: state.model.contextWindow } : {}),
        }
      : null,
    stats: state.stats,
    messageCount: state.messages.length,
  };
}

/** Synchronously read the current active session summary without subscribing to internal Zustand slices. */
export function getActiveSessionSnapshot(): ActiveSessionSnapshot {
  return buildActiveSessionSnapshot();
}

/**
 * Subscribe to session, turn, streaming, model, and host reconnection changes.
 * Returns an idempotent unsubscribe function suitable for `ctx.effect(() => ...)`.
 */
export function subscribeSessionActivity(listener: (snapshot: ActiveSessionSnapshot) => void): () => void {
  const offStore = internalUseAppStore.subscribe((state, prev) => {
    if (
      state.sessionId !== prev.sessionId
      || state.sessionFile !== prev.sessionFile
      || state.cwd !== prev.cwd
      || state.isStreaming !== prev.isStreaming
      || state.isCompacting !== prev.isCompacting
      || state.model?.provider !== prev.model?.provider
      || state.model?.id !== prev.model?.id
      || state.messages.length !== prev.messages.length
      || state.stats !== prev.stats
    ) {
      listener(buildActiveSessionSnapshot());
    }
  });
  const offRuntime = internalHarnessRuntimes.subscribe((_runtimeId, event) => {
    if (
      event.type === "turn-start"
      || event.type === "turn-end"
      || event.type === "turn-interrupted"
      || event.type === "compaction-end"
    ) {
      listener(buildActiveSessionSnapshot());
    }
  });
  const offHost = internalHarnessRuntimes.onHostStatus((status) => {
    if (status === "connected") {
      listener(buildActiveSessionSnapshot());
    }
  });
  return () => {
    offStore();
    offRuntime();
    offHost();
  };
}

/** Read-only reactive hook for the active conversation session. */
export function useActiveSession(): ActiveSessionSnapshot {
  const picked = internalUseAppStore(
    useShallow((state) => ({
      sessionId: state.sessionId,
      sessionFile: state.sessionFile,
      cwd: state.cwd,
      isStreaming: state.isStreaming,
      isCompacting: state.isCompacting,
      modelProvider: state.model?.provider ?? null,
      modelId: state.model?.id ?? null,
      modelContextWindow: state.model?.contextWindow,
      stats: state.stats,
      messageCount: state.messages.length,
    })),
  );
  return {
    sessionId: picked.sessionId,
    sessionFile: picked.sessionFile,
    cwd: picked.cwd,
    isStreaming: picked.isStreaming,
    isCompacting: picked.isCompacting,
    model:
      picked.modelProvider !== null && picked.modelId !== null
        ? {
            provider: picked.modelProvider,
            id: picked.modelId,
            ...(typeof picked.modelContextWindow === "number" ? { contextWindow: picked.modelContextWindow } : {}),
          }
        : null,
    stats: picked.stats,
    messageCount: picked.messageCount,
  };
}

/** Read-only reactive hook for the active workspace directory and connection status. */
export function useActiveWorkspace(): ActiveWorkspaceSnapshot {
  return internalUseAppStore(
    useShallow((state) => ({
      cwd: state.cwd,
      connected: state.connection === "running",
      hostConnected: state.hostStatus === "connected",
    })),
  );
}

/** Read-only reactive hook for the active appearance theme and color scheme. */
export function useAppearanceTheme(): AppearanceThemeSnapshot {
  const picked = internalUseAppStore(
    useShallow((state) => ({
      themeId: state.settings?.theme ?? "light",
      accentColor: state.settings?.accentColor ?? "",
    })),
  );
  const domScheme =
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
      ? "dark"
      : picked.themeId.toLowerCase().includes("dark")
        ? "dark"
        : "light";
  return {
    themeId: picked.themeId,
    resolvedScheme: domScheme,
    accentColor: picked.accentColor,
  };
}

/** Read-only reactive hook returning a plugin's persisted configuration merged over `fallback`. */
export function usePluginConfig<T extends object = Record<string, unknown>>(
  pluginId: string,
  fallback?: T,
): T {
  const cwd = internalUseAppStore((state) => state.cwd);
  const fallbackRef = useRef(fallback);
  useEffect(() => {
    fallbackRef.current = fallback;
  }, [fallback]);

  const [config, setConfig] = useState<Record<string, unknown>>(() => ({
    ...((fallback as Record<string, unknown> | undefined) ?? {}),
  }));

  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      try {
        const list = await pluginClient.list(cwd || undefined);
        if (cancelled) return;
        const found = list.find((item) => item.id === pluginId);
        setConfig({
          ...((fallbackRef.current as Record<string, unknown> | undefined) ?? {}),
          ...(found?.config ?? {}),
        });
      } catch {
        // Keep fallback snapshot when running offline or before Host connects.
      }
    };
    void sync();
    const offChanged = pluginClient.onChanged(() => {
      void sync();
    });
    return () => {
      cancelled = true;
      offChanged();
    };
  }, [cwd, pluginId]);

  return config as T;
}

/** Invoke a JSON-RPC method exposed by `qianji-harness` or a Host plugin (`ctx.rpc.method(...)`). */
export async function callHostRpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
  return await internalHarnessRuntimes.call<T>(method, params);
}

/** Open and focus a right workbench tab (`"files"`, `"editor"` / `"code"`, `"review"`, `"preview"`, or any custom plugin tab ID). */
export function openWorkbenchTab(target: string): void {
  if (typeof target !== "string" || target.trim() === "") return;
  internalUseWorkbenchStore.getState().openTab(target.trim());
}

/** Open a workspace file inside the right workbench editor / custom file viewer. */
export async function openWorkspaceFile(path: string, line?: number): Promise<void> {
  const cwd = internalUseAppStore.getState().cwd;
  await internalUseWorkbenchStore.getState().openFile(
    cwd,
    path,
    typeof line === "number" && line > 0 ? { line } : undefined,
  );
}

/** Send or prefill a user prompt in the active conversation composer. */
export async function sendChatPrompt(text: string, options?: SendChatPromptOptions): Promise<boolean> {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (options?.prefillOnly === true) {
    internalUseAppStore.setState({ composerPrefill: text });
    return true;
  }
  return await internalUseAppStore.getState().sendMessage(trimmed, options?.attachments, options?.behavior);
}

/**
 * Open Settings on a category: a built-in id (`"general"`, `"appearance"`, `"providers"`, `"plugins"`)
 * or the `id` of a page from `registerSettingsPage`. Returns `false` before the shell has mounted.
 */
export function openSettingsPage(pageId?: string): boolean {
  return requestOpenSettings(pageId);
}

/** Show a page registered with `ctx.contributions.registerPage` in the main stage. */
export function openPluginPage(pageId: string): boolean {
  return requestOpenHubPage(pageId);
}

/** Display a non-blocking toast notification in the bottom-right notification stack. */
export function showToast(message: string, kind: "info" | "success" | "warning" | "error" = "info"): void {
  internalUseAppStore.getState().showToast(message, kind === "success" ? "info" : kind);
}

export {
  CLIENT_SLOT_CATALOG,
  clientContributions,
  useClientContributions,
  rewindController,
  messageImagesToAttachments,
};

export type {
  AppearanceScope,
  AppearanceThemeDefinition,
  AppearanceThemeInput,
  AttachmentPayload,
  BuiltinSettingsPageId,
  ClientActionContribution,
  ClientCodeBlockRendererContribution,
  ClientComposerStatusContribution,
  ClientContributionsSnapshot,
  ClientFileViewerContribution,
  ClientHomeQuickActionContribution,
  ClientKeybindingContribution,
  ClientMenuContextMap,
  ClientMenuItemContribution,
  ClientMenuItemFor,
  ClientMenuLocation,
  ClientMessageActionContribution,
  ClientPageContribution,
  ClientRewindHandlerContribution,
  ClientSettingsPageContribution,
  ClientSettingsSectionContribution,
  ClientSidebarSectionContribution,
  ClientSlashInterceptorContribution,
  ClientSlotMetadata,
  ClientStatusBarContribution,
  ClientToolRendererContribution,
  ClientWorkbenchTabContribution,
  CodeBlockRendererSlotContext,
  ComposerDraftSnapshot,
  FileMenuContext,
  FileViewerSlotContext,
  HomeQuickActionSlotContext,
  MessageActionSlotContext,
  PerformedRewindResult,
  ProjectMenuContext,
  RewindExecutionResult,
  RewindInspection,
  RewindMode,
  RewindTargetSummary,
  RewindTurnSummary,
  SessionMenuContext,
  SettingsSlotContext,
  ThemePalette,
  ToolRendererSlotContext,
  UiMessage,
  UiToolCall,
  WorkbenchSlotContext,
};

/**
 * @deprecated Internal host store. Prefer `useActiveSession`, `useActiveWorkspace`, `useAppearanceTheme`, `sendChatPrompt`, and `showToast`.
 */
export const useAppStore = internalUseAppStore;

/**
 * @deprecated Internal host runtime transport. Prefer `callHostRpc`, `useHostRpcQuery`, and `subscribeSessionActivity`.
 */
export const harnessRuntimes = internalHarnessRuntimes;

/**
 * @deprecated Internal workbench store. Prefer `openWorkbenchTab` and `openWorkspaceFile`.
 */
export const useWorkbenchStore = internalUseWorkbenchStore;

/**
 * @deprecated Internal desktop IPC bridge. Prefer `callHostRpc` and `@qianji/client` controlled actions.
 */
export const agent = internalAgent;

export const qianjiClientSdk = {
  // Stable Hooks
  useActiveSession,
  useActiveWorkspace,
  useAppearanceTheme,
  usePluginConfig,
  useHostRpcQuery,
  useClientContributions,
  // Controlled Actions & Helpers
  callHostRpc,
  openWorkbenchTab,
  openWorkspaceFile,
  openSettingsPage,
  openPluginPage,
  sendChatPrompt,
  showToast,
  getActiveSessionSnapshot,
  subscribeSessionActivity,
  // Contributions & Rewind
  CLIENT_SLOT_CATALOG,
  clientContributions,
  rewindController,
  messageImagesToAttachments,
  // Deprecated Legacy Compatibility Exports
  useAppStore: internalUseAppStore,
  harnessRuntimes: internalHarnessRuntimes,
  useWorkbenchStore: internalUseWorkbenchStore,
  agent: internalAgent,
};
