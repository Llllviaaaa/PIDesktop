import { invoke } from "@tauri-apps/api/core";
import type { AgentMessage, SessionHistory, SessionInfo, SessionMessageTiming } from "../types";

let sessionsRequest: Promise<SessionInfo[]> | null = null;

export const sessionClient = {
  list(): Promise<SessionInfo[]> {
    if (!sessionsRequest) {
      sessionsRequest = invoke<SessionInfo[]>("list_sessions_cmd")
        .finally(() => { sessionsRequest = null; });
    }
    return sessionsRequest;
  },
  history: (file: string) => invoke<SessionHistory>("session_history_cmd", { file }),
  exportMarkdown: (file: string, destination: string) => invoke<string>("export_session_markdown", { file, destination }),
  messageTimings: (file: string) => invoke<SessionMessageTiming[]>("session_message_timings_cmd", { file }),
  messages: (file: string) => invoke<AgentMessage[]>("session_messages_cmd", { file }),
  listArchived: () => invoke<SessionInfo[]>("list_archived_sessions_cmd"),
  archive: (file: string) => invoke<void>("archive_session_cmd", { file }),
  restore: (file: string) => invoke<void>("restore_session_cmd", { file }),
  delete: (file: string) => invoke<void>("delete_session_cmd", { file }),
};
