/**
 * Handing the workspace and its files to other apps: the topbar "open in"
 * button, and a shared file-path menu (preview, open in editor at a line,
 * reveal in Explorer, copy path) that any file reference can use.
 */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Copy, Eye, FolderOpen, PanelBottom, Paperclip, SquareTerminal } from "lucide-react";
import { describeError } from "../lib/errors";
import { pi } from "../lib/pi";
import { relativeWorkspacePath, resolveWorkspacePath } from "../lib/workspaceEditors";
import type { TerminalAppInfo, WorkspaceEditorInfo } from "../types";

const ANTIGRAVITY_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAALlSURBVFhH7dbZS1RxGMbxtj8m6q5odNQ0jYLSFipDxDAiqDAvijCihWzDObPokDZaWZGVaEk7XbRDi0EbUUGLF0abZFakjjnOfMOkXzPPzEmjueiiz+X5Pe/7MGc4nDNq1H//KmA0SaK7hwVs0SV/SztsARt1OFm0Kw4wRoeSTTtjABEdsPP25Hi6aibQs2Ey35amQmTEo8e119CkndYbGTw8l86L+kze7cjhS0k2wYJsjdkZ0F5Dk3aars/n1Ll8rjYU8shXyKuyhXQtm0PvrAyNJqS9hgYT8d0qpuLyarxn17P/2GZO12yitXwNL0uX86FoscYT0l5DgyocCbP2Shmrzrsoaalj/ZEGvHUNNLprubZhF09WrCV4/6GOxdFeQ4PKe6+OwjN+FjQ3sujoRYoO3KIk0Mp23xXqy09wYV2Auyu36Vgc7TU0qPLPVjO7qYUZh24wY99TcmvbWbi7nRWVbWxyPaBm6yVayhp1LI72GhpUM5tOknXwNlPrXpJZ3UGW/wszq7qZ5/tEsec9ZRXP8W67o2NxtNfQoMo40Ep6oA2n/yOp3h5SrH6cVogsd4hcdy9LPJ9ZY71my9bHOhpDew0NRpu87ybOQBupVR9xuPtIsQboHxg6m1geYaoVJtfTT1FlN6W+Th2Pob2GBqM5al/g8HcyxR2ktDmsxz9MsyLk+QYo8vcRThz5QXsNDUZzVHfg8PWQ4g7pkbH9PGS7I8ytDFO8xz6nvYYGf0oLvMHp/4rD0z/syyLdFSHHE2Fulf0t0F5Dgz9N2/OZtMo+nG77pdHSXDDdo1d/0V5Dg4Ny67vIqQ6S5rW/pWrSTsiwYLpPT4Zor6HBjq9h8vb2ku0P/cHbdsiUCki3IMcbP6i9hgaXHA6SFwgRjt8xIqkuyPLC0kMxC0Laa0SnBn+xdXFk//nvPOvQKyzS3hiaTjbtS0iHkmicdtnSySQYqx3DApoHv+F00x8YfHYLdO9//5TvWpRbXvydcf8AAAAASUVORK5CYII=";

/** Brand-colored initials for editors without a bundled logo. */
const EDITOR_BADGES: Record<string, { text: string; background: string; color: string }> = {
  zed: { text: "Z", background: "#084ccf", color: "#ffffff" },
  sublime: { text: "S", background: "#ff9800", color: "#ffffff" },
  notepadpp: { text: "N+", background: "#8bd88f", color: "#1b4d1f" },
  idea: { text: "IJ", background: "#fe315d", color: "#ffffff" },
  webstorm: { text: "WS", background: "#07c3f2", color: "#00202a" },
  pycharm: { text: "PC", background: "#21d789", color: "#00281a" },
  rider: { text: "RD", background: "#dd1265", color: "#ffffff" },
  goland: { text: "GO", background: "#0d7bf7", color: "#ffffff" },
  clion: { text: "CL", background: "#21d789", color: "#00281a" },
  rustrover: { text: "RR", background: "#ff8a00", color: "#2a1600" },
  visualstudio: { text: "VS", background: "#5c2d91", color: "#ffffff" },
};

export function WorkspaceEditorIcon({ editorId, size = 16 }: { editorId?: WorkspaceEditorInfo["id"]; size?: number }) {
  if (editorId === "cursor") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect width="24" height="24" rx="5.5" fill="#202124" />
        <path d="M12 5.4 18 8.85 12 12.3 6 8.85 12 5.4Z" fill="#f7f7f7" />
        <path d="M6 8.85 12 12.3v6.3l-6-3.45v-6.3Z" fill="#a7a7a7" />
        <path d="M18 8.85 12 12.3v6.3l6-3.45v-6.3Z" fill="#d7d7d7" />
      </svg>
    );
  }
  if (editorId === "vscode") {
    return (
      <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden>
        <path d="M96.461 10.796 75.857.876c-2.385-1.149-5.235-.664-7.107 1.207L1.299 63.583c-1.815 1.654-1.813 4.511.004 6.162l5.51 5.009c1.485 1.35 3.722 1.45 5.321.237l81.227-61.621c2.725-2.067 6.639-.124 6.639 3.297v-.239c0-2.402-1.375-4.59-3.539-5.632Z" fill="#0065A9" />
        <path d="M96.461 89.204 75.857 99.124c-2.385 1.149-5.235.665-7.107-1.207L1.299 36.417c-1.815-1.654-1.813-4.511.004-6.162l5.51-5.009c1.485-1.35 3.722-1.45 5.321-.236l81.227 61.62c2.725 2.067 6.639.124 6.639-3.297v.24c0 2.401-1.375 4.59-3.539 5.631Z" fill="#007ACC" />
        <path d="M75.858 99.126c-2.386 1.148-5.236.663-7.108-1.209 2.306 2.306 6.25.673 6.25-2.589V4.672c0-3.262-3.944-4.895-6.25-2.589C70.622.211 73.472-.274 75.858.874l20.601 9.907C98.623 11.822 100 14.011 100 16.413v67.174c0 2.402-1.377 4.592-3.541 5.633L75.858 99.126Z" fill="#1F9CF0" />
      </svg>
    );
  }
  if (editorId === "windsurf") {
    return (
      <svg width={size} height={size} viewBox="0 0 1024 1024" fill="none" aria-hidden>
        <path d="M897.246 286.869h-7.427c-39.084-.061-70.802 31.591-70.802 70.67v158.05c0 31.561-26.087 57.127-57.135 57.127-18.446 0-36.862-9.283-47.789-24.866L552.673 317.304c-13.393-19.144-35.187-30.557-58.778-30.557-36.801 0-69.919 31.287-69.919 69.91v158.962c0 31.562-25.873 57.127-57.134 57.127-18.507 0-36.893-9.283-47.821-24.865L138.395 289.882c-4.079-5.844-13.241-2.952-13.241 4.17v137.84c0 6.97 2.131 13.727 6.118 19.448l177.765 253.86c10.502 15.004 25.996 26.144 43.863 30.192 44.716 10.165 85.87-24.257 85.87-68.114V508.406c0-31.561 25.569-57.127 57.134-57.127h.091c19.025 0 36.862 9.283 47.79 24.866l161.45 230.516c13.424 19.174 34.092 30.557 58.748 30.557 37.623 0 69.858-31.318 69.858-69.91V508.376c0-31.561 25.569-57.127 57.134-57.127h6.301c3.957 0 7.154-3.196 7.154-7.152V294.021c0-3.956-3.197-7.152-7.154-7.152h-.03Z" fill="currentColor" />
      </svg>
    );
  }
  if (editorId === "antigravity") {
    return <img src={ANTIGRAVITY_ICON} width={size} height={size} alt="" aria-hidden />;
  }
  const badge = editorId ? EDITOR_BADGES[editorId] : undefined;
  if (badge) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <rect width="24" height="24" rx="5.5" fill={badge.background} />
        <text
          x="12"
          y="12.5"
          textAnchor="middle"
          dominantBaseline="middle"
          fontFamily="Segoe UI, sans-serif"
          fontWeight="700"
          fontSize={badge.text.length > 1 ? 10 : 13}
          fill={badge.color}
        >
          {badge.text}
        </text>
      </svg>
    );
  }
  return <FolderOpen size={size} strokeWidth={1.8} aria-hidden />;
}

interface OpenInMenuProps {
  workspace: string;
  editors: WorkspaceEditorInfo[];
  preferredEditor: WorkspaceEditorInfo | null;
  terminalApps: TerminalAppInfo[];
  /** The main button (and Ctrl+Shift+O): the project's editor, else Explorer. */
  onOpenPreferred: () => void;
  /** Opens the workspace in `editor` and makes it this project's default. */
  onChooseEditor: (editor: WorkspaceEditorInfo) => void;
  onOpenTerminalApp: (app: TerminalAppInfo) => void;
  onReveal: () => void;
  onOpenIntegratedTerminal: () => void;
}

/** The topbar split button: open the project in its editor, or pick another app. */
export function OpenInMenu({
  workspace,
  editors,
  preferredEditor,
  terminalApps,
  onOpenPreferred,
  onChooseEditor,
  onOpenTerminalApp,
  onReveal,
  onOpenIntegratedTerminal,
}: OpenInMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const label = preferredEditor ? `在 ${preferredEditor.name} 中打开` : "在文件资源管理器中打开";
  // "Visual Studio Code" would crowd the topbar; the menu keeps full names.
  const shortName = preferredEditor ? (preferredEditor.id === "vscode" ? "VS Code" : preferredEditor.name) : "资源管理器";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    if (workspace) action();
  };

  return (
    <div className="topbar-menu-wrap workspace-tools-menu" ref={wrapRef}>
      <div className={`topbar-branch-control workspace-launch-control ${open ? "active" : ""}`}>
        <button
          type="button"
          className="workspace-open-trigger"
          title={`${label} (Ctrl+Shift+O)`}
          aria-label={label}
          disabled={!workspace}
          onClick={() => run(onOpenPreferred)}
        >
          <span className={`workspace-tools-mark workspace-editor-${preferredEditor?.id ?? "explorer"}`} aria-hidden>
            <WorkspaceEditorIcon editorId={preferredEditor?.id} size={18} />
          </span>
          <span className="workspace-open-label">{shortName}</span>
        </button>
        <button
          type="button"
          className="workspace-tools-trigger"
          title="选择打开方式"
          aria-label="选择打开方式"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown size={13} strokeWidth={1.75} />
        </button>
      </div>
      {open && (
        <div className="topbar-menu workspace-tools-popover open-in-popover" role="menu">
          {editors.length > 0 && <div className="open-in-section">编辑器 · 本项目默认用所选项</div>}
          {editors.map((editor) => (
            <button role="menuitem" key={editor.id} disabled={!workspace} onClick={() => run(() => onChooseEditor(editor))}>
              <WorkspaceEditorIcon editorId={editor.id} size={16} />
              <span>{editor.name}</span>
              {preferredEditor?.id === editor.id && <Check className="workspace-editor-selected" size={14} />}
            </button>
          ))}
          {editors.length === 0 && <div className="open-in-empty">未检测到已安装的编辑器</div>}
          <div className="workspace-tools-separator" role="separator" />
          <div className="open-in-section">终端</div>
          <button role="menuitem" disabled={!workspace} onClick={() => run(onOpenIntegratedTerminal)}>
            <PanelBottom size={15} />
            <span>应用内终端</span>
            <kbd>Ctrl+J</kbd>
          </button>
          {terminalApps.map((app) => (
            <button role="menuitem" key={app.id} disabled={!workspace} onClick={() => run(() => onOpenTerminalApp(app))}>
              <SquareTerminal size={15} />
              <span>{app.name}</span>
            </button>
          ))}
          <div className="workspace-tools-separator" role="separator" />
          <button role="menuitem" disabled={!workspace} onClick={() => run(onReveal)}>
            <FolderOpen size={15} />
            <span>文件资源管理器</span>
          </button>
        </div>
      )}
    </div>
  );
}

/* ── File actions: one place that knows how to open, reveal and copy a path ── */

export interface FileActions {
  workspace: string;
  editors: WorkspaceEditorInfo[];
  preferredEditor: WorkspaceEditorInfo | null;
  openPreview: (path: string, line?: number) => void;
  /** Opens in the project's editor (or `editor`), at `line` when the editor supports it. */
  openInEditor: (path: string, line?: number, editor?: WorkspaceEditorInfo) => void;
  reveal: (path: string) => void;
  /** Right-click menu for a file path. */
  showMenu: (event: ReactMouseEvent, path: string, line?: number) => void;
}

export const FileActionsContext = createContext<FileActions | null>(null);

export function useFileActions(): FileActions | null {
  return useContext(FileActionsContext);
}

interface FileActionsProviderProps {
  workspace: string;
  editors: WorkspaceEditorInfo[];
  preferredEditor: WorkspaceEditorInfo | null;
  onOpenPreview: (path: string, line?: number) => void;
  onAddToChat?: (path: string) => void;
  onNotify: (message: string, tone: "info" | "error") => void;
  children: ReactNode;
}

interface MenuState {
  x: number;
  y: number;
  path: string;
  line?: number;
}

export function FileActionsProvider({
  workspace,
  editors,
  preferredEditor,
  onOpenPreview,
  onAddToChat,
  onNotify,
  children,
}: FileActionsProviderProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const actions = useMemo<FileActions>(() => {
    const reveal = (path: string) => {
      if (!inTauri) return;
      void pi.revealPathInFileManager(resolveWorkspacePath(workspace, path)).catch((error) => {
        onNotify(`无法在资源管理器中显示：${describeError(error)}`, "error");
      });
    };
    const openInEditor = (path: string, line?: number, editor = preferredEditor ?? undefined) => {
      if (!editor) {
        onNotify("未检测到可用的编辑器，已改为在资源管理器中显示", "info");
        reveal(path);
        return;
      }
      if (!inTauri) return;
      void pi.openFileInEditor(resolveWorkspacePath(workspace, path), editor.id, {
        line: line && line > 0 ? line : undefined,
        workspace: workspace || undefined,
      }).catch((error) => onNotify(`无法在 ${editor.name} 中打开：${describeError(error)}`, "error"));
    };
    return {
      workspace,
      editors,
      preferredEditor,
      openPreview: onOpenPreview,
      openInEditor,
      reveal,
      showMenu: (event, path, line) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY, path, line });
      },
    };
  }, [editors, inTauri, onNotify, onOpenPreview, preferredEditor, workspace]);

  return (
    <FileActionsContext.Provider value={actions}>
      {children}
      {menu && (
        <FilePathMenu
          menu={menu}
          actions={actions}
          onAddToChat={onAddToChat}
          onNotify={onNotify}
          onClose={() => setMenu(null)}
        />
      )}
    </FileActionsContext.Provider>
  );
}

function FilePathMenu({
  menu,
  actions,
  onAddToChat,
  onNotify,
  onClose,
}: {
  menu: MenuState;
  actions: FileActions;
  onAddToChat?: (path: string) => void;
  onNotify: (message: string, tone: "info" | "error") => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { workspace, editors, preferredEditor } = actions;
  const others = editors.filter((editor) => editor.id !== preferredEditor?.id);
  const lineLabel = menu.line ? `（第 ${menu.line} 行）` : "";

  // Keep the menu on screen: flip it left/up when it would overflow.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
    element.style.top = `${menu.y + rect.height > window.innerHeight - 8 ? Math.max(8, menu.y - rect.height) : menu.y}px`;
  }, [menu.x, menu.y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const act = (action: () => void) => () => {
    onClose();
    action();
  };
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text)
      .then(() => onNotify("已复制路径", "info"))
      .catch(() => onNotify("无法访问剪贴板", "error"));
  };
  const absolute = resolveWorkspacePath(workspace, menu.path);

  return createPortal(
    <div
      ref={ref}
      className="file-context-menu"
      role="menu"
      aria-label={menu.path}
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="file-context-menu-title" title={absolute}>{relativeWorkspacePath(workspace, menu.path)}{menu.line ? `:${menu.line}` : ""}</div>
      <button type="button" role="menuitem" onClick={act(() => actions.openPreview(menu.path, menu.line))}>
        <Eye size={14} /><span>在应用内预览{lineLabel}</span>
      </button>
      {preferredEditor && (
        <button type="button" role="menuitem" onClick={act(() => actions.openInEditor(menu.path, menu.line, preferredEditor))}>
          <WorkspaceEditorIcon editorId={preferredEditor.id} size={14} />
          <span>在 {preferredEditor.name} 中打开{preferredEditor.supportsLine ? lineLabel : ""}</span>
          <kbd>Ctrl+单击</kbd>
        </button>
      )}
      {others.length > 0 && <div className="file-context-menu-section">用其他编辑器打开</div>}
      {others.map((editor) => (
        <button type="button" role="menuitem" key={editor.id} onClick={act(() => actions.openInEditor(menu.path, menu.line, editor))}>
          <WorkspaceEditorIcon editorId={editor.id} size={14} />
          <span>{editor.name}</span>
        </button>
      ))}
      <div className="file-context-menu-separator" role="separator" />
      <button type="button" role="menuitem" onClick={act(() => actions.reveal(menu.path))}>
        <FolderOpen size={14} /><span>在文件资源管理器中显示</span>
      </button>
      {onAddToChat && (
        <button type="button" role="menuitem" onClick={act(() => onAddToChat(menu.path))}>
          <Paperclip size={14} /><span>添加到聊天</span>
        </button>
      )}
      <button type="button" role="menuitem" onClick={act(() => copy(absolute))}>
        <Copy size={14} /><span>复制路径</span>
      </button>
      <button type="button" role="menuitem" onClick={act(() => copy(relativeWorkspacePath(workspace, menu.path)))}>
        <Copy size={14} /><span>复制相对路径</span>
      </button>
    </div>,
    document.body,
  );
}
