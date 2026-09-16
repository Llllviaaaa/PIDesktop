import assert from "node:assert/strict";
import {
  attachmentsFromImageFiles,
  clipboardPlainText,
  imageFilesFromClipboard,
  isPastedImageFile,
  MAX_PASTED_IMAGE_BYTES,
  mergeAttachmentPayloads,
} from "../src/lib/clipboardImages";
import type { AttachmentPayload } from "../src/types";

class FakeFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array, name: string, type: string) {
    this.bytes = bytes;
    this.name = name;
    this.type = type;
    this.size = bytes.byteLength;
  }

  arrayBuffer() {
    return Promise.resolve(this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength));
  }
}

const png = (bytes: number[] | Uint8Array, name = "screenshot.png", type = "image/png") =>
  new FakeFile(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes), name, type) as unknown as File;

assert.equal(isPastedImageFile(png([1], "shot.png")), true);
assert.equal(isPastedImageFile(png([1], "shot.PNG", "")), true);
assert.equal(isPastedImageFile(png([1], "notes.txt", "text/plain")), false);
assert.equal(isPastedImageFile(png([1], "photo.bin", "application/octet-stream")), false);

const screenshot = png([137, 80, 78, 71], "image.png");
const namedJpeg = png([255, 216], "photo.jpg", "image/jpeg");
const notes = png([65], "notes.txt", "text/plain");
const duplicateItem = {
  type: "image/png",
  kind: "file",
  getAsFile: () => screenshot,
};

assert.deepEqual(
  imageFilesFromClipboard({
    items: [
      { type: "text/plain", kind: "string", getAsFile: () => null },
      duplicateItem,
      { type: "image/png", kind: "file", getAsFile: () => screenshot },
    ],
    files: [screenshot, namedJpeg],
    getData: () => "ignore files list when items already produced images",
  }),
  [screenshot],
);

assert.deepEqual(
  imageFilesFromClipboard({
    items: [{ type: "text/plain", kind: "string", getAsFile: () => null }],
    files: [notes, namedJpeg],
  }),
  [namedJpeg],
);

assert.equal(imageFilesFromClipboard(null).length, 0);
assert.equal(clipboardPlainText({ getData: () => "hello\r\nworld" }), "hello\nworld");
assert.equal(clipboardPlainText({}), "");

const converted = await attachmentsFromImageFiles(
  [screenshot, namedJpeg],
  (file, index) => `${index}-${file.name}`,
);
assert.equal(converted.errors.length, 0);
assert.equal(converted.attachments.length, 2);
assert.equal(converted.attachments[0].kind, "image");
assert.equal(converted.attachments[0].mimeType, "image/png");
assert.equal(converted.attachments[0].fileName, "image.png");
assert.equal(converted.attachments[0].path, "clipboard://0-image.png");
assert.equal(converted.attachments[0].data, Buffer.from([137, 80, 78, 71]).toString("base64"));
assert.equal(converted.attachments[1].mimeType, "image/jpeg");
assert.equal(converted.attachments[1].fileName, "photo.jpg");

const unnamed = png([1, 2, 3], "", "image/webp");
const unnamedConverted = await attachmentsFromImageFiles([unnamed], () => "anon");
assert.equal(unnamedConverted.attachments[0].fileName, "clipboard-image.webp");
assert.equal(unnamedConverted.attachments[0].mimeType, "image/webp");

const tooLarge = png(new Uint8Array(MAX_PASTED_IMAGE_BYTES + 1), "huge.png");
const oversized = await attachmentsFromImageFiles([tooLarge, screenshot], (file) => file.name);
assert.deepEqual(oversized.errors, ["huge.png 超过 12 MB 限制"]);
assert.equal(oversized.attachments.length, 1);
assert.equal(oversized.attachments[0].fileName, "image.png");

const existing: AttachmentPayload = converted.attachments[0];
const merged = mergeAttachmentPayloads([existing], [
  existing,
  { ...existing, path: "clipboard://copy", data: existing.data },
  converted.attachments[1],
]);
assert.equal(merged.length, 2);
assert.equal(merged[1].fileName, "photo.jpg");
const unchanged = [existing];
assert.strictEqual(mergeAttachmentPayloads(unchanged, []), unchanged);

const failing = {
  name: "broken.png",
  type: "image/png",
  size: 4,
  arrayBuffer() {
    return Promise.reject(new Error("disk gone"));
  },
} as File;
const failed = await attachmentsFromImageFiles([failing]);
assert.equal(failed.attachments.length, 0);
assert.deepEqual(failed.errors, ["broken.png 无法读取：disk gone"]);

console.log("clipboard image tests passed");
