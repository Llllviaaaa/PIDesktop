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
import type { ToolResultContent, ToolSchema } from "@pid/llm";

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

export interface ToolDefinition<Args extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  /** JSON Schema of the arguments object; `required` and top-level types are checked. */
  parameters: Record<string, unknown> & { type: "object" };
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

  constructor(ctx: Context) {
    super(ctx, "tools");
  }

  /** Offer a tool to every session. Returns the disposer; register it with the plugin's effects. */
  register<Args extends Record<string, unknown>>(definition: ToolDefinition<Args>): () => void {
    if (this.definitions.has(definition.name)) throw new Error(`Tool ${definition.name} is already registered`);
    const entry = definition as unknown as ToolDefinition;
    this.definitions.set(definition.name, entry);
    return () => {
      if (this.definitions.get(definition.name) === entry) this.definitions.delete(definition.name);
    };
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  /** What the model is told about each tool, sorted by name for stable prompts. */
  schemas(): ToolSchema[] {
    return [...this.definitions.values()]
      .map(({ name, description, parameters }) => ({ name, description, parameters }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(call: ToolCall, env: ToolEnv): Promise<ToolOutput> {
    const output = await this.run(call, env);
    this.ctx.emit("tools/result", call, env, output);
    return output;
  }

  private async run(call: ToolCall, env: ToolEnv): Promise<ToolOutput> {
    const definition = this.definitions.get(call.name);
    if (definition === undefined) return textOutput(`Unknown tool "${call.name}".`, true);
    if (env.signal.aborted) return textOutput("Aborted before the tool ran.", true);
    try {
      const decision = await this.ctx.serial("tools/pre-execute", call, env);
      if (decision !== undefined && "deny" in decision) return textOutput(`Denied: ${decision.reason}`, true);
      const problem = argumentProblem(definition.parameters, call.args);
      if (problem !== undefined) return textOutput(`Invalid arguments for ${call.name}: ${problem}.`, true);
      return await this.ctx.waterfall("tools/execute", call, env, async () => definition.execute(call.args, env));
    } catch (error) {
      if (env.signal.aborted) return textOutput("Aborted.", true);
      return textOutput(`${call.name} failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }
}
