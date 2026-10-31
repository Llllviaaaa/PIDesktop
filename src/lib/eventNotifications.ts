import type { ExtensionUIRequest } from "../types";
import type { NotificationDraft } from "./notificationCenter";
import { headlineForUiRequest } from "./batchAsk";

/**
 * Notification policy for Pi runtime events.
 *
 * These decisions — whether an event is worth interrupting for, what it is
 * called, and how it reads in the tray — were inlined in the store's event
 * reducer, which mixed presentation into the state machine and duplicated the
 * silent-method list. They are pure functions here so the store only has to
 * decide *when* to raise a notification, and so the copy can be tested.
 */

/** Extension UI methods that render inline; they never raise a notification. */
export const SILENT_UI_REQUEST_METHODS = [
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
] as const;

export function isSilentUiRequest(method: string): boolean {
  return (SILENT_UI_REQUEST_METHODS as readonly string[]).includes(method);
}

export interface NotificationPlan {
  draft: NotificationDraft;
  /** Title for the OS notification, which is phrased for a user looking away. */
  osTitle: string;
  osBody: string;
  /** Approvals stay on screen until acted on. */
  requiresApproval: boolean;
}

export interface SessionContext {
  cwd: string;
  sessionFile: string | null;
  /** Session name in the foreground; unused for background runtimes. */
  sessionName?: string | null;
}

const COMPLETED_BODY = "本地编码任务已完成，可以开始检查。";

/** Last path segment of a workspace, which is what the user calls the project. */
export function projectLabelFromCwd(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() || "后台任务";
}

export function completionNotification(
  runtimeId: string,
  context: SessionContext,
  background: boolean,
): NotificationPlan {
  const body = background
    ? projectLabelFromCwd(context.cwd)
    : context.sessionName || COMPLETED_BODY;
  return {
    draft: {
      id: `${runtimeId}:completion:${Date.now()}`,
      kind: "completion",
      title: "任务已完成",
      body,
      cwd: context.cwd,
      sessionFile: context.sessionFile,
    },
    osTitle: background ? "后台任务已完成" : "任务已完成",
    osBody: body,
    requiresApproval: false,
  };
}

export function uiRequestNotification(
  runtimeId: string,
  request: ExtensionUIRequest,
  context: SessionContext,
  background: boolean,
): NotificationPlan | null {
  if (isSilentUiRequest(request.method)) return null;
  const kind = request.method === "confirm" ? "approval" : "question";
  const title =
    headlineForUiRequest(
      request.method,
      "title" in request ? request.title : undefined,
      request.method === "input" ? request.placeholder : undefined,
    ) || (kind === "approval" ? "需要确认" : "需要输入");
  const body = background
    ? kind === "approval"
      ? "打开任务以确认本地操作。"
      : "打开任务以回答问题。"
    : kind === "approval"
      ? "有一项本地操作正在等待你的决定。"
      : "Agent 正在等待你的回答。";
  return {
    draft: {
      id: `${runtimeId}:request:${request.id}`,
      kind,
      title,
      body,
      cwd: context.cwd,
      sessionFile: context.sessionFile,
    },
    osTitle: background ? "后台任务等待审批" : "任务需要审批",
    osBody: title,
    requiresApproval: true,
  };
}
