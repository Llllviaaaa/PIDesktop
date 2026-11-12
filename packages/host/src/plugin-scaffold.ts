/**
 * Scaffolds for new plugins (`plugin_manager` `scaffold`, ADR 0016): the
 * tool-only, ui-slot-widget and fullstack-panel templates, written as files
 * that pass `verify` and `tsc --noEmit` against the generated plugin-types.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type PluginTemplateKind = "tool-only" | "ui-slot-widget" | "fullstack-panel";

export function slugifyPluginFolder(pluginId: string): string {
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
