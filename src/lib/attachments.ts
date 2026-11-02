import type { AttachmentPayload } from "../types";
import { agent } from "./agent";

/** Matches the desktop's own limit in `read_attachment`. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Reads files by path; a file that fails is reported and left out. */
export async function loadAttachmentFiles(
  paths: string[],
  onError: (reason: unknown) => void,
): Promise<AttachmentPayload[]> {
  const loaded = await Promise.all(paths.map(async (path) => {
    try {
      return await agent.readAttachment(path);
    } catch (reason) {
      onError(reason);
      return null;
    }
  }));
  return loaded.filter((item): item is AttachmentPayload => item !== null);
}

/** Appends attachments the list does not hold yet, keyed by path. */
export function mergeAttachments(current: AttachmentPayload[], added: AttachmentPayload[]): AttachmentPayload[] {
  const next = [...current];
  for (const item of added) {
    if (!next.some((existing) => existing.path === item.path)) next.push(item);
  }
  return next;
}

let pastedImageCount = 0;

/**
 * An image the webview handed over without a path on disk (a paste, or a drop
 * outside the desktop). Images travel as data, so the path is only a key.
 */
export async function imageAttachmentFromBlob(file: File): Promise<AttachmentPayload | null> {
  if (!file.type.startsWith("image/") || file.size > MAX_IMAGE_BYTES) return null;
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  pastedImageCount += 1;
  const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const fileName = file.name && file.name !== "image.png" ? file.name : `粘贴的图片 ${pastedImageCount}.${extension}`;
  return {
    path: `pasted:${Date.now()}-${pastedImageCount}`,
    fileName,
    mimeType: file.type,
    size: file.size,
    kind: "image",
    data,
  };
}
