/**
 * Exercises shipped session-tree helpers.
 * Run: npx vitest run test-session-tree.test.ts
 */
import {
  activeUserMessageEntries,
  flattenSessionTree,
  forkableTreeNodes,
  type SessionTreeNode,
} from "../src/lib/sessionTree.ts";
import { test } from "vitest";

test("session tree", async () => {
  function assert(condition: unknown, message: string): void {
    if (!condition) throw new Error(message);
  }

  const fixture: SessionTreeNode[] = [
    {
      entry: {
        type: "message",
        id: "root-user",
        parentId: null,
        message: { role: "user", content: "Explain the architecture" },
      },
      children: [
        {
          entry: {
            type: "message",
            id: "child-assistant",
            parentId: "root-user",
            message: { role: "assistant", content: [{ type: "text", text: "Here is the architecture…" }] },
          },
          children: [
            {
              entry: {
                type: "message",
                id: "leaf-user",
                parentId: "child-assistant",
                message: { role: "user", content: "Go deeper on the RPC bridge" },
              },
              children: [],
            },
          ],
        },
        {
          entry: {
            type: "message",
            id: "branch-user",
            parentId: "root-user",
            message: { role: "user", content: "Alternative approach" },
          },
          children: [],
        },
      ],
    },
  ];

  const flat = flattenSessionTree(fixture, "leaf-user");
  assert(flat.length === 4, `expected 4 nodes, got ${flat.length}`);
  assert(flat[0].entryId === "root-user" && flat[0].depth === 0, "root depth");
  assert(flat.some((node) => node.entryId === "leaf-user" && node.isLeaf), "leaf marked from leafId");
  assert(flat.find((node) => node.entryId === "child-assistant")?.role === "assistant", "assistant role");

  const forkable = forkableTreeNodes(flat);
  assert(forkable.every((node) => node.role === "user" || node.role === "assistant"), "forkable roles");
  assert(forkable.some((node) => node.entryId === "branch-user"), "branch user is forkable");

  const activeUsers = activeUserMessageEntries(fixture, "leaf-user");
  assert(activeUsers.length === 2, "active path includes its two user messages");
  assert(activeUsers[0].entryId === "root-user" && activeUsers[0].parentId === null, "root user can rewind to an empty session");
  assert(activeUsers[1].entryId === "leaf-user" && activeUsers[1].parentId === "child-assistant", "nested user rewinds to its parent");
  assert(!activeUsers.some((entry) => entry.entryId === "branch-user"), "abandoned branch users are excluded from rewind targets");
});
