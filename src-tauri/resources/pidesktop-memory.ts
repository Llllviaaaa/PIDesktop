import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nextMemoryContent } from "./pidesktop-memory-core.ts";

const MAX_MEMORY_BYTES = 256 * 1024;
const MemorySchema = Type.Object({
  action: StringEnum(["read", "append", "replace", "clear"] as const),
  content: Type.Optional(Type.String({ description: "Markdown content for append or replace" })),
});

async function readMemory(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function saveMemory(path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES) {
    throw new Error("Local memory cannot exceed 256 KB");
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
}

export default function (pi: ExtensionAPI) {
  const memoryPath = process.env.PIDESKTOP_MEMORY_FILE;
  if (!memoryPath) return;

  pi.registerTool({
    name: "desktop_memory",
    label: "Local memory",
    description: "Read or update the user's explicit local Pi Desktop memory Markdown file.",
    promptSnippet: "Read or store durable user preferences in local memory",
    promptGuidelines: [
      "Use desktop_memory append or replace only when the user explicitly asks you to remember something, or states a stable preference that will clearly help future tasks.",
      "Do not store secrets, credentials, transient task details, guesses, or sensitive personal data.",
      "Use read before replacing. Prefer append for a new independent preference and keep entries concise.",
    ],
    parameters: MemorySchema,
    async execute(_toolCallId, params) {
      const current = await readMemory(memoryPath);
      if (params.action === "read") {
        return { content: [{ type: "text" as const, text: current || "Local memory is empty." }] };
      }
      const next = nextMemoryContent(current, params.action, params.content);
      await saveMemory(memoryPath, next);
      return {
        content: [{ type: "text" as const, text: params.action === "append" ? "Preference added to local memory." : params.action === "clear" ? "Local memory cleared." : "Local memory replaced." }],
      };
    },
  });
}
