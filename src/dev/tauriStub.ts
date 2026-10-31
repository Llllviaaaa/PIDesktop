/**
 * Tauri, faked for the browser E2E suite (docs/REFACTOR_V2_P7.md, 3.4).
 * `vite build --mode e2e` loads this before the app (vite.config.ts); no
 * other build contains it. It answers the desktop's own commands with fixed
 * data and points the app at the Harness Host the test started, given in the
 * URL: `?host=<base url>&token=<token>&workspace=<dir>`.
 *
 * Commands it does not know answer `null` and are logged, so a scenario that
 * needs one more shows it in the console.
 */
import { DEFAULTS } from "../components/SettingsModal";
import type { AppSettings, GitSnapshot, ProjectConfig } from "../types";

type Args = Record<string, unknown> | undefined;

const params = new URLSearchParams(window.location.search);
const baseUrl = params.get("host") ?? "";
const token = params.get("token") ?? "";
const workspace = params.get("workspace") ?? "";
if (workspace !== "") window.localStorage.setItem("pid-desktop:last-workspace", workspace);

let settings: AppSettings = { ...DEFAULTS };
const projects: ProjectConfig[] = workspace === "" ? [] : [{ path: workspace, name: workspace.split(/[\\/]/).pop() ?? workspace, pinned: false, hidden: false }];
const git: GitSnapshot = { isRepository: false, files: [], diff: "" };

/** What a test can read back: the commands the app sent, in order. */
const calls: Array<{ command: string; args: Args }> = [];

const callbacks = new Map<number, (payload: unknown) => void>();
let nextCallback = 0;

const commands: Record<string, (args: Args) => unknown> = {
  harness_endpoint: () => ({ baseUrl, token }),
  sidebar_host_base: () => baseUrl,
  restart_harness_host: () => null,
  get_settings: () => settings,
  set_settings: (args) => {
    settings = { ...settings, ...((args?.settings ?? {}) as Partial<AppSettings>) };
    return null;
  },
  list_projects_cmd: () => projects,
  register_project_cmd: () => null,
  save_project_cmd: () => null,
  git_snapshot: () => git,
  git_repository_root: () => null,
  git_list_branches: () => [],
  git_default_branch: () => null,
  list_worktrees: () => [],
  list_workspace_editors: () => [],
  list_terminal_apps: () => [],
  terminal_shells: () => [],
  list_resources: () => [],
  legacy_project_resources: () => 0,
  get_local_memory: () => "",
  quick_chat_dir: () => workspace,
  "plugin:event|listen": () => ++nextCallback,
  "plugin:event|unlisten": () => null,
  "plugin:event|emit": () => null,
  "plugin:app|version": () => "0.0.0-e2e",
  // `confirm` and `ask` are `message` with buttons; it answers with the label
  // pressed, and the stub always presses the first (OK / Yes).
  "plugin:dialog|message": (args) => {
    const buttons = args?.buttons as string | Record<string, unknown> | undefined;
    if (buttons === undefined) return "Ok";
    if (typeof buttons === "string") return buttons.startsWith("Yes") ? "Yes" : "Ok";
    const custom = Object.values(buttons)[0];
    return Array.isArray(custom) ? custom[0] : custom;
  },
  // A save dialog answers with the path the test put on window.__E2E_SAVE_PATH__.
  "plugin:dialog|save": () => (window as unknown as { __E2E_SAVE_PATH__?: string }).__E2E_SAVE_PATH__ ?? null,
  "plugin:dialog|open": () => null,
  "plugin:opener|open_path": () => null,
  "plugin:opener|open_url": () => null,
};

Object.assign(window, {
  __E2E_TAURI_CALLS__: calls,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    async invoke(command: string, args?: Args) {
      calls.push({ command, args });
      const handler = commands[command];
      if (handler !== undefined) return handler(args);
      if (!command.startsWith("plugin:window|") && !command.startsWith("plugin:webview|")) {
        // eslint-disable-next-line no-console -- the suite reads unanswered commands from the console
        console.info(`[tauri-stub] ${command} answered null`);
      }
      return null;
    },
    transformCallback(callback: (payload: unknown) => void) {
      const id = ++nextCallback;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc: (path: string) => path,
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
});
