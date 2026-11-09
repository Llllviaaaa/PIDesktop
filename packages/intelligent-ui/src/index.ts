/**
 * Built-in Intelligent UI plugin (`@pid/intelligent-ui`).
 *
 * Registers:
 * - `render_ui` and `update_ui` tools so models compose live, interactive UI
 *   cards (calculators, charts, sortable tables, parameter forms, and sandboxed
 *   HTML/SVG/Canvas mini-apps) directly inside the conversation stream.
 * - `intelligent-ui` system prompt section guiding models on declarative specs
 *   vs. sandboxed HTML escape pods.
 * - `/ui` slash command and `intelligentUi.list` RPC endpoint.
 */
import type { Context } from "@deepseek-ai/cordis";
import "@pid/commands";
import { ErrorCode } from "@pid/protocol";
import { RpcError } from "@pid/rpc";
import { currentBranch, type Session } from "@pid/session";
import { SectionOrder } from "@pid/system-prompt";
import { textOutput, type ToolDefinition } from "@pid/tools";
import {
  NAMESPACE,
  buildRenderedArtifact,
  buildUpdatedArtifact,
  normalizeWidgetId,
  type IntelligentUiArtifact,
  type RenderUiInput,
  type UpdateUiInput,
} from "./core.ts";

export * from "./core.ts";

export const name = "pid-intelligent-ui";
export const inject = ["sessions", "tools", "systemPrompt"];

export const INTELLIGENT_UI_PROMPT_SECTION = `Interactive UI (Intelligent UI):
Call \`render_ui\` (or \`update_ui\`) ONLY when an inline interactive chat widget (calculator, parameter tuner, interactive chart, or \`/ui\` request) materially beats Markdown. Never use \`render_ui\` as a substitute when the user asks to create or edit workspace files (e.g. \`.html\`, \`.tsx\`, \`.css\`, \`.svg\`—use \`write\`/\`edit\`). Keep surrounding prose brief.`;

/** Reconstruct all versioned Intelligent UI widgets along the session's active branch. */
export function widgetsOf(session: Session): Map<string, IntelligentUiArtifact[]> {
  const byId = new Map<string, IntelligentUiArtifact[]>();
  for (const event of currentBranch(session.events)) {
    if (event.type !== "custom") continue;
    const payload = event.data as { ns?: unknown; data?: unknown };
    if (payload.ns !== NAMESPACE || typeof payload.data !== "object" || payload.data === null) continue;
    const record = payload.data as Record<string, unknown>;
    if (record.action === "clear") {
      byId.clear();
      continue;
    }
    const artifact = record.artifact as IntelligentUiArtifact | undefined;
    if (artifact && typeof artifact.id === "string" && typeof artifact.version === "number") {
      const list = byId.get(artifact.id) ?? [];
      list.push(artifact);
      byId.set(artifact.id, list);
    }
  }
  return byId;
}

export function latestWidgetOf(session: Session, rawId: string): IntelligentUiArtifact | undefined {
  const id = normalizeWidgetId(rawId);
  const versions = widgetsOf(session).get(id);
  return versions?.[versions.length - 1];
}

function recordArtifact(session: Session, artifact: IntelligentUiArtifact): void {
  session.append("custom", {
    ns: NAMESPACE,
    data: { action: "upsert", artifact },
  });
}

export function renderUiTool(ctx: Context): ToolDefinition<Record<string, unknown>> {
  return {
    name: "render_ui",
    description: "Render an interactive UI widget inline in chat (never as a substitute for writing workspace files).",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Kebab-case widget id (e.g. 'roi-calc').",
        },
        title: {
          type: "string",
          description: "Short widget title.",
        },
        subtitle: {
          type: "string",
          description: "Optional subtitle.",
        },
        engine: {
          type: "string",
          enum: ["declarative", "html"],
          description: "Prefer 'declarative' for controls/stats/charts/tables/forms; 'html' for custom SVG/Canvas/JS.",
        },
        spec: {
          type: "object",
          description: "For 'declarative': {state?:{...}, blocks:[...]}. Blocks: controls {type:'controls',title?,items:[{key,label,kind:'slider'|'number'|'text'|'select'|'toggle',min?,max?,step?,unit?,options?:[{label,value}]}]}; stats {type:'stats',title?,items:[{label,value?,formula?,unit?,prefix?,suffix?,decimals?,tone?}]} (formulas use state keys & Math.*); chart {type:'chart',chartType:'bar'|'line'|'area'|'donut',title?,unit?,items:[{label,value?,formula?,color?}]}; table {type:'table',title?,searchable?,columns,rows}; tabs {type:'tabs',tabs:[{id,label,blocks}]}; form {type:'form',title?,submitLabel?,promptTemplate}; callout {type:'callout',tone?,title?,body}; checklist {type:'checklist',title?,items:[{id,label,checked?}]}.",
        },
        html: {
          type: "string",
          description: "For 'html': self-contained HTML/CSS/SVG/JS. Use var(--pi-bg|--pi-surface|--pi-surface-soft|--pi-text|--pi-muted|--pi-border|--pi-accent) and optional window.piUI?.sendPrompt(text).",
        },
      },
      required: ["id", "title"],
    },
    async execute(args, env) {
      const session = await ctx.sessions.get(env.sessionId);
      if (session === undefined) return textOutput("No active session for render_ui.", true);
      try {
        const previous = typeof args.id === "string" && args.id.trim() ? latestWidgetOf(session, args.id) : undefined;
        const artifact = buildRenderedArtifact(args as unknown as RenderUiInput, previous);
        recordArtifact(session, artifact);
        return {
          content: [{
            type: "text",
            text: `Rendered interactive UI "${artifact.title}" (id: ${artifact.id}, v${artifact.version}, engine: ${artifact.engine}).`,
          }],
          details: artifact,
        };
      } catch (error) {
        return textOutput(`render_ui error: ${(error as Error).message}`, true);
      }
    },
  };
}

export function updateUiTool(ctx: Context): ToolDefinition<Record<string, unknown>> {
  return {
    name: "update_ui",
    description: "Update an existing chat UI widget by id, creating a new version.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing widget id." },
        title: { type: "string" },
        subtitle: { type: "string" },
        engine: { type: "string", enum: ["declarative", "html"] },
        spec: { type: "object", description: "Replacement declarative spec." },
        html: { type: "string", description: "Replacement HTML markup." },
        state: { type: "object", description: "Partial state overrides merged into spec.state." },
      },
      required: ["id"],
    },
    async execute(args, env) {
      const session = await ctx.sessions.get(env.sessionId);
      if (session === undefined) return textOutput("No active session for update_ui.", true);
      try {
        const previous = typeof args.id === "string" && args.id.trim() ? latestWidgetOf(session, args.id) : undefined;
        const artifact = buildUpdatedArtifact(args as unknown as UpdateUiInput, previous);
        recordArtifact(session, artifact);
        return {
          content: [{
            type: "text",
            text: `Updated interactive UI "${artifact.title}" (id: ${artifact.id}, v${artifact.version}, engine: ${artifact.engine}).`,
          }],
          details: artifact,
        };
      } catch (error) {
        return textOutput(`update_ui error: ${(error as Error).message}`, true);
      }
    },
  };
}

export function formatWidgetsSummary(widgets: Map<string, IntelligentUiArtifact[]>): string {
  if (widgets.size === 0) {
    return "当前会话暂无交互式 UI 组件。可直接输入 `/ui <需求描述>` 让助手生成可交互计算器、动态图表或沙箱微应用。";
  }
  const lines = ["### 当前会话交互式组件", ""];
  for (const [id, versions] of widgets.entries()) {
    const latest = versions[versions.length - 1];
    if (!latest) continue;
    lines.push(`- **${latest.title}** (\`${id}\` · v${latest.version} · ${latest.engine === "html" ? "HTML 沙箱" : "原生声明式"})`);
  }
  return lines.join("\n");
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(renderUiTool(ctx)), `${name}: render_ui`);
  ctx.effect(() => ctx.tools.register(updateUiTool(ctx)), `${name}: update_ui`);
  ctx.effect(
    () => ctx.systemPrompt.section("intelligent-ui", ({ tools }) => {
      const hasTool = tools.some((tool) => tool.name === "render_ui");
      return hasTool ? INTELLIGENT_UI_PROMPT_SECTION : undefined;
    }, { order: SectionOrder.guidelines + 25 }),
    `${name}: system-prompt`,
  );

  ctx.inject(["commands"], (inner) => {
    inner.effect(() => inner.commands.register({
      name: "ui",
      description: "生成或查看交互式 Intelligent UI 组件（例如 `/ui 房贷与提前还款对比计算器`）",
      argsHint: "[交互界面需求 | list | clear]",
      source: "intelligent-ui",
      async execute(rawArgs, env) {
        const trimmed = rawArgs.trim();
        if (trimmed === "" || trimmed.toLowerCase() === "list") {
          if (!env.sessionId) {
            return { output: "当前会话尚未开始。输入 `/ui <需求描述>` 可直接生成交互式组件。" };
          }
          const session = await inner.sessions.get(env.sessionId);
          if (session === undefined) return { output: "找不到当前会话。", isError: true };
          return { output: formatWidgetsSummary(widgetsOf(session)) };
        }
        if (trimmed.toLowerCase() === "clear") {
          if (!env.sessionId) return { output: "当前会话暂无交互式组件记录。" };
          const session = await inner.sessions.get(env.sessionId);
          if (session === undefined) return { output: "找不到当前会话。", isError: true };
          session.append("custom", { ns: NAMESPACE, data: { action: "clear" } });
          return { output: "已清空当前会话的交互式组件历史索引。" };
        }
        return {
          prompt: `请使用 render_ui 工具为以下需求构建一个直观、可交互的界面组件（优先使用契合场景的滑块/表单/动态图表或 HTML 沙箱微应用），并配以简明结论说明：\n\n${trimmed}`,
        };
      },
    }), `${name}: /ui`);
  });

  ctx.inject(["rpc"], (rpcCtx) => {
    rpcCtx.effect(
      () => rpcCtx.rpc.method("intelligentUi.list", async (params) => {
        const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
        if (typeof p.sessionId !== "string") {
          throw new RpcError(ErrorCode.InvalidParams, "sessionId must be a string");
        }
        const target = await rpcCtx.sessions.get(p.sessionId);
        if (target === undefined) {
          throw new RpcError(ErrorCode.SessionNotFound, `No session ${p.sessionId}`);
        }
        const map = widgetsOf(target);
        const widgets = [...map.entries()].map(([id, versions]) => ({
          id,
          versions,
          latest: versions[versions.length - 1],
        }));
        return { widgets };
      }),
      `${name}: intelligentUi.list`,
    );
  });
}
