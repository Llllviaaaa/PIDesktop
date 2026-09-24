import assert from "node:assert/strict";
import { test } from "vitest";
import {
  preferredEditorFor,
  projectEditorChoice,
  relativeWorkspacePath,
  rememberProjectEditor,
  resolveWorkspacePath,
} from "../src/lib/workspaceEditors.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const EDITORS = [
  { id: "vscode", name: "Visual Studio Code", supportsLine: true },
  { id: "rider", name: "Rider", supportsLine: true },
  { id: "visualstudio", name: "Visual Studio", supportsLine: false },
];

test("remembers the editor per project and falls back in order", () => {
  const storage = memoryStorage();
  assert.equal(preferredEditorFor("D:\\Game", EDITORS, "system", storage)?.id, "vscode");
  assert.equal(preferredEditorFor("D:\\Game", EDITORS, "visualstudio", storage)?.id, "visualstudio");

  rememberProjectEditor("D:\\Game\\", "rider", storage);
  // Separators, case and trailing slashes do not make a different project.
  assert.equal(projectEditorChoice("d:/game", storage), "rider");
  assert.equal(preferredEditorFor("D:/game", EDITORS, "visualstudio", storage)?.id, "rider");
  assert.equal(preferredEditorFor("D:\\Web", EDITORS, "visualstudio", storage)?.id, "visualstudio");

  // An editor that is no longer installed is skipped.
  rememberProjectEditor("D:\\Web", "cursor", storage);
  assert.equal(preferredEditorFor("D:\\Web", EDITORS, "system", storage)?.id, "vscode");
  assert.equal(preferredEditorFor("D:\\Web", [], "system", storage), null);
});

test("resolves workspace-relative paths", () => {
  assert.equal(resolveWorkspacePath("D:\\repo\\", "src/app.ts"), "D:\\repo\\src\\app.ts");
  assert.equal(resolveWorkspacePath("D:\\repo", "./src/app.ts"), "D:\\repo\\src\\app.ts");
  assert.equal(resolveWorkspacePath("D:\\repo", "C:\\other\\file.rs"), "C:\\other\\file.rs");
  assert.equal(resolveWorkspacePath("/home/me/repo", "src\\app.ts"), "/home/me/repo/src/app.ts");
  assert.equal(relativeWorkspacePath("D:\\repo", "D:\\Repo\\src\\app.ts"), "src/app.ts");
  assert.equal(relativeWorkspacePath("D:\\repo", "src/app.ts"), "src/app.ts");
  assert.equal(relativeWorkspacePath("D:\\repo", "E:\\elsewhere\\a.ts"), "E:/elsewhere/a.ts");
});
