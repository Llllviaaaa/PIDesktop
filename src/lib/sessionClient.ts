import { invoke } from "@tauri-apps/api/core";
import type { AgentMessage, SessionHistory, SessionInfo, SessionMessageTiming } from "../types";
import { HARNESS_SESSION_PREFIX, harnessRuntimes, isHarnessSessionFile } from "./harnessRuntime";
import { messageTimingsOf, sessionInfoFromHost, toAgentMessages } from "./harnessTranscript";

let sessionsRequest: Promise<SessionInfo[]> | null = null;

const hostId = (file: string) => file.slice(HARNESS_SESSION_PREFIX.length);

/**
 * The Harness Host's sessions, as sidebar entries. A host that cannot be
 * reached contributes none: Pi's sessions still list.
 */
async function hostSessions(archived: boolean): Promise<SessionInfo[]> {
  try {
    const sessions = await harnessRuntimes.listSessions();
    return sessions.filter((session) => session.archived === archived).map(sessionInfoFromHost);
  } catch {
    return [];
  }
}

// Files starting with `harness:` are Host sessions (docs/adr/0014-frontend-harness-adapter.md);
// everything else is a Pi session file read by the desktop.
export const sessionClient = {
  list(): Promise<SessionInfo[]> {
    if (!sessionsRequest) {
      sessionsRequest = Promise.all([invoke<SessionInfo[]>("list_sessions_cmd"), hostSessions(false)])
        .then(([pi, host]) => [...pi, ...host])
        .finally(() => { sessionsRequest = null; });
    }
    return sessionsRequest;
  },
  async history(file: string): Promise<SessionHistory> {
    if (!isHarnessSessionFile(file)) return invoke<SessionHistory>("session_history_cmd", { file });
    const events = await harnessRuntimes.readEvents(hostId(file));
    return { messages: toAgentMessages(events), timings: messageTimingsOf(events) };
  },
  async exportMarkdown(file: string, destination: string): Promise<string> {
    if (!isHarnessSessionFile(file)) return invoke<string>("export_session_markdown", { file, destination });
    return (await harnessRuntimes.call<{ path: string }>("session.export", { sessionId: hostId(file), destination })).path;
  },
  async messageTimings(file: string): Promise<SessionMessageTiming[]> {
    if (!isHarnessSessionFile(file)) return invoke<SessionMessageTiming[]>("session_message_timings_cmd", { file });
    return messageTimingsOf(await harnessRuntimes.readEvents(hostId(file)));
  },
  async messages(file: string): Promise<AgentMessage[]> {
    if (!isHarnessSessionFile(file)) return invoke<AgentMessage[]>("session_messages_cmd", { file });
    return toAgentMessages(await harnessRuntimes.readEvents(hostId(file)));
  },
  async listArchived(): Promise<SessionInfo[]> {
    const [pi, host] = await Promise.all([invoke<SessionInfo[]>("list_archived_sessions_cmd"), hostSessions(true)]);
    return [...pi, ...host];
  },
  async archive(file: string): Promise<void> {
    if (!isHarnessSessionFile(file)) return invoke<void>("archive_session_cmd", { file });
    await harnessRuntimes.call("session.archive", { sessionId: hostId(file), archived: true });
  },
  async restore(file: string): Promise<void> {
    if (!isHarnessSessionFile(file)) return invoke<void>("restore_session_cmd", { file });
    await harnessRuntimes.call("session.archive", { sessionId: hostId(file), archived: false });
  },
  async delete(file: string): Promise<void> {
    if (!isHarnessSessionFile(file)) return invoke<void>("delete_session_cmd", { file });
    await harnessRuntimes.call("session.delete", { sessionId: hostId(file) });
  },
};
