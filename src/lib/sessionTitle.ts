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

export function activeSessionTitle({
  sessions,
  sessionFile,
  sessionId,
  sessionName,
  firstMessage,
}: {
  sessions: SessionInfo[];
  sessionFile?: string | null;
  sessionId?: string | null;
  sessionName?: string | null;
  firstMessage?: string;
}): string {
  const normalizeFile = (value: string) => value.replace(/\\/g, "/").toLowerCase();
  const active = sessions.find((session) => (
    Boolean(sessionFile) && normalizeFile(session.file) === normalizeFile(sessionFile as string)
  ) || (
    Boolean(sessionId) && session.sessionId === sessionId
  ));

  if (active || sessionName?.trim() || firstMessage?.trim()) {
    return sessionTitle({
      ...(active || {
        file: sessionFile || "",
        sessionId: sessionId || "",
        cwd: "",
        messageCount: 0,
      }),
      name: sessionName?.trim() || active?.name,
      firstMessage: active?.firstMessage || firstMessage,
    });
  }
  return sessionId ? `任务 ${sessionId.slice(0, 8)}` : "新任务";
}

export function sessionRecency(session: SessionInfo): number {
  if (typeof session.updatedAt === "number" && Number.isFinite(session.updatedAt)) return session.updatedAt;
  const created = session.createdAt ? Date.parse(session.createdAt) : NaN;
  return Number.isFinite(created) ? created : 0;
}
