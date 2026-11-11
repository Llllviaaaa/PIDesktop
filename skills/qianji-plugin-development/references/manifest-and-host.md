# Plugin Manifest (`package.json`) & Host Plane (`index.ts`)

## 1. `package.json` Manifest (`qianji` Field)

Every Qianji plugin directory has a `package.json` with a `qianji` field:

```json
{
  "name": "qianji-plugin-repo-insights",
  "version": "0.1.0",
  "description": "Summarize repository hotspots and expose a workbench tab",
  "qianji": {
    "id": "repo-insights",
    "name": "Repo Insights",
    "host": "./index.ts",
    "client": "./client.tsx",
    "inject": ["tools", "rpc", "commands"],
    "provides": [],
    "configSchema": {
      "type": "object",
      "properties": {
        "maxEntries": {
          "type": "integer",
          "title": "Max Entries",
          "description": "Maximum items returned per query",
          "default": 20,
          "minimum": 1,
          "maximum": 200
        },
        "format": {
          "type": "string",
          "title": "Output Format",
          "enum": ["compact", "detailed"],
          "default": "compact"
        },
        "includeHidden": {
          "type": "boolean",
          "title": "Include Dotfiles",
          "default": false
        }
      }
    }
  }
}
```

### Key Manifest Fields
- `qianji.id`: Unique kebab-case identifier (`^[a-z0-9][a-z0-9._-]{0,63}$`). Must not collide with reserved host transport gateways (`web-server`, `rpc-gateway`).
- `qianji.host`: Optional relative path to Host entry (`./index.ts` or `./index.js`). Omit for pure UI/theme plugins.
- `qianji.client`: Optional relative path to Client entry (`./client.tsx` or `./client.ts`). Omit for pure Host tool plugins.
- `qianji.inject`: Host Cordis services required before `apply(ctx, config)` activates (e.g. `["tools", "rpc"]`).
- `qianji.configSchema`: JSON Schema (`object` with `boolean`, `string`, `enum`, `number` / `integer` properties). Settings → Plugins automatically renders a graphical configuration form from this schema and persists user values to `~/.qianji/plugins.json`.

---

## 2. Host Plugin Structure (`index.ts`)

Host plugins run inside the Harness Host process and may import `@deepseek-ai/cordis`, `@qianji/tools`, `@qianji/protocol`, `@qianji/session`, `@qianji/commands`, `@qianji/system-prompt`, `@qianji/ui`, and Node built-ins (`node:fs`, `node:path`, `node:crypto`, etc.).

```ts
import type { Context } from "@deepseek-ai/cordis";
import { textOutput } from "@qianji/tools";

export interface RepoInsightsConfig {
  maxEntries?: number;
  format?: "compact" | "detailed";
  includeHidden?: boolean;
}

export const name = "repo-insights-host";
export const inject = ["tools", "rpc", "commands"];

export function apply(ctx: Context, config: RepoInsightsConfig = {}): void {
  // 1. Register an Agent Tool
  ctx.tools.register({
    name: "repo_insights_scan",
    description: "Read-only summary of workspace directory counts.",
    readOnly: true, // Safe read-only tool: executes in Plan/Ask/Agent without approval popup
    parameters: {
      type: "object",
      properties: {
        subpath: { type: "string", description: "Optional relative subdirectory" },
      },
    },
    async execute(args, env) {
      const limit = config.maxEntries ?? 20;
      return textOutput(
        JSON.stringify({ cwd: env.cwd, subpath: args.subpath ?? ".", limit }, null, 2),
      );
    },
  });

  // 2. Register a JSON-RPC method callable by Client UI via useHostRpcQuery / callHostRpc
  ctx.rpc.method("repo_insights.summary", async (params) => {
    const raw = (params ?? {}) as { cwd?: string };
    return {
      cwd: raw.cwd ?? "",
      format: config.format ?? "compact",
      timestamp: new Date().toISOString(),
    };
  });

  // 3. Register a Slash Command (/insights)
  ctx.commands.register({
    name: "insights",
    description: "Run a quick repository insights check",
    source: "extension",
    execute: () => ({
      prompt: "Call `repo_insights_scan` on the current workspace and summarize key findings.",
    }),
  });
}
```

### Host Best Practices
- **`readOnly: true` vs Side-Effect Tools**: Mark pure inspection/query tools `readOnly: true`. Leave file-mutating, network-mutating, or process-spawning tools `readOnly: false` (default) so Qianji's permission engine enforces `read-only` / `ask` / `workspace-write` policies.
- **`deferred: true` for Specialized Tool Suites**: If your plugin registers many niche tools, set `deferred: true, group: "<your-group>"` so they do not bloat default prompt tokens until activated via `activate_tools`.
- **Automatic Disposal**: `ctx.tools.register`, `ctx.rpc.method`, `ctx.commands.register`, `ctx.systemPrompt.section`, and `ctx.webServer.register` automatically clean up when your plugin reloads or disables. Wrap custom intervals or watchers with `ctx.effect(() => { const timer = setInterval(...); return () => clearInterval(timer); })`.
