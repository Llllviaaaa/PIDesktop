/**
 * Built-in Agent plugin development tools (Phase 3):
 * - `qianji_inspect` (`readOnly: true`, always active): approval-free runtime introspection
 *   across Host services, Cordis events, live RPC methods, shared modules, client slots,
 *   `--qj-*` theme tokens, and live plugin status (including frontend `clientError` stacks).
 * - `plugin_manager` (`deferred: true, group: "plugin_dev"`): approval-free `list` & `verify`
 *   pre-flight compiler/manifest checks, plus confirmation-gated `scaffold`, `install_local`,
 *   `reload`, `enable`, `disable`, `configure`, and `remove`.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  CLIENT_SDK_EXPORTS,
  CLIENT_SHARED_EXTERNALS,
  CLIENT_SLOT_CATALOG,
  type PluginInfo,
} from "@qianji/protocol";
import { textOutput, type ToolEnv, type ToolOutput } from "@qianji/tools";
import "@qianji/permissions";
import "@qianji/session";
import "@qianji/ui";
import { ClientBundleRegistry } from "./client-bundles.ts";
import { HOST_SHARED_MODULES } from "./plugin-bridge.ts";
import { canonicalPath, readPluginManifest } from "./plugin-manifest.ts";
import type { PluginManager } from "./plugin-manager.ts";
import "./rpc.ts";

export const name = "qianji-plugin-dev-tools";
export const inject = ["tools", "sessions", "ui"];

export type InspectTopic =
  | "all"
  | "services"
  | "events"
  | "rpc_methods"
  | "shared_modules"
  | "client_slots"
  | "theme_tokens"
  | "plugins";

export type PluginTemplateKind = "tool-only" | "ui-slot-widget" | "fullstack-panel";

export interface PluginDevToolsConfig {
  manager: () => PluginManager | undefined;
  pluginTypesDir?: string | (() => string | undefined);
}

interface EsbuildNodeVerifier {
  build(options: {
    entryPoints: string[];
    bundle: boolean;
    write: false;
    format: "cjs";
    platform: "node";
    target: string;
    external: string[];
    logLevel: "silent";
  }): Promise<{ outputFiles: Array<{ text: string }> }>;
}

interface BunBuildVerifier {
  build(options: {
    entrypoints: string[];
    format: "cjs";
    target: "bun" | "node";
    external: string[];
  }): Promise<{
    success: boolean;
    logs: Array<{ message?: string } | string>;
  }>;
}

const HOST_SERVICE_CATALOG = [
  { name: "tools", plane: "host", methods: ["register(def)", "get(name)", "listDefinitions()", "schemas(sessionId?)", "execute(call, env)"], autoDispose: true },
  { name: "commands", plane: "host", methods: ["register(def)", "registerProvider(fn)", "list(cwd?)", "execute(name, args, env)"], autoDispose: true },
  { name: "systemPrompt", plane: "host", methods: ["section(id, render, { order? })", "build(env)"], autoDispose: true },
  { name: "rpc", plane: "host", methods: ["method(name, handler)", "methods()", "broadcast(method, params?)"], autoDispose: true },
  { name: "webServer", plane: "host", methods: ["register({ kind, path, handler })", "registerUpgrade({ path, handler })"], autoDispose: true },
  { name: "sessions", plane: "host", methods: ["get(id)", "list(cwd?)", "create(opts)"], autoDispose: false },
  { name: "agents", plane: "host", methods: ["run(session, input)", "abort(sessionId)", "isRunning(sessionId)"], autoDispose: false },
  { name: "llm", plane: "host", methods: ["registerProtocol(id, adapter)", "models()", "complete(req)"], autoDispose: true },
  { name: "permissions", plane: "host", methods: ["modes(session)", "defaultModes()", "set(session, patch)"], autoDispose: false },
  { name: "ui", plane: "host", methods: ["confirm(sessionId, title, message, signal?)", "notify(message, level?)"], autoDispose: false },
  { name: "contributions", plane: "client", methods: [
    "registerPage(def)",
    "registerLeftSidebar(def)",
    "registerRightWorkbenchTab(def)",
    "registerBottomPanelTab(def)",
    "registerTopbarAction(def)",
    "registerComposerToolbar(def)",
    "registerComposerStatus(def)",
    "registerComposerBanner(def)",
    "registerOverlay(def)",
    "registerMessageAction(def)",
    "registerToolRenderer(def)",
    "registerFileViewer(def)",
    "registerStatusBarItem(def)",
    "registerHomeQuickAction(def)",
    "registerRewindHandler(def)",
    "registerSlashInterceptor(def)",
    "registerTheme(def)",
  ], autoDispose: true },
  { name: "styles", plane: "client", methods: ["inject(css, key?)"], autoDispose: true },
  { name: "betterSidebar", plane: "client", methods: ["registerTab(desc)", "registerFileViewer(desc)", "openFile(scope, path)", "openTab(seed, scope?)"], autoDispose: true },
] as const;

const CORDIS_EVENTS_CATALOG = [
  { name: "tools/pre-execute", mode: "bail (async)", signature: "(call: ToolCall, env: ToolEnv) => ToolDecision | undefined", description: "Intercept, rewrite args, or deny a tool call before execution." },
  { name: "tools/execute", mode: "waterfall", signature: "(call: ToolCall, env: ToolEnv, next: () => Promise<ToolOutput>) => Promise<ToolOutput>", description: "Wrap tool execution (e.g. timing, checkpoints, output post-processing)." },
  { name: "tools/result", mode: "emit", signature: "(call: ToolCall, env: ToolEnv, output: ToolOutput) => void", description: "Observe completed tool outputs." },
  { name: "session/deleted", mode: "emit", signature: "(sessionId: string) => void", description: "Clean up per-session state when a session is deleted." },
] as const;

export const THEME_TOKENS_CATALOG = {
  cascadeLayers: "@layer theme, base, plugin-ui, legacy, skin, components, utilities;",
  scopingRule: "Use `ctx.styles.inject(css, key?)` or `import './style.css'`; rules are automatically wrapped in `@layer plugin-ui { @scope ([data-qj-plugin=\"<id>\"]) { ... } }`.",
  tokens: {
    backgrounds: [
      "--qj-bg-app",
      "--qj-bg-canvas",
      "--qj-bg-sidebar",
      "--qj-bg-surface",
      "--qj-bg-elevated",
      "--qj-bg-subtle",
      "--qj-bg-hover",
      "--qj-bg-active",
    ],
    text: [
      "--qj-text-primary",
      "--qj-text-secondary",
      "--qj-text-muted",
      "--qj-text-inverse",
    ],
    borders: [
      "--qj-border-subtle",
      "--qj-border-default",
      "--qj-border-strong",
    ],
    brandAndStatus: [
      "--qj-brand-primary",
      "--qj-brand-hover",
      "--qj-brand-soft",
      "--qj-brand-contrast",
      "--qj-status-success",
      "--qj-status-warning",
      "--qj-status-danger",
      "--qj-status-info",
    ],
    typographyAndRadius: [
      "--qj-font-sans",
      "--qj-font-mono",
      "--qj-radius-sm",
      "--qj-radius-md",
      "--qj-radius-lg",
    ],
  },
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolvePluginTypesDir(config: PluginDevToolsConfig): string | undefined {
  const raw = typeof config.pluginTypesDir === "function" ? config.pluginTypesDir() : config.pluginTypesDir;
  if (raw && existsSync(raw)) return canonicalPath(raw);
  const envDir = process.env.QIANJI_PLUGIN_TYPES_DIR?.trim();
  if (envDir && existsSync(envDir)) return canonicalPath(envDir);
  return undefined;
}

async function verifyHostEntrySyntaxAndImports(hostEntry: string): Promise<{ ok: boolean; error?: string }> {
  const external = [...Object.keys(HOST_SHARED_MODULES), "node:*"];
  const bunGlobal = (globalThis as { Bun?: BunBuildVerifier }).Bun;
  if (bunGlobal !== undefined && typeof bunGlobal.build === "function" && process.versions.bun !== undefined) {
    try {
      const result = await bunGlobal.build({
        entrypoints: [hostEntry],
        format: "cjs",
        target: "bun",
        external,
      });
      if (!result.success) {
        const msg = result.logs
          .map((item) => (typeof item === "string" ? item : item.message ?? String(item)))
          .join("; ");
        return { ok: false, error: msg || `Failed to compile host entry ${hostEntry}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  try {
    const req = createRequire(import.meta.url);
    const esbuildPkg = "esbuild";
    const esbuild = req(esbuildPkg) as EsbuildNodeVerifier;
    await esbuild.build({
      entryPoints: [hostEntry],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      target: "node22",
      external: Object.keys(HOST_SHARED_MODULES),
      logLevel: "silent",
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export interface PluginVerifyReport {
  ok: boolean;
  target: string;
  pluginId?: string;
  name?: string;
  version?: string;
  hasHost?: boolean;
  hasClient?: boolean;
  hostEntry?: string;
  clientEntry?: string;
  clientBundleBytes?: number;
  clientCompiled?: { bytes: number; etag: string };
  errors: string[];
  warnings: string[];
}

/** Dry-run manifest validation + Host & Client compilation without mutating `plugins.json`. */
export async function verifyPluginDirectory(targetDir: string): Promise<PluginVerifyReport> {
  const resolvedDir = resolve(targetDir);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(resolvedDir)) {
    return {
      ok: false,
      target: resolvedDir,
      errors: [`Directory does not exist: ${resolvedDir}`],
      warnings,
    };
  }

  let manifest;
  try {
    manifest = readPluginManifest(resolvedDir, "user");
  } catch (error) {
    return {
      ok: false,
      target: resolvedDir,
      errors: [errorMessage(error)],
      warnings,
    };
  }

  if (!existsSync(join(resolvedDir, "package.json"))) {
    warnings.push("No package.json found; add package.json with explicit name, version, description, and qianji metadata.");
  }
  if (!manifest.description || manifest.description.trim() === "") {
    warnings.push("Plugin package.json is missing a human-readable `description`.");
  }

  if (manifest.hostEntry !== undefined) {
    const hostCheck = await verifyHostEntrySyntaxAndImports(manifest.hostEntry);
    if (!hostCheck.ok && hostCheck.error !== undefined) {
      errors.push(`Host entry compile error (${manifest.hostEntry}): ${hostCheck.error}`);
    }
  }

  let clientBundleBytes: number | undefined;
  let clientCompiled: { bytes: number; etag: string } | undefined;
  if (manifest.clientEntry !== undefined) {
    try {
      const tempRegistry = new ClientBundleRegistry();
      const compiled = await tempRegistry.compile(manifest.id, manifest.dir, manifest.clientEntry);
      clientBundleBytes = Buffer.byteLength(compiled.code, "utf8");
      clientCompiled = { bytes: clientBundleBytes, etag: compiled.etag };
    } catch (error) {
      errors.push(`Client bundle compilation failed (${manifest.clientEntry}): ${errorMessage(error)}`);
    }
  }

  return {
    ok: errors.length === 0,
    target: manifest.dir,
    pluginId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    hasHost: manifest.hostEntry !== undefined,
    hasClient: manifest.clientEntry !== undefined,
    ...(manifest.hostEntry === undefined ? {} : { hostEntry: manifest.hostEntry }),
    ...(manifest.clientEntry === undefined ? {} : { clientEntry: manifest.clientEntry }),
    ...(clientBundleBytes === undefined ? {} : { clientBundleBytes }),
    ...(clientCompiled === undefined ? {} : { clientCompiled }),
    errors,
    warnings,
  };
}

function slugifyPluginFolder(pluginId: string): string {
  return pluginId
    .trim()
    .replace(/^@/, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toSafeToolPrefix(pluginId: string): string {
  const cleaned = pluginId
    .replace(/^@[^/]+\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "custom_plugin";
}

export function scaffoldPluginFiles(options: {
  pluginId: string;
  displayName?: string;
  description?: string;
  template: PluginTemplateKind;
  targetDir: string;
  pluginTypesDir?: string;
}): string[] {
  const { pluginId, template, targetDir, pluginTypesDir } = options;
  const title = options.displayName?.trim() || pluginId;
  const description = options.description?.trim() || `${title} — Qianji extension plugin`;
  const toolPrefix = toSafeToolPrefix(pluginId);

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new Error(`Target scaffold directory is not empty: ${targetDir}`);
  }
  mkdirSync(targetDir, { recursive: true });

  const written: string[] = [];
  const write = (relPath: string, content: string) => {
    const abs = join(targetDir, relPath);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
    written.push(relPath);
  };

  const hasHost = template === "tool-only" || template === "fullstack-panel";
  const hasClient = template === "ui-slot-widget" || template === "fullstack-panel";

  const pkgJson: Record<string, unknown> = {
    name: pluginId,
    version: "0.1.0",
    private: true,
    type: "module",
    description,
    ...(hasHost ? { main: "./index.ts" } : {}),
    qianji: {
      id: pluginId,
      name: title,
      ...(hasHost ? { host: "./index.ts" } : {}),
      ...(hasClient ? { client: "./client.tsx" } : {}),
      configSchema: {
        type: "object",
        properties: {
          greeting: {
            type: "string",
            title: "展示前缀",
            description: "在插件微件或工具响应中显示的文案前缀",
            default: title,
          },
        },
      },
    },
  };
  write("package.json", `${JSON.stringify(pkgJson, null, 2)}\n`);

  const typesRel = pluginTypesDir !== undefined
    ? relative(targetDir, pluginTypesDir).replace(/\\/g, "/")
    : undefined;
  const tsconfig = typesRel !== undefined
    ? {
        extends: `${typesRel}/tsconfig.plugin.json`,
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "react/jsx-runtime": [`${typesRel}/react/jsx-runtime.d.ts`],
            "react/jsx-dev-runtime": [`${typesRel}/react/jsx-dev-runtime.d.ts`],
            "*": [`${typesRel}/*/index.d.ts`, `${typesRel}/*`],
          },
        },
        include: [
          ...(hasHost ? ["index.ts"] : []),
          ...(hasClient ? ["client.tsx"] : []),
        ],
      }
    : {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: [
          ...(hasHost ? ["index.ts"] : []),
          ...(hasClient ? ["client.tsx"] : []),
        ],
      };
  write("tsconfig.json", `${JSON.stringify(tsconfig, null, 2)}\n`);

  if (template === "tool-only") {
    write(
      "index.ts",
      `import type { Context } from "@deepseek-ai/cordis";
import { textOutput } from "@qianji/tools";

export interface PluginConfig {
  greeting?: string;
}

export const name = ${JSON.stringify(pluginId)};
export const inject = ["tools"];

export function apply(ctx: Context, config: PluginConfig = {}): void {
  const prefix = config.greeting ?? ${JSON.stringify(title)};
  ctx.tools.register({
    name: "${toolPrefix}_status",
    description: "Inspect status from ${pluginId}",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional query string" },
      },
    },
    async execute(args, env) {
      const q = typeof args.query === "string" && args.query.trim() !== "" ? args.query.trim() : "default";
      return textOutput(\`[\${prefix}] cwd=\${env.cwd} query=\${q}\`);
    },
  });
}
`,
    );
  } else if (template === "ui-slot-widget") {
    write(
      "client.tsx",
      `import type { Context } from "@deepseek-ai/cordis";
import { Sparkles } from "lucide-react";
import { showToast, useActiveSession, usePluginConfig } from "@qianji/client";

interface WidgetConfig {
  greeting: string;
}

const WIDGET_CSS = \`
.widget-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: var(--qj-radius-sm, 6px);
  border: 1px solid var(--qj-border-subtle, var(--border));
  background: var(--qj-bg-elevated, var(--panel));
  color: var(--qj-text-secondary, var(--text-2));
  font-size: 11.5px;
  cursor: pointer;
}
.widget-pill:hover {
  background: var(--qj-bg-hover, var(--hover));
  color: var(--qj-text-primary, var(--text));
}
\`;

function StatusPill() {
  const session = useActiveSession();
  const config = usePluginConfig<WidgetConfig>(${JSON.stringify(pluginId)}, { greeting: ${JSON.stringify(title)} });
  return (
    <button
      type="button"
      className="widget-pill"
      onClick={() => showToast(\`\${config.greeting} · \${session.cwd || "未选择工作区"}\`, "info")}
    >
      <Sparkles size={12} />
      <span>{config.greeting}</span>
    </button>
  );
}

export const name = ${JSON.stringify(`${pluginId}-client`)};
export const inject = ["contributions", "styles"];

export function apply(ctx: Context): void {
  ctx.styles.inject(WIDGET_CSS, "widget");
  ctx.contributions.registerStatusBarItem({
    id: "${toolPrefix}-status",
    align: "right",
    render: () => <StatusPill />,
  });
}
`,
    );
  } else {
    write(
      "index.ts",
      `import type { Context } from "@deepseek-ai/cordis";
import { textOutput } from "@qianji/tools";

export interface PluginConfig {
  greeting?: string;
}

export const name = ${JSON.stringify(pluginId)};
export const inject = ["tools", "rpc"];

export function apply(ctx: Context, config: PluginConfig = {}): void {
  const getGreeting = () => config.greeting ?? ${JSON.stringify(title)};

  ctx.rpc.method("${toolPrefix}.summary", (params) => {
    const record = (typeof params === "object" && params !== null ? params : {}) as { cwd?: string };
    return {
      pluginId: ${JSON.stringify(pluginId)},
      greeting: getGreeting(),
      cwd: record.cwd ?? "",
      timestamp: new Date().toISOString(),
    };
  });

  ctx.tools.register({
    name: "${toolPrefix}_inspect",
    description: "Read summary information from ${pluginId}",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_args, env) {
      return textOutput(\`[\${getGreeting()}] active in \${env.cwd}\`);
    },
  });
}
`,
    );

    write(
      "client.tsx",
      `import type { Context } from "@deepseek-ai/cordis";
import { Blocks, RefreshCw } from "lucide-react";
import {
   openWorkbenchTab,
  showToast,
  useActiveSession,
  useHostRpcQuery,
  usePluginConfig,
} from "@qianji/client";

interface PanelConfig {
  greeting: string;
}

interface SummaryPayload {
  pluginId: string;
  greeting: string;
  cwd: string;
  timestamp: string;
}

const PANEL_TAB_ID = "${toolPrefix}-panel";

const PANEL_CSS = \`
.panel-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  color: var(--qj-text-primary, var(--text));
}
.panel-card {
  padding: 12px;
  border-radius: var(--qj-radius-md, 8px);
  border: 1px solid var(--qj-border-default, var(--border));
  background: var(--qj-bg-elevated, var(--panel));
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.panel-muted {
  font-size: 12px;
  color: var(--qj-text-muted, var(--text-3));
}
.panel-btn {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: var(--qj-radius-sm, 6px);
  border: 1px solid var(--qj-border-default, var(--border));
  background: var(--qj-bg-surface, var(--app));
  color: var(--qj-text-primary, var(--text));
  font-size: 12px;
  cursor: pointer;
}
.panel-btn:hover {
  background: var(--qj-bg-hover, var(--hover));
}
\`;

function FullstackPanel() {
  const session = useActiveSession();
  const config = usePluginConfig<PanelConfig>(${JSON.stringify(pluginId)}, { greeting: ${JSON.stringify(title)} });
  const query = useHostRpcQuery<SummaryPayload>("${toolPrefix}.summary", { cwd: session.cwd });

  return (
    <div className="panel-root">
      <div className="panel-card">
        <strong>{config.greeting}</strong>
        <span className="panel-muted">当前工作区：{session.cwd || "未选择"}</span>
        {query.data && (
          <span className="panel-muted">Host 同步时间：{query.data.timestamp}</span>
        )}
        {query.error && (
          <span className="panel-muted">RPC 状态：{query.error}</span>
        )}
        <button
          type="button"
          className="panel-btn"
          onClick={() => {
            query.refetch();
            showToast("已刷新插件状态", "info");
          }}
        >
          <RefreshCw size={12} />
          <span>刷新数据</span>
        </button>
      </div>
    </div>
  );
}

export const name = ${JSON.stringify(`${pluginId}-client`)};
export const inject = ["contributions", "styles"];

export function apply(ctx: Context): void {
  ctx.styles.inject(PANEL_CSS, "panel");

  ctx.contributions.registerRightWorkbenchTab({
    id: PANEL_TAB_ID,
    label: ${JSON.stringify(title)},
    icon: <Blocks size={13} />,
    render: () => <FullstackPanel />,
  });

  ctx.contributions.registerTopbarAction({
    id: "${toolPrefix}-open-btn",
    render: () => (
      <button
        type="button"
        className="panel-btn"
        onClick={() => openWorkbenchTab(PANEL_TAB_ID)}
      >
        <Blocks size={12} />
        <span>${title}</span>
      </button>
    ),
  });
}
`,
    );
  }

  return written;
}

function summarizePluginInfo(plugin: PluginInfo): Record<string, unknown> {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    tier: plugin.tier,
    status: plugin.status,
    enabled: plugin.enabled,
    hasHost: plugin.hasHost,
    hasClient: plugin.hasClient,
    ...(plugin.clientEtag === undefined ? {} : { clientEtag: plugin.clientEtag }),
    ...(plugin.dir === undefined ? {} : { dir: plugin.dir }),
    watch: plugin.watch,
    ...(plugin.inject === undefined ? {} : { inject: plugin.inject }),
    ...(plugin.provides === undefined ? {} : { provides: plugin.provides }),
    ...(plugin.missingInject === undefined ? {} : { missingInject: plugin.missingInject }),
    ...(plugin.error === undefined ? {} : { error: plugin.error }),
    ...(plugin.clientError === undefined ? {} : { clientError: plugin.clientError }),
  };
}

export function apply(ctx: Context, config: PluginDevToolsConfig): void {
  const requireApprovalIfNeeded = async (
    env: ToolEnv,
    title: string,
    message: string,
  ): Promise<{ ok: true } | { ok: false; output: ToolOutput }> => {
    const permissions = ctx.get("permissions");
    if (permissions !== undefined) {
      const session = await ctx.sessions.get(env.sessionId);
      const effective = session === undefined
        ? permissions.defaultModes().effective
        : permissions.modes(session).effective;
      if (effective === "read-only") {
        return { ok: false, output: textOutput("Qianji is in read-only mode; plugin mutations are not permitted.", true) };
      }
      if (effective === "full-access") {
        return { ok: true };
      }
    }
    if (!ctx.ui.canAsk(env.sessionId)) {
      return { ok: false, output: textOutput("Confirmation required for plugin mutation, but no interactive UI is attached.", true) };
    }
    const confirmed = await ctx.ui.confirm(env.sessionId, title, message, env.signal);
    if (!confirmed) {
      return { ok: false, output: textOutput(`${title} denied by user.`, true) };
    }
    return { ok: true };
  };

  ctx.tools.register({
    name: "qianji_inspect",
    description:
      "Read-only runtime introspection of Qianji's plugin architecture: active Host/Client Cordis services, events, live JSON-RPC methods, externalized shared modules, `<PluginSlot>` extension slots & `@qianji/client` SDK exports, `--qj-*` CSS theme tokens, and live plugin states (including frontend `clientError` stacks).",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            'Inspection topic: "all" | "services" | "events" | "rpc_methods" | "shared_modules" | "client_slots" | "theme_tokens" | "plugins"',
        },
        pluginId: {
          type: "string",
          description: "Optional plugin ID filter when topic is 'plugins' or 'all'",
        },
      },
    },
    async execute(args, env) {
      const rawTopic = typeof args.topic === "string" && args.topic.trim() !== "" ? args.topic.trim() : "all";
      const validTopics = new Set<InspectTopic>([
        "all",
        "services",
        "events",
        "rpc_methods",
        "shared_modules",
        "client_slots",
        "theme_tokens",
        "plugins",
      ]);
      if (!validTopics.has(rawTopic as InspectTopic)) {
        return textOutput(
          `Unknown topic "${rawTopic}". Expected one of: ${[...validTopics].join(", ")}.`,
          true,
        );
      }
      const topic = rawTopic as InspectTopic;
      const pluginIdFilter = typeof args.pluginId === "string" && args.pluginId.trim() !== ""
        ? args.pluginId.trim()
        : undefined;

      const payload: Record<string, unknown> = {};

      if (topic === "all" || topic === "services") {
        const mountedHostServices = HOST_SERVICE_CATALOG
          .filter((item) => item.plane === "host" && ctx.get(item.name) !== undefined)
          .map((item) => item.name);
        payload.services = {
          mountedOnHost: mountedHostServices,
          catalog: HOST_SERVICE_CATALOG,
          registeredToolsCount: ctx.tools.listDefinitions().length,
        };
      }

      if (topic === "all" || topic === "events") {
        payload.events = CORDIS_EVENTS_CATALOG;
      }

      if (topic === "all" || topic === "rpc_methods") {
        const rpc = ctx.get("rpc");
        payload.rpcMethods = rpc !== undefined ? rpc.methods() : [];
      }

      if (topic === "all" || topic === "shared_modules") {
        payload.sharedModules = {
          host: Object.keys(HOST_SHARED_MODULES).sort(),
          client: [...CLIENT_SHARED_EXTERNALS],
          pluginTypesDir: resolvePluginTypesDir(config) ?? null,
        };
      }

      if (topic === "all" || topic === "client_slots") {
        payload.clientSlots = {
          slots: CLIENT_SLOT_CATALOG,
          sdk: CLIENT_SDK_EXPORTS,
        };
      }

      if (topic === "all" || topic === "theme_tokens") {
        payload.themeTokens = THEME_TOKENS_CATALOG;
      }

      if (topic === "all" || topic === "plugins") {
        const manager = config.manager();
        if (manager === undefined) {
          payload.plugins = { available: false, items: [] };
        } else {
          const allPlugins = await manager.list(env.cwd);
          const filtered = pluginIdFilter === undefined
            ? allPlugins
            : allPlugins.filter((item) => item.id === pluginIdFilter);
          payload.plugins = {
            available: true,
            count: filtered.length,
            items: filtered.map(summarizePluginInfo),
          };
        }
      }

      return textOutput(JSON.stringify(payload, null, 2));
    },
  });

  ctx.tools.register({
    name: "plugin_manager",
    description:
      "Manage and verify Qianji plugins. Actions `list` and `verify` are read-only and approval-free (always run `verify` before `install_local`). Mutating actions (`scaffold`, `install_local`, `reload`, `enable`, `disable`, `configure`, `remove`) request user confirmation unless in Full Access mode.",
    deferred: true,
    group: "plugin_dev",
    groupDescription: "Scaffold, pre-flight compile-check (`verify`), hot-link (`install_local`), reload, and configure Qianji plugins",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            'Action to execute: "list" | "verify" | "scaffold" | "install_local" | "reload" | "enable" | "disable" | "configure" | "remove"',
        },
        id: {
          type: "string",
          description: "Plugin identifier (required for scaffold, enable, disable, configure, remove; optional for reload/list)",
        },
        dir: {
          type: "string",
          description: "Plugin directory path (relative to workspace or absolute) for verify, scaffold, or install_local",
        },
        target: {
          type: "string",
          description: "Alias of `dir` (plugin directory path for verify, scaffold, or install_local)",
        },
        link: {
          type: "boolean",
          description: "For `install_local`: link directory in place for live HMR (default true)",
        },
        watch: {
          type: "boolean",
          description: "For `install_local`: watch source files for live HMR (default true)",
        },
        template: {
          type: "string",
          description: 'Scaffold template: "tool-only" | "ui-slot-widget" | "fullstack-panel" (default "fullstack-panel")',
        },
        name: {
          type: "string",
          description: "Human-readable plugin display title for `scaffold`",
        },
        description: {
          type: "string",
          description: "Short plugin description for `scaffold`",
        },
        config: {
          type: "object",
          description: "Configuration object for `configure`",
        },
      },
      required: ["action"],
    },
    async execute(args, env) {
      const action = typeof args.action === "string" ? args.action.trim() : "";
      const manager = config.manager();

      const resolveTargetDir = (rawTarget: unknown, fallbackSubdir?: string): string | undefined => {
        if (typeof rawTarget === "string" && rawTarget.trim() !== "") {
          const trimmed = rawTarget.trim();
          return isAbsolute(trimmed) ? resolve(trimmed) : resolve(env.cwd, trimmed);
        }
        if (fallbackSubdir !== undefined) {
          return resolve(env.cwd, fallbackSubdir);
        }
        return undefined;
      };
      const requestedDirArg = args.dir ?? args.target;

      if (action === "list") {
        if (manager === undefined) {
          return textOutput("PluginManager is not attached to this Host instance.", true);
        }
        const plugins = await manager.list(env.cwd);
        const idFilter = typeof args.id === "string" && args.id.trim() !== "" ? args.id.trim() : undefined;
        const items = (idFilter ? plugins.filter((item) => item.id === idFilter) : plugins).map(summarizePluginInfo);
        return textOutput(JSON.stringify({ count: items.length, plugins: items }, null, 2));
      }

      if (action === "verify") {
        const targetDir = resolveTargetDir(requestedDirArg);
        if (targetDir === undefined) {
          return textOutput('`dir` (or `target`) directory path is required for action="verify".', true);
        }
        const report = await verifyPluginDirectory(targetDir);
        return textOutput(JSON.stringify(report, null, 2), !report.ok);
      }

      if (action === "scaffold") {
        const pluginId = typeof args.id === "string" ? args.id.trim() : "";
        if (pluginId === "") {
          return textOutput('`id` is required for action="scaffold" (e.g. "csv-viewer").', true);
        }
        const rawTemplate = typeof args.template === "string" && args.template.trim() !== ""
          ? args.template.trim()
          : "fullstack-panel";
        if (rawTemplate !== "tool-only" && rawTemplate !== "ui-slot-widget" && rawTemplate !== "fullstack-panel") {
          return textOutput(
            `Invalid template "${rawTemplate}". Expected "tool-only", "ui-slot-widget", or "fullstack-panel".`,
            true,
          );
        }
        const slug = slugifyPluginFolder(pluginId);
        const targetDir = resolveTargetDir(requestedDirArg, join("plugins", slug));
        if (targetDir === undefined) {
          return textOutput("Unable to resolve target scaffold directory.", true);
        }
        const relToWorkspace = relative(resolve(env.cwd), targetDir);
        if (relToWorkspace.startsWith("..") || isAbsolute(relToWorkspace)) {
          return textOutput(
            `Scaffold target must stay inside the current workspace (${env.cwd}), got: ${targetDir}`,
            true,
          );
        }

        const gate = await requireApprovalIfNeeded(
          env,
          "创建插件工程骨架？",
          `插件 ID：${pluginId}\n模板类型：${rawTemplate}\n目标目录：${targetDir}`,
        );
        if (!gate.ok) return gate.output;

        try {
          const files = scaffoldPluginFiles({
            pluginId,
            template: rawTemplate,
            targetDir,
            ...(typeof args.name === "string" ? { displayName: args.name } : {}),
            ...(typeof args.description === "string" ? { description: args.description } : {}),
            ...(resolvePluginTypesDir(config) === undefined ? {} : { pluginTypesDir: resolvePluginTypesDir(config) }),
          });
          return textOutput(
            JSON.stringify(
              {
                ok: true,
                pluginId,
                template: rawTemplate,
                dir: targetDir,
                files,
                nextStep: "Edit files as needed, then run plugin_manager(action: 'verify', dir) before install_local.",
              },
              null,
              2,
            ),
          );
        } catch (error) {
          return textOutput(`Failed to scaffold plugin: ${errorMessage(error)}`, true);
        }
      }

      if (manager === undefined) {
        return textOutput("PluginManager is not attached to this Host instance.", true);
      }

      if (action === "install_local") {
        const targetDir = resolveTargetDir(requestedDirArg);
        if (targetDir === undefined) {
          return textOutput('`dir` (or `target`) directory path is required for action="install_local".', true);
        }
        // Always pre-flight verify before prompting or linking so broken plugins never get installed blindly.
        const verification = await verifyPluginDirectory(targetDir);
        if (!verification.ok) {
          return textOutput(
            JSON.stringify(
              {
                ok: false,
                stage: "pre-install-verify",
                message: "Pre-flight verification failed; fix errors before calling install_local.",
                verification,
              },
              null,
              2,
            ),
            true,
          );
        }

        const linkMode = typeof args.link === "boolean" ? args.link : true;
        const watchMode = typeof args.watch === "boolean" ? args.watch : linkMode;

        const gate = await requireApprovalIfNeeded(
          env,
          "安装并启用本地开发插件？",
          `插件名称：${verification.name ?? verification.pluginId} (${verification.pluginId})\n目录路径：${verification.target}\n模式：${linkMode ? "开发链接模式 (支持毫秒级热重载)" : "复制安装模式"}`,
        );
        if (!gate.ok) return gate.output;

        try {
          const result = await manager.install({
            channel: "local",
            spec: verification.target,
            link: linkMode,
            watch: watchMode,
          });
          return textOutput(
            JSON.stringify(
              {
                ok: result.plugin?.status === "active" && result.plugin.error === undefined,
                plugin: result.plugin ? summarizePluginInfo(result.plugin) : null,
                warnings: verification.warnings,
              },
              null,
              2,
            ),
            result.plugin?.error !== undefined,
          );
        } catch (error) {
          return textOutput(`install_local failed: ${errorMessage(error)}`, true);
        }
      }

      if (action === "reload") {
        const pluginId = typeof args.id === "string" && args.id.trim() !== "" ? args.id.trim() : undefined;
        const gate = await requireApprovalIfNeeded(
          env,
          "重载插件？",
          pluginId ? `目标插件：${pluginId}` : "目标：重载全部可热插拔插件",
        );
        if (!gate.ok) return gate.output;
        try {
          const result = await manager.reload(pluginId, env.cwd);
          return textOutput(
            JSON.stringify(
              {
                ok: pluginId === undefined ? true : result.plugin?.error === undefined,
                plugin: result.plugin ? summarizePluginInfo(result.plugin) : undefined,
                totalPlugins: result.plugins.length,
              },
              null,
              2,
            ),
            result.plugin?.error !== undefined,
          );
        } catch (error) {
          return textOutput(`reload failed: ${errorMessage(error)}`, true);
        }
      }

      if (action === "enable" || action === "disable") {
        const pluginId = typeof args.id === "string" ? args.id.trim() : "";
        if (pluginId === "") {
          return textOutput(`\`id\` is required for action="${action}".`, true);
        }
        const gate = await requireApprovalIfNeeded(
          env,
          action === "enable" ? "启用插件？" : "停用插件？",
          `目标插件：${pluginId}`,
        );
        if (!gate.ok) return gate.output;
        try {
          const existing = (await manager.list(env.cwd)).find((item) => item.id === pluginId);
          const wsOpt = existing?.tier === "workspace" ? { workspace: existing.workspace ?? env.cwd } : {};
          const result = await manager.setEnabled(pluginId, action === "enable", wsOpt);
          return textOutput(
            JSON.stringify(
              {
                ok: true,
                plugin: result.plugin ? summarizePluginInfo(result.plugin) : null,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          return textOutput(`${action} failed: ${errorMessage(error)}`, true);
        }
      }

      if (action === "configure") {
        const pluginId = typeof args.id === "string" ? args.id.trim() : "";
        if (pluginId === "") {
          return textOutput('`id` is required for action="configure".', true);
        }
        const nextConfig = (typeof args.config === "object" && args.config !== null && !Array.isArray(args.config))
          ? (args.config as Record<string, unknown>)
          : undefined;
        if (nextConfig === undefined) {
          return textOutput('`config` object is required for action="configure".', true);
        }
        const gate = await requireApprovalIfNeeded(
          env,
          "修改插件配置？",
          `目标插件：${pluginId}\n新配置：\n${JSON.stringify(nextConfig, null, 2)}`,
        );
        if (!gate.ok) return gate.output;
        try {
          const existing = (await manager.list(env.cwd)).find((item) => item.id === pluginId);
          const wsOpt = existing?.tier === "workspace" ? { workspace: existing.workspace ?? env.cwd } : {};
          const result = await manager.configure(pluginId, nextConfig, wsOpt);
          return textOutput(
            JSON.stringify(
              {
                ok: true,
                plugin: result.plugin ? summarizePluginInfo(result.plugin) : null,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          return textOutput(`configure failed: ${errorMessage(error)}`, true);
        }
      }

      if (action === "remove") {
        const pluginId = typeof args.id === "string" ? args.id.trim() : "";
        if (pluginId === "") {
          return textOutput('`id` is required for action="remove".', true);
        }
        const gate = await requireApprovalIfNeeded(
          env,
          "移除已安装插件？",
          `目标插件：${pluginId}`,
        );
        if (!gate.ok) return gate.output;
        try {
          const result = await manager.remove(pluginId, env.cwd);
          return textOutput(
            JSON.stringify(
              {
                ok: true,
                removedId: pluginId,
                remainingPlugins: result.plugins.length,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          return textOutput(`remove failed: ${errorMessage(error)}`, true);
        }
      }

      return textOutput(
        `Unknown plugin_manager action "${action}". Expected one of: list, verify, scaffold, install_local, reload, enable, disable, configure, remove.`,
        true,
      );
    },
  });
}
