import { create } from "zustand";
import type { WorkbenchOpenNotification, WorkbenchPreviewUrlResult } from "@qianji/protocol";
import { agent } from "../lib/agent";
import { clientContributions } from "../lib/clientContributions";
import { describeError } from "../lib/errors";
import { harnessRuntimes, isRpcMethodNotFound } from "../lib/harnessRuntime";
import { normalizeLocalPath, sameLocalPath } from "../lib/pathIdentity";

export type BuiltinWorkbenchTab =
  | "files"
  | "editor"
  | "review"
  | "preview"
  | "summary"
  | "side-chat";

export type WorkbenchFileViewMode = "preview" | "split" | "code";
export type WorkbenchPreviewKind = "html" | "svg" | "markdown" | null;

export function previewKindForPath(filePath: string): WorkbenchPreviewKind {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "svg") return "svg";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  return null;
}

export function matchesWorkbenchFileCwd(
  fileCwd: string | undefined,
  targetCwd: string | undefined,
): boolean {
  if (!fileCwd) return true;
  if (!targetCwd) return false;
  return sameLocalPath(fileCwd, targetCwd);
}

export function resolveWorkspaceActiveFilePath(
  state: {
    openFiles: readonly OpenWorkbenchFile[];
    activeFilePath: string | null;
    activeFileCwd: string | null;
    activeFilePathByWorkspace: Readonly<Record<string, string | null>>;
  },
  cwd: string | undefined,
): string | null {
  const workspaceFiles = state.openFiles.filter((item) => matchesWorkbenchFileCwd(item.cwd, cwd));
  if (workspaceFiles.length === 0) return null;
  const workspaceKey = cwd ? normalizeLocalPath(cwd) : "";
  const preferred = (workspaceKey ? state.activeFilePathByWorkspace[workspaceKey] : undefined)
    ?? (matchesWorkbenchFileCwd(state.activeFileCwd ?? undefined, cwd) ? state.activeFilePath : null);
  return preferred && workspaceFiles.some((item) => item.path === preferred)
    ? preferred
    : workspaceFiles[0]?.path ?? null;
}

function normalizeWorkbenchTabId(tab: string): string {
  const trimmed = tab.trim();
  if (
    trimmed === "code"
    && !clientContributions.getSnapshot().rightWorkbenchTabs.some((entry) => entry.id === "code")
  ) {
    return "editor";
  }
  return trimmed || "files";
}

export async function resolveWorkspacePreviewUrl(cwd: string, path: string): Promise<string | null> {
  if (!cwd.trim() || !path.trim()) return null;
  try {
    const res = await harnessRuntimes.call<WorkbenchPreviewUrlResult>("workbench.previewUrl", { cwd, path });
    return res.url ?? null;
  } catch (error) {
    if (isRpcMethodNotFound(error)) return null;
    return null;
  }
}

export interface OpenWorkbenchFile {
  cwd?: string;
  path: string;
  content: string;
  savedContent: string;
  size: number;
  truncated: boolean;
  isBinary: boolean;
  mimeType?: string;
  data?: string;
  loading: boolean;
  saving?: boolean;
  error?: string;
  line?: number;
  endLine?: number;
  lineNonce?: number;
  viewMode?: WorkbenchFileViewMode;
}

export interface OpenFileOptions {
  line?: number;
  endLine?: number;
  viewMode?: WorkbenchFileViewMode;
}

function normalizeRelativeWorkspacePath(cwd: string, rawPath: string): {
  path: string;
  parsedLine?: number;
} {
  let trimmed = rawPath.trim();
  let parsedLine: number | undefined;
  // Strip optional `:line` or `:line:col` suffix unless part of a Windows drive letter (`C:\...`).
  const lineMatch = /^(.*?):(\d+)(?::\d+)?$/.exec(trimmed);
  if (lineMatch && lineMatch[1] && !/^[A-Za-z]$/.test(lineMatch[1])) {
    trimmed = lineMatch[1];
    const lineNum = Number.parseInt(lineMatch[2] ?? "", 10);
    if (Number.isFinite(lineNum) && lineNum > 0) parsedLine = lineNum;
  }

  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  let normalizedPath = trimmed.replace(/\\/g, "/");
  if (
    normalizedCwd !== ""
    && normalizedPath.toLowerCase().startsWith(`${normalizedCwd.toLowerCase()}/`)
  ) {
    normalizedPath = normalizedPath.slice(normalizedCwd.length + 1);
  }
  normalizedPath = normalizedPath.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
  return { path: normalizedPath || trimmed, parsedLine };
}

function findTargetFileIndex(
  files: OpenWorkbenchFile[],
  path: string,
  explicitCwd: string | undefined,
  fallbackCwd: string | null,
): number {
  if (explicitCwd !== undefined) {
    return files.findIndex(
      (item) => item.path === path && matchesWorkbenchFileCwd(item.cwd, explicitCwd),
    );
  }
  if (fallbackCwd) {
    const scopedIdx = files.findIndex(
      (item) => item.path === path && matchesWorkbenchFileCwd(item.cwd, fallbackCwd),
    );
    if (scopedIdx >= 0) return scopedIdx;
  }
  return files.findIndex((item) => item.path === path);
}

export interface WorkbenchState {
  rightOpen: boolean;
  rightMaximized: boolean;
  activeTab: string;
  openFiles: OpenWorkbenchFile[];
  activeFilePath: string | null;
  activeFileCwd: string | null;
  activeFilePathByWorkspace: Record<string, string | null>;
  previewUrl: string;
  summaryFocus: "overview" | "diagnostics";
  bottomOpen: boolean;
  activeBottomTab: string;
  terminalCreateNonce: number;

  toggleRight: () => void;
  setRightOpen: (open: boolean) => void;
  toggleRightMaximized: () => void;
  openTab: (tab: string) => void;
  openFilesTab: () => void;
  openFile: (cwd: string, rawPath: string, options?: OpenFileOptions) => Promise<void>;
  reloadFile: (cwd: string, path: string) => Promise<void>;
  selectFile: (path: string, cwd?: string) => void;
  setFileViewMode: (path: string, mode: WorkbenchFileViewMode, cwd?: string) => void;
  updateFileContent: (path: string, content: string, cwd?: string) => void;
  saveFile: (cwd: string, path: string) => Promise<boolean>;
  closeFile: (path: string, cwd?: string) => void;
  openReview: () => void;
  openPreview: (url?: string) => void;
  setPreviewUrl: (url: string) => void;
  openSummary: (focus?: "overview" | "diagnostics") => void;
  openSideChat: () => void;
  toggleBottom: () => void;
  setBottomOpen: (open: boolean) => void;
  openBottomTerminal: () => void;
  requestNewTerminal: () => void;
  setActiveBottomTab: (tab: string) => void;
  resetForTest: () => void;
}

const initialState = {
  rightOpen: false,
  rightMaximized: false,
  activeTab: "files",
  openFiles: [] as OpenWorkbenchFile[],
  activeFilePath: null as string | null,
  activeFileCwd: null as string | null,
  activeFilePathByWorkspace: {} as Record<string, string | null>,
  previewUrl: "",
  summaryFocus: "overview" as "overview" | "diagnostics",
  bottomOpen: false,
  activeBottomTab: "terminal",
  terminalCreateNonce: 0,
};

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  ...initialState,

  toggleRight: () => set((state) => ({
    rightOpen: !state.rightOpen,
    rightMaximized: state.rightOpen ? false : state.rightMaximized,
  })),

  setRightOpen: (open) => set((state) => ({
    rightOpen: open,
    rightMaximized: open ? state.rightMaximized : false,
  })),

  toggleRightMaximized: () => set((state) => ({
    rightOpen: true,
    rightMaximized: !state.rightMaximized,
  })),

  openTab: (tab) => set({ rightOpen: true, activeTab: normalizeWorkbenchTabId(tab) }),

  openFilesTab: () => set({ rightOpen: true, activeTab: "files" }),

  openFile: async (cwd, rawPath, options) => {
    if (!cwd || !rawPath.trim()) {
      set({ rightOpen: true, activeTab: "files" });
      return;
    }
    const { path, parsedLine } = normalizeRelativeWorkspacePath(cwd, rawPath);
    const workspaceKey = normalizeLocalPath(cwd);
    const line = options?.line ?? parsedLine;
    const endLine = options?.endLine;
    const kind = previewKindForPath(path);
    const defaultViewMode: WorkbenchFileViewMode = options?.viewMode ?? (
      line ? "code" : (kind === "html" || kind === "svg" ? "preview" : "code")
    );
    const existing = get().openFiles.find(
      (item) => item.path === path && matchesWorkbenchFileCwd(item.cwd, cwd),
    );
    const nextLineNonce = line !== undefined ? (existing?.lineNonce ?? 0) + 1 : existing?.lineNonce;

    if (existing && !existing.error) {
      const nextMode: WorkbenchFileViewMode = options?.viewMode
        ?? (line ? "code" : (existing.viewMode ?? defaultViewMode));
      set((state) => ({
        rightOpen: true,
        activeTab: "editor",
        activeFilePath: path,
        activeFileCwd: cwd,
        activeFilePathByWorkspace: workspaceKey
          ? { ...state.activeFilePathByWorkspace, [workspaceKey]: path }
          : state.activeFilePathByWorkspace,
        openFiles: state.openFiles.map((item) => (
          item.path === path && matchesWorkbenchFileCwd(item.cwd, cwd)
            ? { ...item, cwd, line, endLine, lineNonce: nextLineNonce, viewMode: nextMode }
            : item
        )),
      }));
      // Preserve unsaved edits; refresh clean files in background.
      if (existing.content !== existing.savedContent) return;
    } else {
      const placeholder: OpenWorkbenchFile = {
        cwd,
        path,
        content: existing?.content ?? "",
        savedContent: existing?.savedContent ?? "",
        size: existing?.size ?? 0,
        truncated: false,
        isBinary: false,
        loading: true,
        line,
        endLine,
        lineNonce: nextLineNonce,
        viewMode: defaultViewMode,
      };
      set((state) => ({
        rightOpen: true,
        activeTab: "editor",
        activeFilePath: path,
        activeFileCwd: cwd,
        activeFilePathByWorkspace: workspaceKey
          ? { ...state.activeFilePathByWorkspace, [workspaceKey]: path }
          : state.activeFilePathByWorkspace,
        openFiles: existing
          ? state.openFiles.map((item) => (
              item.path === path && matchesWorkbenchFileCwd(item.cwd, cwd) ? placeholder : item
            ))
          : [...state.openFiles, placeholder],
      }));
    }

    try {
      const loaded = await agent.readWorkspaceFile(cwd, path);
      set((state) => ({
        openFiles: state.openFiles.map((item) => {
          if (item.path !== path || !matchesWorkbenchFileCwd(item.cwd, cwd)) return item;
          // Do not clobber user edits typed while background refresh was in flight.
          if (!item.loading && item.content !== item.savedContent) return item;
          const text = loaded.text ?? "";
          const bumpLineNonce = item.line !== undefined && text !== item.content ? 1 : 0;
          return {
            cwd,
            path,
            content: text,
            savedContent: text,
            size: loaded.size,
            truncated: loaded.truncated,
            isBinary: loaded.isBinary,
            mimeType: loaded.mimeType ?? undefined,
            data: loaded.data ?? undefined,
            loading: false,
            error: undefined,
            line: item.line,
            endLine: item.endLine,
            lineNonce: (item.lineNonce ?? 0) + bumpLineNonce,
            viewMode: item.viewMode ?? defaultViewMode,
          };
        }),
      }));
    } catch (error) {
      set((state) => ({
        openFiles: state.openFiles.map((item) => (
          item.path === path && matchesWorkbenchFileCwd(item.cwd, cwd)
            ? { ...item, loading: false, error: describeError(error) }
            : item
        )),
      }));
    }
  },

  reloadFile: async (cwd, path) => {
    if (!cwd || !path) return;
    set((state) => ({
      openFiles: state.openFiles.map((item) => (
        item.path === path && matchesWorkbenchFileCwd(item.cwd, cwd)
          ? { ...item, loading: true, error: undefined }
          : item
      )),
    }));
    try {
      const loaded = await agent.readWorkspaceFile(cwd, path);
      const text = loaded.text ?? "";
      set((state) => ({
        openFiles: state.openFiles.map((item) => (
          item.path === path && matchesWorkbenchFileCwd(item.cwd, cwd)
            ? {
                ...item,
                cwd: item.cwd ?? cwd,
                content: text,
                savedContent: text,
                size: loaded.size,
                truncated: loaded.truncated,
                isBinary: loaded.isBinary,
                mimeType: loaded.mimeType ?? undefined,
                data: loaded.data ?? undefined,
                loading: false,
                error: undefined,
              }
            : item
        )),
      }));
    } catch (error) {
      set((state) => ({
        openFiles: state.openFiles.map((item) => (
          item.path === path && matchesWorkbenchFileCwd(item.cwd, cwd)
            ? { ...item, loading: false, error: describeError(error) }
            : item
        )),
      }));
    }
  },

  selectFile: (path, cwd) => set((state) => {
    const resolvedCwd = cwd ?? state.activeFileCwd ?? undefined;
    const workspaceKey = resolvedCwd ? normalizeLocalPath(resolvedCwd) : "";
    return {
      rightOpen: true,
      activeTab: "editor",
      activeFilePath: path,
      activeFileCwd: resolvedCwd ?? state.activeFileCwd,
      activeFilePathByWorkspace: workspaceKey
        ? { ...state.activeFilePathByWorkspace, [workspaceKey]: path }
        : state.activeFilePathByWorkspace,
    };
  }),

  setFileViewMode: (path, mode, cwd) => set((state) => {
    const idx = findTargetFileIndex(state.openFiles, path, cwd, state.activeFileCwd);
    if (idx < 0) return state;
    return {
      openFiles: state.openFiles.map((item, i) => (
        i === idx ? { ...item, viewMode: mode } : item
      )),
    };
  }),

  updateFileContent: (path, content, cwd) => set((state) => {
    const idx = findTargetFileIndex(state.openFiles, path, cwd, state.activeFileCwd);
    if (idx < 0) return state;
    return {
      openFiles: state.openFiles.map((item, i) => (
        i === idx ? { ...item, content } : item
      )),
    };
  }),

  saveFile: async (cwd, path) => {
    const target = get().openFiles.find(
      (item) => item.path === path && matchesWorkbenchFileCwd(item.cwd, cwd),
    );
    if (!cwd || !target || target.isBinary || target.truncated) return false;
    const contentToSave = target.content;
    set((state) => ({
      openFiles: state.openFiles.map((item) => (
        item.path === path && matchesWorkbenchFileCwd(item.cwd, cwd)
          ? { ...item, saving: true, error: undefined }
          : item
      )),
    }));
    try {
      await agent.writeWorkspaceFile(cwd, path, contentToSave);
      set((state) => ({
        openFiles: state.openFiles.map((item) => (
          item.path === path && matchesWorkbenchFileCwd(item.cwd, cwd)
            ? { ...item, cwd: item.cwd ?? cwd, savedContent: contentToSave, saving: false, error: undefined }
            : item
        )),
      }));
      return true;
    } catch (error) {
      set((state) => ({
        openFiles: state.openFiles.map((item) => (
          item.path === path && matchesWorkbenchFileCwd(item.cwd, cwd)
            ? { ...item, saving: false, error: describeError(error) }
            : item
        )),
      }));
      return false;
    }
  },

  closeFile: (path, cwd) => set((state) => {
    const index = findTargetFileIndex(state.openFiles, path, cwd, state.activeFileCwd);
    if (index < 0) return state;
    const closedItem = state.openFiles[index];
    const effectiveCwd = cwd ?? closedItem?.cwd ?? state.activeFileCwd ?? undefined;
    const remaining = state.openFiles.filter((_, i) => i !== index);
    const scopedRemaining = effectiveCwd
      ? remaining.filter((item) => matchesWorkbenchFileCwd(item.cwd, effectiveCwd))
      : remaining;
    const closedScopedIndex = effectiveCwd
      ? state.openFiles
          .filter((item) => matchesWorkbenchFileCwd(item.cwd, effectiveCwd))
          .findIndex((item) => item === closedItem)
      : index;
    const replacementPath = scopedRemaining[closedScopedIndex]?.path
      ?? scopedRemaining[closedScopedIndex - 1]?.path
      ?? null;
    const workspaceKey = effectiveCwd ? normalizeLocalPath(effectiveCwd) : "";
    const currentWorkspaceActive = workspaceKey
      ? state.activeFilePathByWorkspace[workspaceKey]
      : undefined;
    const nextWorkspaceMap = workspaceKey
      ? {
          ...state.activeFilePathByWorkspace,
          [workspaceKey]: currentWorkspaceActive === path ? replacementPath : (currentWorkspaceActive ?? replacementPath),
        }
      : state.activeFilePathByWorkspace;
    const isClosingActiveGlobal = state.activeFilePath === path
      && matchesWorkbenchFileCwd(closedItem?.cwd, state.activeFileCwd ?? undefined);
    const nextActive = isClosingActiveGlobal ? replacementPath : state.activeFilePath;
    return {
      openFiles: remaining,
      activeFilePath: nextActive,
      activeFilePathByWorkspace: nextWorkspaceMap,
    };
  }),

  openReview: () => set({ rightOpen: true, activeTab: "review" }),

  openPreview: (url) => set((state) => ({
    rightOpen: true,
    activeTab: "preview",
    previewUrl: url !== undefined ? url : state.previewUrl,
  })),

  setPreviewUrl: (url) => set({ previewUrl: url }),

  openSummary: (focus = "overview") => set({
    rightOpen: true,
    activeTab: "summary",
    summaryFocus: focus,
  }),

  openSideChat: () => set({ rightOpen: true, activeTab: "side-chat" }),

  toggleBottom: () => set((state) => ({ bottomOpen: !state.bottomOpen })),

  setBottomOpen: (open) => set({ bottomOpen: open }),

  openBottomTerminal: () => set({ bottomOpen: true, activeBottomTab: "terminal" }),

  requestNewTerminal: () => set((state) => ({
    bottomOpen: true,
    activeBottomTab: "terminal",
    terminalCreateNonce: state.terminalCreateNonce + 1,
  })),

  setActiveBottomTab: (tab) => set({ bottomOpen: true, activeBottomTab: tab }),

  resetForTest: () => set({ ...initialState }),
}));

/** Apply a `workbench/open` notification from the Host (`sidebar_open` tool / `workbench.open` RPC). */
export function applyWorkbenchOpenNotification(
  payload: WorkbenchOpenNotification,
  fallbackCwd: string,
): void {
  const store = useWorkbenchStore.getState();
  const targetCwd = payload.cwd || fallbackCwd;
  switch (payload.target) {
    case "terminal":
      store.openBottomTerminal();
      break;
    case "files":
      store.openFilesTab();
      break;
    case "editor":
    case "code":
      if (
        payload.target === "code"
        && clientContributions.getSnapshot().rightWorkbenchTabs.some((tab) => tab.id === "code")
      ) {
        store.openTab("code");
        break;
      }
      if (payload.path && targetCwd) {
        void store.openFile(targetCwd, payload.path, {
          line: payload.line,
          endLine: payload.endLine,
        });
      } else {
        store.openTab("editor");
      }
      break;
    case "review":
      store.openReview();
      break;
    case "preview":
      store.openPreview(payload.url);
      break;
    case "summary":
      store.openSummary("overview");
      break;
    case "side-chat":
      store.openSideChat();
      break;
    default: {
      const targetId = payload.target?.trim();
      if (targetId) {
        const isBottomPluginTab = clientContributions
          .getSnapshot()
          .bottomPanelTabs.some((tab) => tab.id === targetId);
        if (isBottomPluginTab) {
          store.setActiveBottomTab(targetId);
        } else {
          store.openTab(targetId);
        }
      }
      break;
    }
  }
}

export function bindWorkbenchNotifications(getContext: () => { cwd: string }): () => void {
  return harnessRuntimes.onNotification("workbench/open", (params) => {
    if (!params || typeof params !== "object") return;
    applyWorkbenchOpenNotification(params as WorkbenchOpenNotification, getContext().cwd);
  });
}
