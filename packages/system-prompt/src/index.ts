/**
 * The system prompt as ordered sections (ADR 0003). Plugins offer a section
 * with `systemPrompt.section(id, render, { order })`; the loop calls `build`
 * before every model call, so sections may change between turns.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import type { ToolSchema } from "@pid/llm";

declare module "@deepseek-ai/cordis" {
  interface Context {
    systemPrompt: SystemPrompt;
  }
}

/** What a section can base its text on. */
export interface PromptEnv {
  sessionId: string;
  cwd: string;
  model: { provider: string; model: string };
  tools: readonly ToolSchema[];
}

export type SectionRender = (env: PromptEnv) => string | undefined | Promise<string | undefined>;

export interface SectionOptions {
  /** Lower comes first; ties are broken by id. Default 500. */
  order?: number;
}

/** Conventional orders, so independent plugins land in a sensible place. */
export const SectionOrder = {
  identity: 0,
  guidelines: 100,
  contextFiles: 500,
  skills: 600,
  environment: 900,
} as const;

interface Section {
  id: string;
  order: number;
  render: SectionRender;
}

export class SystemPrompt extends Service {
  private readonly sections = new Map<string, Section>();

  constructor(ctx: Context) {
    super(ctx, "systemPrompt");
  }

  /** Offer a section. Returns the disposer; register it with the plugin's effects. */
  section(id: string, render: SectionRender, options: SectionOptions = {}): () => void {
    if (this.sections.has(id)) throw new Error(`System prompt section ${id} is already registered`);
    const section: Section = { id, order: options.order ?? 500, render };
    this.sections.set(id, section);
    return () => {
      if (this.sections.get(id) === section) this.sections.delete(id);
    };
  }

  /** The sections' text in order, blank ones left out. A failing section is skipped and logged. */
  async build(env: PromptEnv): Promise<string> {
    const ordered = [...this.sections.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const parts: string[] = [];
    for (const section of ordered) {
      try {
        const text = (await section.render(env))?.trim();
        if (text) parts.push(text);
      } catch (error) {
        this.ctx.logger("system-prompt").warn("section %s failed: %s", section.id, error);
      }
    }
    return parts.join("\n\n");
  }
}
