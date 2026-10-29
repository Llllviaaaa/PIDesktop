/**
 * Local memory (ADR 0009): one Markdown file of durable user preferences.
 * Its content goes into the system prompt, and the `desktop_memory` tool
 * reads and changes it when the user asks the agent to remember something.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { SectionOrder } from "@pid/system-prompt";
import { textOutput, type ToolDefinition } from "@pid/tools";
import { nextMemoryContent, type MemoryWriteAction } from "./core.ts";

export * from "./core.ts";

export const name = "pid-memory";
export const inject = ["tools", "systemPrompt"];

export interface Config {
  /** The memory file, e.g. `<dataDir>/memory.md`. */
  file: string;
}

export const MAX_MEMORY_BYTES = 256 * 1024;

export async function readMemory(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function saveMemory(path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES) throw new Error("Local memory cannot exceed 256 KB");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
}

export function memoryTool(file: string): ToolDefinition<{ action: "read" | MemoryWriteAction; content?: string }> {
  return {
    name: "desktop_memory",
    description: [
      "Read or update the user's explicit local Pi Desktop memory Markdown file.",
      "Use append or replace only when the user explicitly asks you to remember something, or states a stable preference that will clearly help future tasks.",
      "Do not store secrets, credentials, transient task details, guesses, or sensitive personal data.",
      "Use read before replacing. Prefer append for a new independent preference and keep entries concise.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "append", "replace", "clear"] },
        content: { type: "string", description: "Markdown content for append or replace" },
      },
      required: ["action"],
    },
    async execute({ action, content }) {
      const current = await readMemory(file);
      if (action === "read") return textOutput(current || "Local memory is empty.");
      if (!["append", "replace", "clear"].includes(action)) return textOutput(`Unknown action ${action}.`, true);
      await saveMemory(file, nextMemoryContent(current, action, content));
      return textOutput(action === "append" ? "Preference added to local memory." : action === "clear" ? "Local memory cleared." : "Local memory replaced.");
    },
  };
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.tools.register(memoryTool(config.file)), `${name}: desktop_memory`);
  ctx.effect(() => ctx.systemPrompt.section("memory", async () => {
    const memory = (await readMemory(config.file)).trim();
    if (memory === "") return undefined;
    return `The user's saved preferences (local memory). Follow them unless the user says otherwise:\n<memory>\n${memory}\n</memory>`;
  }, { order: SectionOrder.contextFiles + 50 }), `${name}: section`);
}
