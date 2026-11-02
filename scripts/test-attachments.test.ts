import assert from "node:assert/strict";
import { test } from "vitest";
import { mergeAttachments } from "../src/lib/attachments";
import type { AttachmentPayload } from "../src/types";

const file = (path: string): AttachmentPayload => ({
  path,
  fileName: path.split("/").pop() ?? path,
  mimeType: "text/plain",
  size: 1,
  kind: "text",
});

test("attachments merge by path", () => {
  const current = [file("a/one.txt")];
  const merged = mergeAttachments(current, [file("a/one.txt"), file("a/two.txt"), file("a/two.txt")]);
  assert.deepEqual(merged.map((item) => item.path), ["a/one.txt", "a/two.txt"]);
  // The list it was given stays as it was.
  assert.equal(current.length, 1);
});
