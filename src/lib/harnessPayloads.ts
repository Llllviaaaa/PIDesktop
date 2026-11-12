/**
 * What the desktop sends to and hears from Host sessions (re-exported by
 * harnessRuntime.ts): prompt payloads and content, Host UI requests as
 * dialogs, and leading slash commands.
 */
import type { UiRequestNotification } from "@qianji/protocol";
import type { AttachmentPayload, ExtensionUIRequest } from "../types";

/** A prompt as the composer builds it: its text and attached images. */
export interface PromptInput {
  message: string;
  images: Array<{ type?: "image"; data: string; mimeType: string }>;
}

/** What the composer sends: the text, local file references, and attached images. */
export function buildPromptPayload(text: string, attachments: AttachmentPayload[]): PromptInput {
  const trimmed = text.trim();
  const fileReferences = attachments
    .filter((item) => item.kind !== "image")
    .map((item) => `- ${item.fileName}: ${item.path}`);
  const message = fileReferences.length
    ? `${trimmed}\n\n附加的本地文件：\n${fileReferences.join("\n")}`.trim()
    : trimmed;
  const images = attachments.flatMap((item) => (item.kind === "image" && item.data ? [{ type: "image" as const, data: item.data, mimeType: item.mimeType }] : []));
  return { message, images };
}

/** A prompt as Host prompt content. */
export function promptContent(input: PromptInput): Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> {
  const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [];
  if (input.message !== "") content.push({ type: "text", text: input.message });
  for (const image of input.images) content.push({ type: "image", mimeType: image.mimeType, data: image.data });
  return content;
}

/** A Host `ui/request` as Pi's extension UI request. */
export function uiRequestEvent(request: UiRequestNotification): ExtensionUIRequest | undefined {
  const id = request.requestId ?? `harness-notify-${Date.now()}`;
  switch (request.kind) {
    case "confirm":
      return { type: "extension_ui_request", id, method: "confirm", title: request.title, message: request.message };
    case "select":
      return { type: "extension_ui_request", id, method: "select", title: request.title, options: request.options };
    case "input":
      return { type: "extension_ui_request", id, method: "input", title: request.title, ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }) };
    case "notify":
      return { type: "extension_ui_request", id, method: "notify", message: request.message, notifyType: request.level };
    default:
      return undefined;
  }
}

/** Parse a leading `/command [args]` line, or null when the input is not a slash command. */
export function parseLeadingSlashCommand(text: string): { name: string; rawArgs: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match?.[1] === undefined) return null;
  return { name: match[1], rawArgs: (match[2] ?? "").trim() };
}
