import type { RuntimeState } from "../storeTypes";
import type { AppNotification, SessionInfo } from "../types";
import type { PetAnimationState } from "./appearanceCatalog";
import { sameLocalPath } from "./pathIdentity";

export type PetActivityStatus = "needs-input" | "blocked" | "ready" | "running";

export interface PetActivityItem {
  id: string;
  status: PetActivityStatus;
  title: string;
  body: string;
  cwd: string;
  sessionFile: string | null;
  updatedAt: number;
  notificationId?: string;
}

interface BuildPetActivitiesInput {
  runtimes: Record<string, RuntimeState>;
  notifications: AppNotification[];
  sessions: SessionInfo[];
  current?: PetActivityItem | null;
}

const STATUS_PRIORITY: Record<PetActivityStatus, number> = {
  "needs-input": 0,
  blocked: 1,
  ready: 2,
  running: 3,
};

function fallbackTitle(cwd: string, sessionFile: string | null): string {
  const source = sessionFile || cwd;
  const segments = source.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1]?.replace(/\.jsonl?$/i, "") || "Pi 任务";
}

function activityTitle(sessions: SessionInfo[], cwd: string, sessionFile: string | null): string {
  const session = sessionFile
    ? sessions.find((item) => sameLocalPath(item.file, sessionFile))
    : undefined;
  return session?.name?.trim()
    || session?.firstMessage?.trim()
    || fallbackTitle(cwd, sessionFile);
}

function activityKey(item: PetActivityItem): string {
  return item.sessionFile?.replace(/\\/g, "/").toLowerCase()
    || `${item.cwd.replace(/\\/g, "/").toLowerCase()}:${item.title}`;
}

export function buildPetActivities({
  runtimes,
  notifications,
  sessions,
  current,
}: BuildPetActivitiesInput): PetActivityItem[] {
  const candidates: PetActivityItem[] = [];

  for (const notification of notifications) {
    if (notification.read) continue;
    candidates.push({
      id: `notification:${notification.id}`,
      notificationId: notification.id,
      status: notification.kind === "completion" ? "ready" : "needs-input",
      title: activityTitle(sessions, notification.cwd, notification.sessionFile),
      body: notification.title || notification.body,
      cwd: notification.cwd,
      sessionFile: notification.sessionFile,
      updatedAt: notification.createdAt,
    });
  }

  for (const runtime of Object.values(runtimes)) {
    if (!runtime.extensionRequest && !runtime.isStreaming && runtime.status !== "starting") continue;
    const requestTitle = runtime.extensionRequest && "title" in runtime.extensionRequest
      ? runtime.extensionRequest.title
      : undefined;
    candidates.push({
      id: `runtime:${runtime.runtimeId}`,
      status: runtime.extensionRequest ? "needs-input" : "running",
      title: activityTitle(sessions, runtime.cwd, runtime.sessionFile),
      body: requestTitle
        || (runtime.status === "starting" ? "正在启动" : "正在工作"),
      cwd: runtime.cwd,
      sessionFile: runtime.sessionFile,
      updatedAt: runtime.updatedAt,
    });
  }

  if (current) candidates.push(current);

  const deduplicated = new Map<string, PetActivityItem>();
  for (const candidate of candidates) {
    const key = activityKey(candidate);
    const existing = deduplicated.get(key);
    if (!existing
      || STATUS_PRIORITY[candidate.status] < STATUS_PRIORITY[existing.status]
      || (candidate.status === existing.status && candidate.updatedAt > existing.updatedAt)) {
      deduplicated.set(key, candidate);
    }
  }

  return [...deduplicated.values()]
    .sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || b.updatedAt - a.updatedAt)
    .slice(0, 8);
}

export function petStatusToAnimation(status: PetActivityStatus | undefined): PetAnimationState {
  if (status === "needs-input") return "waiting";
  if (status === "blocked") return "failed";
  if (status === "ready") return "waving";
  if (status === "running") return "running";
  return "idle";
}
