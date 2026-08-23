/**
 * Thin helpers over Pi session-tree RPC (get_tree / fork).
 * Pure command builders are unit-tested; transport stays in the store.
 */

export interface SessionTreeEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
  };
  [key: string]: unknown;
}

export interface SessionTreeNode {
  entry: SessionTreeEntry;
  children: SessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

export interface FlatTreeNode {
  entryId: string;
  parentId: string | null;
  role: string;
  summary: string;
  depth: number;
  isLeaf: boolean;
  childCount: number;
}

export interface ActiveUserMessageEntry {
  entryId: string;
  parentId: string | null;
  text: string;
}

export function buildGetTreeCommand(): { type: "get_tree" } {
  return { type: "get_tree" };
}

export function buildForkCommand(entryId: string): { type: "fork"; entryId: string } {
  return { type: "fork", entryId };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join("");
}

function summarizeEntry(entry: SessionTreeEntry): { role: string; summary: string } {
  if (entry.type === "message" && entry.message) {
    const role = entry.message.role || "message";
    const text = textFromContent(entry.message.content).replace(/\s+/g, " ").trim();
    return {
      role,
      summary: text ? (text.length > 120 ? `${text.slice(0, 117)}…` : text) : `(${role})`,
    };
  }
  const type = typeof entry.type === "string" ? entry.type : "entry";
  const label = typeof entry.label === "string" ? entry.label : type;
  return { role: type, summary: label };
}

export function flattenSessionTree(
  tree: SessionTreeNode[] | undefined | null,
  leafId?: string | null,
): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];

  const walk = (nodes: SessionTreeNode[], depth: number) => {
    for (const node of nodes) {
      const entryId = typeof node.entry?.id === "string" ? node.entry.id : "";
      if (!entryId) continue;
      const { role, summary } = summarizeEntry(node.entry);
      const children = Array.isArray(node.children) ? node.children : [];
      result.push({
        entryId,
        parentId: typeof node.entry.parentId === "string" ? node.entry.parentId : null,
        role,
        summary: node.label || summary,
        depth,
        isLeaf: leafId ? entryId === leafId : children.length === 0,
        childCount: children.length,
      });
      walk(children, depth + 1);
    }
  };

  walk(Array.isArray(tree) ? tree : [], 0);
  return result;
}

/** User messages on the active root-to-leaf path, excluding abandoned branches. */
export function activeUserMessageEntries(
  tree: SessionTreeNode[] | undefined | null,
  leafId: string | null | undefined,
): ActiveUserMessageEntry[] {
  if (!leafId) return [];
  const entries = new Map<string, SessionTreeEntry>();

  const collect = (nodes: SessionTreeNode[]) => {
    for (const node of nodes) {
      const entry = node.entry;
      if (typeof entry?.id === "string") entries.set(entry.id, entry);
      collect(Array.isArray(node.children) ? node.children : []);
    }
  };
  collect(Array.isArray(tree) ? tree : []);

  const path: SessionTreeEntry[] = [];
  const visited = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const entry = entries.get(cursor);
    if (!entry) break;
    path.unshift(entry);
    cursor = typeof entry.parentId === "string" ? entry.parentId : null;
  }

  return path.flatMap((entry) => {
    if (entry.type !== "message" || entry.message?.role !== "user" || typeof entry.id !== "string") return [];
    return [{
      entryId: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      text: textFromContent(entry.message.content),
    }];
  });
}

/** User/assistant message nodes that are sensible continue/fork targets. */
export function forkableTreeNodes(nodes: FlatTreeNode[]): FlatTreeNode[] {
  return nodes.filter((node) => node.role === "user" || node.role === "assistant");
}
