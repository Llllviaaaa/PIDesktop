import type { AgentMessage, SessionHistory, SessionInfo, SessionMessageTiming } from "../types";
import { HARNESS_SESSION_PREFIX, harnessRuntimes } from "./harnessRuntime";
import { messageTimingsOf, sessionInfoFromHost, toAgentMessages } from "./harnessTranscript";

let sessionsRequest: Promise<SessionInfo[]> | null = null;

const hostId = (file: string) => file.slice(HARNESS_SESSION_PREFIX.length);

/** The Harness Host's sessions, as sidebar entries; none while the host cannot be reached. */
async function hostSessions(archived: boolean): Promise<SessionInfo[]> {
  try {
    const sessions = await harnessRuntimes.listSessions();
    return sessions.filter((session) => session.archived === archived).map(sessionInfoFromHost);
  } catch {
    return [];
  }
}

// A session's file is `harness:<id>` (docs/adr/0014-frontend-harness-adapter.md). Pi's own
// session files are no longer read; they are imported into the Host once (docs/adr/0015).
export const sessionClient = {
  list(): Promise<SessionInfo[]> {
    if (!sessionsRequest) {
      sessionsRequest = hostSessions(false).finally(() => { sessionsRequest = null; });
    }
    return sessionsRequest;
  },
  async history(file: string): Promise<SessionHistory> {
    const events = await harnessRuntimes.readEvents(hostId(file));
    return { messages: toAgentMessages(events), timings: messageTimingsOf(events) };
  },
  async exportMarkdown(file: string, destination: string): Promise<string> {
    return (await harnessRuntimes.call<{ path: string }>("session.export", { sessionId: hostId(file), destination })).path;
  },
  async messageTimings(file: string): Promise<SessionMessageTiming[]> {
    return messageTimingsOf(await harnessRuntimes.readEvents(hostId(file)));
  },
  async messages(file: string): Promise<AgentMessage[]> {
    return toAgentMessages(await harnessRuntimes.readEvents(hostId(file)));
  },
  listArchived: (): Promise<SessionInfo[]> => hostSessions(true),
  async archive(file: string): Promise<void> {
    await harnessRuntimes.call("session.archive", { sessionId: hostId(file), archived: true });
  },
  async restore(file: string): Promise<void> {
    await harnessRuntimes.call("session.archive", { sessionId: hostId(file), archived: false });
  },
  async delete(file: string): Promise<void> {
    await harnessRuntimes.call("session.delete", { sessionId: hostId(file) });
  },
};
