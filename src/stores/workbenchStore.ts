import { create } from "zustand";
import type { WorkbenchOpenNotification } from "@pid/protocol";
import { agent } from "../lib/agent";
import { describeError } from "../lib/errors";
import { harnessRuntimes } from "../lib/harnessRuntime";

export type BuiltinWorkbenchTab =
  | "files"
  | "editor"
  | "review"
  | "preview"
  | "summary"
  | "side-chat";

export interface OpenWorkbenchFile {
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
}

export interface OpenFileOptions {
  line?: number;
  endLine?: number;
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

export interface WorkbenchState {
  rightOpen: boolean;
  rightMaximized: boolean;
  activeTab: string;
  openFiles: OpenWorkbenchFile[];
  activeFilePath: string | null;
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
  selectFile: (path: string) => void;
  updateFileContent: (path: string, content: string) => void;
  saveFile: (cwd: string, path: string) => Promise<boolean>;
  closeFile: (path: string) => void;
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

  openTab: (tab) => set({ rightOpen: true, activeTab: tab }),

  openFilesTab: () => set({ rightOpen: true, activeTab: "files" }),

  openFile: async (cwd, rawPath, options) => {
    if (!cwd || !rawPath.trim()) {
      set({ rightOpen: true, activeTab: "files" });
      return;
    }
    const { path, parsedLine } = normalizeRelativeWorkspacePath(cwd, rawPath);
    const line = options?.line ?? parsedLine;
    const endLine = options?.endLine;
    const existing = get().openFiles.find((item) => item.path === path);

    if (existing && !existing.error) {
      set((state) => ({
        rightOpen: true,
        activeTab: "editor",
        activeFilePath: path,
        openFiles: state.openFiles.map((item) => (
          item.path === path ? { ...item, line, endLine } : item
        )),
      }));
      // Preserve unsaved edits; refresh clean files in background.
      if (existing.content !== existing.savedContent) return;
    } else {
      const placeholder: OpenWorkbenchFile = {
        path,
        content: existing?.content ?? "",
        savedContent: existing?.savedContent ?? "",
        size: existing?.size ?? 0,
        truncated: false,
        isBinary: false,
        loading: true,
        line,
        endLine,
      };
      set((state) => ({
        rightOpen: true,
        activeTab: "editor",
        activeFilePath: path,
        openFiles: existing
          ? state.openFiles.map((item) => (item.path === path ? placeholder : item))
          : [...state.openFiles, placeholder],
      }));
    }

    try {
      const loaded = await agent.readWorkspaceFile(cwd, path);
      set((state) => ({
        openFiles: state.openFiles.map((item) => {
          if (item.path !== path) return item;
          // Do not clobber user edits typed while background refresh was in flight.
          if (!item.loading && item.content !== item.savedContent) return item;
          const text = loaded.text ?? "";
          return {
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
          };
        }),
      }));
    } catch (error) {
      set((state) => ({
        openFiles: state.openFiles.map((item) => (
          item.path === path
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
        item.path === path ? { ...item, loading: true, error: undefined } : item
      )),
    }));
    try {
      const loaded = await agent.readWorkspaceFile(cwd, path);
      const text = loaded.text ?? "";
      set((state) => ({
        openFiles: state.openFiles.map((item) => (
          item.path === path
            ? {
                ...item,
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
          item.path === path
            ? { ...item, loading: false, error: describeError(error) }
            : item
        )),
      }));
    }
  },

  selectFile: (path) => set({ rightOpen: true, activeTab: "editor", activeFilePath: path }),

  updateFileContent: (path, content) => set((state) => ({
    openFiles: state.openFiles.map((item) => (
      item.path === path ? { ...item, content } : item
    )),
  })),

  saveFile: async (cwd, path) => {
    const target = get().openFiles.find((item) => item.path === path);
    if (!cwd || !target || target.isBinary || target.truncated) return false;
    set((state) => ({
      openFiles: state.openFiles.map((item) => (
        item.path === path ? { ...item, saving: true, error: undefined } : item
      )),
    }));
    try {
      await agent.writeWorkspaceFile(cwd, path, target.content);
      set((state) => ({
        openFiles: state.openFiles.map((item) => (
          item.path === path
            ? { ...item, savedContent: target.content, saving: false, error: undefined }
            : item
        )),
      }));
      return true;
    } catch (error) {
      set((state) => ({
        openFiles: state.openFiles.map((item) => (
          item.path === path
            ? { ...item, saving: false, error: describeError(error) }
            : item
        )),
      }));
      return false;
    }
  },

  closeFile: (path) => set((state) => {
    const index = state.openFiles.findIndex((item) => item.path === path);
    if (index < 0) return state;
    const remaining = state.openFiles.filter((item) => item.path !== path);
    const nextActive = state.activeFilePath === path
      ? (remaining[index]?.path ?? remaining[index - 1]?.path ?? null)
      : state.activeFilePath;
    return {
      openFiles: remaining,
      activeFilePath: nextActive,
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
    default:
      break;
  }
}

export function bindWorkbenchNotifications(getContext: () => { cwd: string }): () => void {
  return harnessRuntimes.onNotification("workbench/open", (params) => {
    if (!params || typeof params !== "object") return;
    applyWorkbenchOpenNotification(params as WorkbenchOpenNotification, getContext().cwd);
  });
}
