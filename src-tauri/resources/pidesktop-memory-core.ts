export type MemoryWriteAction = "append" | "replace" | "clear";

export function nextMemoryContent(current: string, action: MemoryWriteAction, content?: string): string {
  if (action === "clear") return "";
  const value = content?.trim();
  if (!value) throw new Error(`content is required for ${action}`);
  return action === "append" && current.trim()
    ? `${current.trimEnd()}\n\n${value}\n`
    : `${value}\n`;
}
