/**
 * The slash command registry (`ctx.commands`, ADR 0002, 0003).
 *
 * Plugins register static commands with `register` or workspace-dependent
 * commands (such as skills discovered under `<cwd>/.pid/skills`) with
 * `registerProvider`. Every registration returns a disposer so hot-reloading
 * or disabling a plugin removes its commands cleanly and emits
 * `commands/changed`.
 */
import { Context, Service } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    commands: Commands;
  }

  interface Events {
    "commands/changed"(reason: string): void;
  }
}

export interface CommandEnv {
  sessionId?: string;
  cwd: string;
  signal: AbortSignal;
}

export interface CommandResult {
  /** Markdown or plain text shown directly in the conversation without calling the model. */
  output?: string;
  /** Expanded user prompt to hand off to the agent loop. */
  prompt?: string;
  /** Client-side action hint (`clear` starts a fresh session; `compact` runs session compaction). */
  clientAction?: "clear" | "compact";
  isError?: boolean;
}

export interface CommandDescriptor {
  name: string;
  description: string;
  argsHint?: string;
  source: string;
}

export interface CommandDefinition {
  name: string;
  description: string;
  /** Short argument syntax shown in the composer `/` menu, e.g. `[clear]` or `<uri>`. */
  argsHint?: string;
  /** Origin label shown in the `/` menu (`builtin`, `plugin`, `skill`, `mcp`, …). */
  source?: string;
  execute(rawArgs: string, env: CommandEnv): Promise<CommandResult> | CommandResult;
}

export type CommandProvider = (cwd?: string) => readonly CommandDefinition[] | Promise<readonly CommandDefinition[]>;

export function normalizeCommandName(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(trimmed)) {
    throw new Error(`Invalid slash command name "${raw}"`);
  }
  return trimmed;
}

/** Parse a leading `/command [args]` line, or undefined when the input is not a slash command. */
export function parseSlashCommand(text: string): { name: string; rawArgs: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const match = /^\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match?.[1] === undefined) return undefined;
  return { name: match[1], rawArgs: (match[2] ?? "").trim() };
}

function bindCallerEffect(ctx: Context | undefined, dispose: () => void, label: string): () => void {
  let disposed = false;
  const once = (): void => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
  if (ctx?.fiber?.uid != null && ctx.fiber.state !== 5) {
    try {
      return ctx.effect(() => once, label) as unknown as () => void;
    } catch {
      return once;
    }
  }
  return once;
}

export class Commands extends Service {
  private readonly definitions = new Map<string, CommandDefinition>();
  private readonly providers = new Set<CommandProvider>();

  constructor(ctx: Context) {
    super(ctx, "commands");
  }

  /** Register one slash command; automatically cleans up with the caller's Cordis fiber. */
  register(definition: CommandDefinition): () => void {
    const name = normalizeCommandName(definition.name);
    if (this.definitions.has(name)) {
      throw new Error(`Command /${name} is already registered`);
    }
    const normalized: CommandDefinition = { ...definition, name };
    this.definitions.set(name, normalized);
    this.notifyChanged(`register:${name}`);
    return bindCallerEffect(
      this.ctx,
      () => {
        if (this.definitions.get(name) === normalized) {
          this.definitions.delete(name);
          this.notifyChanged(`unregister:${name}`);
        }
      },
      `commands.register:${name}`,
    );
  }

  /** Register a dynamic command provider (for example workspace `SKILL.md` commands). */
  registerProvider(provider: CommandProvider): () => void {
    this.providers.add(provider);
    this.notifyChanged("provider:add");
    return bindCallerEffect(
      this.ctx,
      () => {
        if (this.providers.delete(provider)) {
          this.notifyChanged("provider:remove");
        }
      },
      "commands.registerProvider",
    );
  }

  notifyChanged(reason = "updated"): void {
    this.ctx.emit("commands/changed", reason);
  }

  private async resolveAll(cwd?: string): Promise<Map<string, CommandDefinition>> {
    const merged = new Map<string, CommandDefinition>();
    // Dynamic providers load first so explicit static registrations win on name collisions.
    for (const provider of this.providers) {
      try {
        const items = await provider(cwd);
        for (const item of items) {
          const name = normalizeCommandName(item.name);
          merged.set(name, { ...item, name });
        }
      } catch (error) {
        this.ctx.logger("commands").warn("command provider failed: %s", error instanceof Error ? error.message : String(error));
      }
    }
    for (const [name, definition] of this.definitions) {
      merged.set(name, definition);
    }
    return merged;
  }

  async list(cwd?: string): Promise<CommandDescriptor[]> {
    const all = await this.resolveAll(cwd);
    return [...all.values()]
      .map((def): CommandDescriptor => ({
        name: def.name,
        description: def.description,
        ...(def.argsHint === undefined ? {} : { argsHint: def.argsHint }),
        source: def.source ?? "plugin",
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async has(name: string, cwd?: string): Promise<boolean> {
    const normalized = name.trim().replace(/^\/+/, "");
    if (this.definitions.has(normalized)) return true;
    return (await this.resolveAll(cwd)).has(normalized);
  }

  async run(
    name: string,
    rawArgs: string,
    env: CommandEnv,
  ): Promise<{ handled: boolean } & CommandResult> {
    const normalized = name.trim().replace(/^\/+/, "");
    const all = await this.resolveAll(env.cwd);
    const definition = all.get(normalized);
    if (definition === undefined) return { handled: false };
    try {
      const result = await definition.execute(rawArgs, env);
      return { handled: true, ...result };
    } catch (error) {
      return {
        handled: true,
        isError: true,
        output: `命令 \`/${normalized}\` 执行失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
