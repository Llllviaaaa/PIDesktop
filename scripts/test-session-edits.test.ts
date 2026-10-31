// The conversation's change card counts only the files this session wrote
// (src/lib/sessionEdits.ts), not every uncommitted change in the checkout.
import { describe, expect, it } from "vitest";
import { changesEditedBy, sessionEditedPaths } from "../src/lib/sessionEdits";
import type { GitFileChange, UiMessage, UiToolCall } from "../src/types";

const call = (name: string, path: string, extra: Partial<UiToolCall> = {}): UiToolCall => ({ id: `${name}-${path}`, name, args: { path }, running: false, isError: false, ...extra });
const turn = (...toolCalls: UiToolCall[]): UiMessage => ({ id: "a", role: "assistant", content: "", toolCalls, timestamp: 0 });
const change = (path: string): GitFileChange => ({ path, status: "M" });

describe("files the session edited", () => {
  it("takes edits and writes that succeeded, and skips reads, failures and running calls", () => {
    const messages = [
      turn(call("write", "C:\\work\\repo\\a.txt"), call("read", "notes.txt")),
      turn(call("edit", "src/app.ts"), call("edit", "broken.ts", { isError: true }), call("write", "pending.ts", { running: true })),
    ];
    expect(sessionEditedPaths(messages)).toEqual(["C:\\work\\repo\\a.txt", "src/app.ts"]);
  });

  it("matches git's repository-relative paths against absolute and relative tool paths", () => {
    const files = [change("a.txt"), change("src/app.ts"), change("conversation.md")];
    expect(changesEditedBy(files, ["C:\\work\\repo\\a.txt", "./SRC/app.ts"]).map((file) => file.path)).toEqual(["a.txt", "src/app.ts"]);
  });

  it("shows nothing for a session that wrote no file", () => {
    expect(changesEditedBy([change("a.txt")], [])).toEqual([]);
    expect(changesEditedBy([change("data.txt")], ["C:\\work\\repo\\metadata.txt"])).toEqual([]);
  });
});
