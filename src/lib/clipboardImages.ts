import type { AttachmentPayload } from "../types";

export const MAX_PASTED_IMAGE_BYTES = 12 * 1024 * 1024;

const IMAGE_MIME_TYPES: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/jpg": true,
  "image/gif": true,
  "image/webp": true,
  "image/bmp": true,
  "image/svg+xml": true,
};

const IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

export interface ClipboardImageSource {
  items?: ArrayLike<{ type: string; kind?: string; getAsFile?: () => File | null }>;
  files?: ArrayLike<File>;
  getData?: (type: string) => string;
}

export function isPastedImageFile(file: File): boolean {
  const type = file.type.trim().toLowerCase();
  if (IMAGE_MIME_TYPES[type]) return true;
  if (type && type !== "application/octet-stream") return false;
  return Boolean(extensionMime(file.name));
}

export function imageFilesFromClipboard(data: ClipboardImageSource | null | undefined): File[] {
  if (!data) return [];
  const files: File[] = [];
  const seen = new Set<File>();

  const add = (file: File | null | undefined) => {
    if (!file || seen.has(file) || !isPastedImageFile(file)) return;
    seen.add(file);
    files.push(file);
  };

  if (data.items) {
    for (let index = 0; index < data.items.length; index += 1) {
      const item = data.items[index];
      if (item.kind && item.kind !== "file") continue;
      add(item.getAsFile?.() ?? null);
    }
  }

  if (files.length === 0 && data.files) {
    for (let index = 0; index < data.files.length; index += 1) add(data.files[index]);
  }

  return files;
}

export function clipboardPlainText(data: ClipboardImageSource | null | undefined): string {
  const text = data?.getData?.("text/plain") ?? "";
  return text.replace(/\r\n/g, "\n");
}

export async function attachmentsFromImageFiles(
  files: File[],
  idFor = (file: File, index: number) => `clipboard-${Date.now()}-${index}-${sanitizeFileName(file.name)}`,
): Promise<{ attachments: AttachmentPayload[]; errors: string[] }> {
  const attachments: AttachmentPayload[] = [];
  const errors: string[] = [];

  for (const [index, file] of files.entries()) {
    if (file.size > MAX_PASTED_IMAGE_BYTES) {
      errors.push(`${displayName(file)} 超过 12 MB 限制`);
      continue;
    }
    try {
      const mimeType = mimeForImageFile(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const fileName = displayName(file, mimeType);
      attachments.push({
        path: `clipboard://${idFor(file, index)}`,
        fileName,
        mimeType,
        size: file.size || bytes.byteLength,
        kind: "image",
        data: bytesToBase64(bytes),
      });
    } catch (error) {
      errors.push(`${displayName(file)} 无法读取：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { attachments, errors };
}

export function mergeAttachmentPayloads(
  current: AttachmentPayload[],
  incoming: AttachmentPayload[],
): AttachmentPayload[] {
  if (incoming.length === 0) return current;
  const next = [...current];
  for (const item of incoming) {
    if (next.some((existing) => sameAttachment(existing, item))) continue;
    next.push(item);
  }
  return next;
}

function sameAttachment(left: AttachmentPayload, right: AttachmentPayload): boolean {
  if (left.path === right.path) return true;
  return Boolean(left.kind === "image" && right.kind === "image" && left.data && left.data === right.data);
}

function mimeForImageFile(file: File): string {
  const type = file.type.trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  if (IMAGE_MIME_TYPES[type] && type !== "image/jpg") return type;
  return extensionMime(file.name) ?? "image/png";
}

function extensionMime(fileName: string): string | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  if (!match) return undefined;
  return IMAGE_EXTENSIONS[match[1].toLowerCase()];
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/svg+xml") return "svg";
  const subtype = mimeType.split("/")[1] ?? "png";
  return subtype.replace(/[^a-z0-9]+/gi, "") || "png";
}

function displayName(file: File, mimeType = mimeForImageFile(file)): string {
  const name = file.name.trim();
  if (name && name !== "image.png" && !/^image\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) return name;
  if (name) return name;
  return `clipboard-image.${extensionForMime(mimeType)}`;
}

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "image";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
