import type { SessionInfo } from "../types";

/** Thread titles only — never show cwd, URLs, or bare paths as labels. */
export function sessionTitle(session: SessionInfo): string {
  const raw = (session.name || session.firstMessage || "").trim().replace(/\s+/g, " ");
  if (!raw) return "未命名对话";
  if (/^https?:\/\//i.test(raw)) return "未命名对话";
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.includes("\\") || raw.startsWith("/")) {
    const leaf = raw.split(/[\\/]/).filter(Boolean).pop();
    if (leaf && leaf.length < 40 && !/^\d+$/.test(leaf)) return leaf;
    return "未命名对话";
  }
  if (/^\d{4,}$/.test(raw)) return "未命名对话";
  return raw.length > 42 ? `${raw.slice(0, 40)}…` : raw;
}

export function sessionRecency(session: SessionInfo): number {
  if (typeof session.updatedAt === "number" && Number.isFinite(session.updatedAt)) return session.updatedAt;
  const created = session.createdAt ? Date.parse(session.createdAt) : NaN;
  return Number.isFinite(created) ? created : 0;
}
