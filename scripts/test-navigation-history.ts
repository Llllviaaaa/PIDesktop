import assert from "node:assert/strict";
import { navigationKey, withoutArchivedSessions, type NavigationTarget } from "../src/lib/navigationHistory";
import { normalizeLocalPath, sameLocalPath } from "../src/lib/pathIdentity";

assert.equal(normalizeLocalPath(" C:\\Users\\Example\\session.jsonl "), "c:/users/example/session.jsonl");
assert.equal(sameLocalPath("C:\\Users\\Example\\session.jsonl", "c:/users/example/session.jsonl"), true);
assert.equal(sameLocalPath("C:\\one.jsonl", "C:\\two.jsonl"), false);

const archivedFile = "C:\\Users\\Example\\archived.jsonl";
const targets: NavigationTarget[] = [
  { kind: "home", workspace: "C:\\Users\\Example" },
  { kind: "session", cwd: "C:\\Users\\Example", file: archivedFile },
  { kind: "session", cwd: "C:\\Users\\Example", file: "C:\\Users\\Example\\kept.jsonl" },
  { kind: "hub", view: "plugins" },
];

assert.deepEqual(
  withoutArchivedSessions(targets, ["c:/users/example/ARCHIVED.jsonl"]),
  [targets[0], targets[2], targets[3]],
  "archived sessions must be removed from navigation regardless of Windows path casing or separators",
);
assert.equal(
  navigationKey({ kind: "session", cwd: "C:\\Users\\Example", file: archivedFile }),
  navigationKey({ kind: "session", cwd: "c:/different-spelling", file: "c:/users/example/ARCHIVED.jsonl" }),
  "the session file is the stable identity for navigation",
);

console.log("navigation-history: all assertions passed");
