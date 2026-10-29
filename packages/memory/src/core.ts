/**
 * Copied from src-tauri/resources/pidesktop-memory-core.ts (the Pi engine keeps
 * its copy until P6; ADR 0009).
 */
export type MemoryWriteAction = "append" | "replace" | "clear";

export function nextMemoryContent(current: string, action: MemoryWriteAction, content?: string): string {
  if (action === "clear") return "";
  const value = content?.trim();
  if (!value) throw new Error(`content is required for ${action}`);
  return action === "append" && current.trim()
    ? `${current.trimEnd()}\n\n${value}\n`
    : `${value}\n`;
}
