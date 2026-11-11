# Frontend `<PluginSlot>` Points & `@qianji/client` SDK

## 1. Client Entry (`client.tsx`)

Client plugins run inside Qianji's React 19 renderer in isolated child Fibers wrapped by `<SlotEntryHost>` error boundaries. If a plugin throws synchronously or violates Hook rules, Qianji isolates the crash to that slot card and reports `clientError` (`phase: "load" | "render"`) back to Host (`qianji_inspect(topic: "plugins")`).

```tsx
import type { Context } from "@deepseek-ai/cordis";
import { Database } from "lucide-react";
import { useActiveSession, useHostRpcQuery, openWorkbenchTab } from "@qianji/client";

function SqliteWorkbenchPanel() {
  const { cwd } = useActiveSession();
  const { data, loading, error, refetch } = useHostRpcQuery<{ tables: string[] }>(
    "sqlite_explorer.listTables",
    { cwd },
  );
  if (loading) return <div>Loading tables…</div>;
  if (error) return <div>Error: {error}</div>;
  return (
    <div className="sqlite-panel">
      <button type="button" onClick={() => void refetch()}>Refresh</button>
      <ul>{(data?.tables ?? []).map((t) => <li key={t}>{t}</li>)}</ul>
    </div>
  );
}

export const name = "sqlite-explorer-client";
export const inject = ["contributions", "styles"];

export function apply(ctx: Context): void {
  ctx.contributions.registerRightWorkbenchTab({
    id: "sqlite-explorer-tab",
    label: "SQLite",
    icon: <Database size={13} />,
    render: () => <SqliteWorkbenchPanel />,
  });

  ctx.contributions.registerTopbarAction({
    id: "sqlite-explorer-open",
    render: () => (
      <button type="button" onClick={() => openWorkbenchTab("sqlite-explorer-tab")}>
        SQLite
      </button>
    ),
  });
}
```

---

## 2. Complete `<PluginSlot>` & Contribution Reference

All methods live on `ctx.contributions` (inject `["contributions"]`) and automatically dispose when the plugin reloads or disables:

| Slot Name | Registration Method | Key Options | `render(ctx)` / Callback Arguments |
| :--- | :--- | :--- | :--- |
| `pages` | `ctx.contributions.registerPage` | `{ id, label, icon?, order?, render }` | `{ cwd, sessionFile }` |
| `leftSidebar` | `ctx.contributions.registerLeftSidebar` | `{ id, order?, render }` | `{ cwd, sessionFile }` |
| `rightWorkbenchTabs` | `ctx.contributions.registerRightWorkbenchTab` | `{ id, label, icon?, order?, render }` | `{ cwd, sessionFile }` |
| `bottomPanelTabs` | `ctx.contributions.registerBottomPanelTab` | `{ id, label, icon?, order?, render }` | `{ cwd, sessionFile }` |
| `topbarActions` | `ctx.contributions.registerTopbarAction` | `{ id, order?, render }` | `{ cwd, sessionFile }` |
| `composerToolbar` | `ctx.contributions.registerComposerToolbar` | `{ id, order?, render }` | `{ cwd, sessionFile, variant }` |
| `composerStatus` | `ctx.contributions.registerComposerStatus` | `{ id, position?: "before-model" \| "after-model", order?, render }` | `{ cwd, sessionFile, variant }` |
| `composerBanners` | `ctx.contributions.registerComposerBanner` | `{ id, order?, render }` | `{ cwd, sessionFile, variant }` |
| `overlays` | `ctx.contributions.registerOverlay` | `{ id, order?, render }` | `{ cwd, sessionFile }` |
| `message.actions` | `ctx.contributions.registerMessageAction` | `{ id, role?: "user" \| "assistant" \| "both", order?, render }` | `{ cwd, sessionFile, message, contentText }` |
| `message.toolRenderer` | `ctx.contributions.registerToolRenderer` | `{ id, toolNames: string[], order?, render }` | `{ cwd, sessionFile, call, state }` |
| `file.viewer` | `ctx.contributions.registerFileViewer` | `{ id, label?, extensions?: string[], mimeTypes?: string[], order?, render }` | `{ cwd, sessionFile, path, content, isBinary, mimeType, dataBase64, size }` |
| `status.bar` | `ctx.contributions.registerStatusBarItem` | `{ id, align?: "left" \| "right", order?, render }` | `{ cwd, sessionFile }` |
| `home.quickActions` | `ctx.contributions.registerHomeQuickAction` | `{ id, label?, icon?, prompt?, order?, onSelect?, render? }` | `{ cwd, sessionFile, prefillComposer, sendPrompt }` |
| `slashInterceptors` | `ctx.contributions.registerSlashInterceptor` | `{ id, order?, onSlashCommand }` | `(name, rawArgs, { cwd, sessionFile }) => boolean \| Promise<boolean>` |
| `rewindHandlers` | `ctx.contributions.registerRewindHandler` | `{ id, order?, onRewindMessage, onOpenTimeline? }` | `(message: UiMessage) => boolean \| Promise<boolean>` |
| `themes` | `ctx.contributions.registerTheme` | `{ id, label, mode, scope?, sourcePath?, palette? }` | Registers an `AppearanceThemeDefinition` |

### High-Value Slot Examples

- **Custom Tool Card (`message.toolRenderer`)**: Render rich UI for your plugin's tools (supports exact names or prefix wildcards like `"sqlite_*"`) without touching host `Message.tsx` or `ToolCall.tsx`:
  ```tsx
  import type { Context } from "@deepseek-ai/cordis";

  export function registerSqliteCard(ctx: Context): void {
    ctx.contributions.registerToolRenderer({
      id: "sqlite-query-card",
      toolNames: ["sqlite_query", "sqlite_*"],
      render: ({ call, state }) => (
        <div className="sqlite-card">
          <strong>{call.name} ({state})</strong>
          <pre>{typeof call.result === "string" ? call.result : JSON.stringify(call.args)}</pre>
        </div>
      ),
    });
  }
  ```
- **Custom File Viewer (`file.viewer`)**: Render binary or domain files (`.sqlite`, `.xlsx`, `.mermaid`, `.glb`) inside the Right Workbench editor/preview pane:
  ```tsx
  import type { Context } from "@deepseek-ai/cordis";

  export function registerMermaidViewer(ctx: Context): void {
    ctx.contributions.registerFileViewer({
      id: "mermaid-viewer",
      label: "Mermaid Diagram",
      extensions: [".mmd", ".mermaid"],
      render: ({ path, content, size }) => (
        <div className="mermaid-preview">
          <h4>{path} ({size} bytes)</h4>
          <pre>{content}</pre>
        </div>
      ),
    });
  }
  ```

---

## 3. `@qianji/client` SDK Contract

Always import hooks and host actions from `@qianji/client` (never internal Zustand stores):

### Read-Only Hooks
- `useActiveSession()` → `{ sessionId, sessionFile, cwd, isStreaming, isCompacting, model, stats, messageCount }`
- `useActiveWorkspace()` → `{ cwd, connected, hostConnected }`
- `useAppearanceTheme()` → `{ themeId, resolvedScheme: "light" | "dark", accentColor }`
- `usePluginConfig<T>(pluginId, fallback?)` → Reactive plugin configuration object synced with Settings → Plugins.
- `useHostRpcQuery<T>(method, params?, { enabled?, refreshIntervalMs? })` → `{ data, loading, error, refetch }`.

### Controlled Host Actions
- `callHostRpc<T>(method, params?)` → Invoke any Host JSON-RPC method (`ctx.rpc.method(...)`).
- `openWorkbenchTab(tabId)` → Open Right Workbench and focus `tabId` (built-in or custom plugin tab ID; also reachable from Host tools via `sidebar_open`).
- `openWorkspaceFile(path, line?)` → Open a file in Right Workbench Code Editor / Custom File Viewer (optionally jumping to 1-based `line`).
- `sendChatPrompt(text, { prefillOnly?, attachments?, behavior? })` → Prefill Composer or send a message in the active session.
- `showToast(message, kind?)` → Non-blocking toast (`"info" | "success" | "warning" | "error"`).

### `dsh-better-sidebar` Compatibility
Client-only plugins migrating from DSH can declare `export const inject = ["betterSidebar"]` and call `ctx.betterSidebar.registerTab({ id, title, icon, component })` or `ctx.betterSidebar.registerFileViewer(...)` — Qianji maps them directly into `rightWorkbenchTabs` / `bottomPanelTabs` / `file.viewer`.
