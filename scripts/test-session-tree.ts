/**
 * Exercises shipped session-tree helpers and the continue/fork command sequence.
 * Run: npx --yes tsx scripts/test-session-tree.ts
 */
import {
  buildForkCommand,
  buildGetTreeCommand,
  flattenSessionTree,
  forkableTreeNodes,
  type SessionTreeNode,
} from "../src/lib/sessionTree.ts";

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

const getTree = buildGetTreeCommand();
assert(getTree.type === "get_tree", "get_tree command type");

const fork = buildForkCommand("root-user");
assert(fork.type === "fork" && fork.entryId === "root-user", "fork command must use real entry id");

const flat = flattenSessionTree(fixture, "leaf-user");
assert(flat.length === 4, `expected 4 nodes, got ${flat.length}`);
assert(flat[0].entryId === "root-user" && flat[0].depth === 0, "root depth");
assert(flat.some((node) => node.entryId === "leaf-user" && node.isLeaf), "leaf marked from leafId");
assert(flat.find((node) => node.entryId === "child-assistant")?.role === "assistant", "assistant role");

const forkable = forkableTreeNodes(flat);
assert(forkable.every((node) => node.role === "user" || node.role === "assistant"), "forkable roles");
assert(forkable.some((node) => node.entryId === "branch-user"), "branch user is forkable");

// Simulate the store continue path: load tree → pick node → issue fork payload (transport mocked at boundary)
async function continueFromNode(
  entryId: string,
  send: (payload: Record<string, unknown>) => Promise<{ success: boolean; command: string }>,
) {
  const load = buildGetTreeCommand();
  await send(load);
  const command = buildForkCommand(entryId);
  return send(command);
}

const sent: Record<string, unknown>[] = [];
const result = await continueFromNode("branch-user", async (payload) => {
  sent.push(payload);
  return { success: true, command: String(payload.type) };
});

assert(result.success && result.command === "fork", "continue path ends with fork");
assert(sent.length === 2, "continue issues get_tree then fork");
assert(sent[0].type === "get_tree", "first command is get_tree");
assert(sent[1].type === "fork" && sent[1].entryId === "branch-user", "second command forks selected node");

console.log("session-tree: all assertions passed");
