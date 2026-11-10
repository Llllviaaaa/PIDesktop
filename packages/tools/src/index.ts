/**
 * The tool registry and execution pipeline (ADR 0003, 0008):
 *
 * 1. `tools/pre-execute` (async bail): the first listener to return a
 *    decision wins; none means allow.
 * 2. `tools/execute` (waterfall): wraps the call, e.g. checkpoints, timeouts,
 *    output truncation; the innermost `next` runs the tool.
 * 3. `tools/result` (emit): observes the outcome.
 *
 * `execute` never throws: a failing, denied or unknown tool becomes an error
 * result the model can read.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import type { ToolResultContent, ToolSchema } from "@qianji/llm";

declare module "@deepseek-ai/cordis" {
  interface Context {
    tools: Tools;
  }

  interface Events {
    "tools/pre-execute"(call: ToolCall, env: ToolEnv): Promise<ToolDecision | undefined> | ToolDecision | undefined;
    "tools/execute"(call: ToolCall, env: ToolEnv, next: () => Promise<ToolOutput>): Promise<ToolOutput>;
    "tools/result"(call: ToolCall, env: ToolEnv, output: ToolOutput): void;
  }
}

export interface ToolCall {
  id: string;
  name: string;
  /** May be rewritten by `tools/pre-execute` listeners before the tool runs. */
  args: Record<string, unknown>;
}

/** Where a call runs. */
export interface ToolEnv {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  /** The call being executed; set by `Tools.execute`. */
  callId?: string;
}

export type ToolDecision =
  | { allow: true }
  | { deny: true; reason: string };

export interface ToolOutput {
  content: ToolResultContent[];
  isError?: boolean;
  /** Structured data for the UI; not sent to the model. */
  details?: unknown;
}

export const ACTIVATE_TOOLS_NAME = "activate_tools";

export interface ToolDefinition<Args extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  /** JSON Schema of the arguments object; `required` and top-level types are checked. */
  parameters: Record<string, unknown> & { type: "object" };
  /** Optional capability group (e.g. `"browser"`, `"computer"`) for batch on-demand activation. */
  group?: string;
  /** Short summary shown in `activate_tools` when this tool's group is deferred. */
  groupDescription?: string;
  /**
   * When true, omit this tool's full JSON schema from per-session `schemas(sessionId)`
   * until activated via `activate_tools` or called directly in that session.
   */
  deferred?: boolean;
  execute(args: Args, env: ToolEnv): Promise<ToolOutput> | ToolOutput;
}

export function textOutput(text: string, isError = false): ToolOutput {
  return isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] };
}

const JSON_TYPES: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  array: (value) => Array.isArray(value),
  object: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
};

/** Why `args` do not fit `parameters`, or undefined when they do. Checks the top level only. */
export function argumentProblem(parameters: ToolDefinition["parameters"], args: Record<string, unknown>): string | undefined {
  if ("__invalidJson" in args) return "the arguments were not valid JSON";
  const required = Array.isArray(parameters.required) ? (parameters.required as string[]) : [];
  for (const key of required) {
    if (args[key] === undefined) return `missing required argument "${key}"`;
  }
  const properties = (parameters.properties ?? {}) as Record<string, { type?: unknown }>;
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key]?.type;
    if (value === undefined || typeof type !== "string") continue;
    const check = JSON_TYPES[type];
    if (check !== undefined && !check(value)) return `argument "${key}" must be ${type === "integer" ? "an integer" : `a ${type}`}`;
  }
  return undefined;
}

export class Tools extends Service {
  private readonly definitions = new Map<string, ToolDefinition>();
  /** sessionId → the only tools that session may see and call. */
  private readonly restrictions = new Map<string, ReadonlySet<string>>();
  /** sessionId → deferred tool names activated for that session. */
  private readonly activated = new Map<string, Set<string>>();

  constructor(ctx: Context) {
    super(ctx, "tools");
    ctx.on("session/deleted" as never, ((sessionId: string) => {
      this.activated.delete(sessionId);
    }) as never);
  }

  /** Offer a tool to every session. Returns the disposer; register it with the plugin's effects. */
  register<Args extends Record<string, unknown>>(definition: ToolDefinition<Args>): () => void {
    if (definition.name === ACTIVATE_TOOLS_NAME || this.definitions.has(definition.name)) {
      throw new Error(`Tool ${definition.name} is already registered`);
    }
    const entry = definition as unknown as ToolDefinition;
    this.definitions.set(definition.name, entry);
    return () => {
      if (this.definitions.get(definition.name) === entry) this.definitions.delete(definition.name);
    };
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  /**
   * Activate deferred tools by tool name, group name, or `"all"` for `sessionId`.
   * Returns the sorted list of matching tool names now active in the session.
   */
  activate(sessionId: string, namesOrGroups: Iterable<string>): string[] {
    const queries = [...namesOrGroups]
      .map((item) => String(item).trim().toLowerCase())
      .filter((item) => item !== "");
    if (queries.length === 0) return [];
    const wantAll = queries.includes("all") || queries.includes("*");
    const matched: string[] = [];
    for (const def of this.definitions.values()) {
      if (!def.deferred || !this.allows(sessionId, def.name)) continue;
      const lowerName = def.name.toLowerCase();
      const lowerGroup = def.group?.toLowerCase();
      const hit = wantAll || queries.some((q) => q === lowerName || (lowerGroup !== undefined && q === lowerGroup) || lowerName.startsWith(`${q}_`));
      if (hit) matched.push(def.name);
    }
    if (matched.length > 0) {
      let set = this.activated.get(sessionId);
      if (set === undefined) {
        set = new Set();
        this.activated.set(sessionId, set);
      }
      for (const name of matched) set.add(name);
    }
    return matched.sort((a, b) => a.localeCompare(b));
  }

  /** Whether a deferred tool has been activated for `sessionId`. */
  isActivated(sessionId: string, name: string): boolean {
    return this.activated.get(sessionId)?.has(name) === true;
  }

  /**
   * Limit `sessionId` to the tools named in `names` (a subagent's toolbox).
   * Returns the disposer.
   */
  restrict(sessionId: string, names: Iterable<string>): () => void {
    const allowed = new Set(names);
    this.restrictions.set(sessionId, allowed);
    return () => {
      if (this.restrictions.get(sessionId) === allowed) this.restrictions.delete(sessionId);
    };
  }

  /** Whether `sessionId` may use `name`. */
  allows(sessionId: string | undefined, name: string): boolean {
    const allowed = sessionId === undefined ? undefined : this.restrictions.get(sessionId);
    return allowed === undefined || allowed.has(name);
  }

  private buildActivateToolsSchema(unactivated: ToolDefinition[]): ToolSchema {
    const groups = new Map<string, ToolDefinition[]>();
    for (const def of unactivated) {
      const key = def.group ?? def.name;
      const list = groups.get(key) ?? [];
      list.push(def);
      groups.set(key, list);
    }
    const summaries = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, items]) => {
        if (items.length === 1 && items[0]?.group === undefined) {
          return `${key} (${items[0].description})`;
        }
        const desc = items.find((item) => item.groupDescription)?.groupDescription ?? items.map((item) => item.name).join(", ");
        return `${key} (${items.length} tools: ${desc})`;
      });
    return {
      name: ACTIVATE_TOOLS_NAME,
      description: `Load full schemas for on-demand toolsets before calling them. Available: ${summaries.join("; ")}.`,
      parameters: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            description: "Group names (e.g. 'browser', 'computer') or tool names to activate.",
          },
        },
        required: ["names"],
      },
    };
  }

  /**
   * What the model is told about each tool, sorted by name for stable prompts.
   * When `sessionId` is omitted, returns all registered tools (global introspection).
   * When `sessionId` is provided, unactivated `deferred` tools are collapsed into `activate_tools`.
   */
  schemas(sessionId?: string): ToolSchema[] {
    if (sessionId === undefined) {
      return [...this.definitions.values()]
        .map(({ name, description, parameters }) => ({ name, description, parameters }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    const visible: ToolSchema[] = [];
    const unactivated: ToolDefinition[] = [];
    for (const def of this.definitions.values()) {
      if (!this.allows(sessionId, def.name)) continue;
      if (def.deferred && !this.isActivated(sessionId, def.name)) {
        unactivated.push(def);
      } else {
        visible.push({ name: def.name, description: def.description, parameters: def.parameters });
      }
    }
    if (unactivated.length > 0) {
      visible.push(this.buildActivateToolsSchema(unactivated));
    }
    return visible.sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(call: ToolCall, env: ToolEnv): Promise<ToolOutput> {
    const output = await this.run(call, env);
    this.ctx.emit("tools/result", call, env, output);
    return output;
  }

  private deferredCatalogFor(sessionId: string): ToolDefinition[] {
    return [...this.definitions.values()].filter((def) => def.deferred && this.allows(sessionId, def.name));
  }

  private async run(call: ToolCall, env: ToolEnv): Promise<ToolOutput> {
    if (call.name === ACTIVATE_TOOLS_NAME) {
      const availableDeferred = this.deferredCatalogFor(env.sessionId);
      if (availableDeferred.length === 0 && !this.allows(env.sessionId, ACTIVATE_TOOLS_NAME)) {
        return textOutput(`Unknown tool "${call.name}".`, true);
      }
      if (env.signal.aborted) return textOutput("Aborted before the tool ran.", true);
      const schema = this.buildActivateToolsSchema(availableDeferred);
      try {
        const decision = await this.ctx.serial("tools/pre-execute", call, env);
        if (decision !== undefined && "deny" in decision) return textOutput(`Denied: ${decision.reason}`, true);
        const problem = argumentProblem(schema.parameters as ToolDefinition["parameters"], call.args);
        if (problem !== undefined) return textOutput(`Invalid arguments for ${call.name}: ${problem}.`, true);
        return await this.ctx.waterfall("tools/execute", call, env, async () => {
          const requested = Array.isArray(call.args.names) ? call.args.names.map(String) : [];
          const matched = this.activate(env.sessionId, requested);
          if (matched.length === 0) {
            const validGroups = [...new Set(availableDeferred.map((def) => def.group ?? def.name))].sort();
            return textOutput(
              `No deferred tools matched [${requested.join(", ")}]. Available groups/tools: ${validGroups.join(", ") || "none"}.`,
              true,
            );
          }
          const lines = matched.map((toolName) => {
            const def = this.definitions.get(toolName);
            return `- ${toolName}: ${def?.description ?? ""}`;
          });
          return textOutput(`Activated ${matched.length} tools for this session:\n${lines.join("\n")}`);
        });
      } catch (error) {
        if (env.signal.aborted) return textOutput("Aborted.", true);
        return textOutput(`${call.name} failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }

    const definition = this.allows(env.sessionId, call.name) ? this.definitions.get(call.name) : undefined;
    if (definition === undefined) return textOutput(`Unknown tool "${call.name}".`, true);
    if (env.signal.aborted) return textOutput("Aborted before the tool ran.", true);
    if (definition.deferred) {
      this.activate(env.sessionId, [definition.group ?? definition.name]);
    }
    try {
      const decision = await this.ctx.serial("tools/pre-execute", call, env);
      if (decision !== undefined && "deny" in decision) return textOutput(`Denied: ${decision.reason}`, true);
      const problem = argumentProblem(definition.parameters, call.args);
      if (problem !== undefined) return textOutput(`Invalid arguments for ${call.name}: ${problem}.`, true);
      return await this.ctx.waterfall("tools/execute", call, env, async () => definition.execute(call.args, { ...env, callId: call.id }));
    } catch (error) {
      if (env.signal.aborted) return textOutput("Aborted.", true);
      return textOutput(`${call.name} failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }
}
