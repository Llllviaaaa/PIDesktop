/**
 * The Harness Host as a Pi runtime (docs/adr/0014-frontend-harness-adapter.md).
 *
 * `pi.start` returns a runtime id starting with `harness:`; commands sent
 * to it are answered here with Host RPCs, and the Host's notifications reach
 * the store as the Pi events it already handles. Pi itself is gone (P6c);
 * the store moves to the Host's own shapes in P6d.
 *
 * A runtime creates its session on its first prompt, so a workspace that is
 * only warmed up leaves no empty session behind. Its `sessionFile` is
 * `harness:<sessionId>`, which `pi.start` accepts to reopen it.
 */
import type {
  CheckpointDiffResult,
  CheckpointListResult,
  ModelListResult,
  PersistedEvent,
  ProviderListResult,
  SessionDeltaNotification,
  SessionEventNotification,
  SessionGetResult,
  SessionInfo as HostSessionInfo,
  SessionListResult,
  SessionResult,
  SessionSubscribeResult,
  UiRequestNotification,
} from "@pid/protocol";
import type { AgentMessage, ExtensionUIRequest, ForkPoint, ModelInfo, PiEvent, SessionStats } from "../types";
import type { SessionTreeNode } from "./sessionTree";
import { connectHarness, harnessEndpoint, type HarnessConnection } from "./harnessClient";
import { HARNESS_THINKING_LEVELS, HarnessEventTranslator, effortForLevel, forkPointsOf, sessionTreeOf, toAgentMessages } from "./harnessTranscript";


export const HARNESS_RUNTIME_PREFIX = "harness:";
export const HARNESS_SESSION_PREFIX = "harness:";

export function isHarnessRuntime(runtimeId: string): boolean {
  return runtimeId.startsWith(HARNESS_RUNTIME_PREFIX);
}

export function isHarnessSessionFile(sessionFile: string | null | undefined): boolean {
  return typeof sessionFile === "string" && sessionFile.startsWith(HARNESS_SESSION_PREFIX);
}

type Listener = (runtimeId: string, event: PiEvent) => void;
type Connect = () => Promise<HarnessConnection>;

interface Runtime {
  id: string;
  cwd: string;
  sessionId?: string;
  /** The model and level picked before the session exists, applied when it is created. */
  pendingModel?: { provider: string; model: string };
  pendingLevel?: string;
  lastSeq: number;
  translator: HarnessEventTranslator;
  model?: { provider: string; model: string };
  title?: string;
  streaming: boolean;
  /** A side chat's own fork, deleted when the runtime stops. */
  side?: boolean;
}

const MODEL_CATALOG_TTL_MS = 60_000;

export class HarnessRuntimes {
  private connection: Promise<HarnessConnection> | undefined;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly listeners = new Set<Listener>();
  private catalog: { at: number; models: Promise<ModelInfo[]> } | undefined;
  private nextRuntime = 0;
  private lastActive: string | undefined;
  /** Listeners for Host notifications outside sessions (schedule updates), by method. */
  private readonly notificationListeners = new Map<string, Set<(params: unknown) => void>>();
  /** Questions the adapter asks itself (rewinding files), answered through the same dialog. */
  private readonly localQuestions = new Map<string, (confirmed: boolean) => void>();

  constructor(private readonly connect: Connect = async () => connectHarness(await harnessEndpoint(), { name: "pi-desktop", version: "1" })) {}

  /**
   * Hear a Host notification such as `schedule/run`. This connects at once,
   * so updates arrive before anything is asked.
   */
  onNotification(method: string, listener: (params: unknown) => void): () => void {
    let listeners = this.notificationListeners.get(method);
    if (listeners === undefined) {
      listeners = new Set();
      this.notificationListeners.set(method, listeners);
    }
    listeners.add(listener);
    void this.rpc().catch(() => undefined);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.notificationListeners.delete(method);
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * A runtime on `sessionFile`, or on a new session. With `side` it runs on a
   * hidden fork of `sessionFile` instead, as Pi's isolated side chats do; the
   * fork goes when the runtime stops.
   */
  async start(cwd: string, sessionFile?: string, side = false): Promise<{ runtimeId: string; sessionLoaded: boolean; sessionForked: boolean }> {
    this.nextRuntime += 1;
    const id = `${HARNESS_RUNTIME_PREFIX}${Date.now().toString(36)}-${this.nextRuntime}`;
    const runtime: Runtime = { id, cwd, lastSeq: 0, streaming: false, translator: new HarnessEventTranslator(() => runtime.model) };
    if (isHarnessSessionFile(sessionFile)) {
      runtime.sessionId = (sessionFile as string).slice(HARNESS_SESSION_PREFIX.length);
      if (side) {
        const forked = await (await this.rpc()).call<SessionResult>("session.fork", { sessionId: runtime.sessionId, side: true });
        runtime.sessionId = forked.session.id;
        runtime.side = true;
      }
    }
    this.runtimes.set(id, runtime);
    if (runtime.sessionId !== undefined) await this.attach(runtime);
    return { runtimeId: id, sessionLoaded: true, sessionForked: runtime.side === true };
  }

  async stop(runtimeId: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeId);
    this.runtimes.delete(runtimeId);
    if (runtime?.sessionId === undefined || this.connection === undefined) return;
    const stillWatched = [...this.runtimes.values()].some((other) => other.sessionId === runtime.sessionId);
    if (stillWatched) return;
    const rpc = await this.connection;
    await rpc.call("session.unsubscribe", { sessionId: runtime.sessionId }).catch(() => undefined);
    if (runtime.side === true) {
      await rpc.call("session.abort", { sessionId: runtime.sessionId }).catch(() => undefined);
      await rpc.call("session.delete", { sessionId: runtime.sessionId }).catch(() => undefined);
    }
  }

  isRunning(runtimeId: string): boolean {
    return this.runtimes.has(runtimeId);
  }

  /** Answer a confirm, select or input the Host asked through `ui/request`. */
  async respond(request: ExtensionUIRequest, response: { value?: string; confirmed?: boolean; cancelled?: true }): Promise<void> {
    const local = this.localQuestions.get(request.id);
    if (local !== undefined) {
      this.localQuestions.delete(request.id);
      local(response.confirmed === true);
      return;
    }
    const value = response.cancelled ? null : response.confirmed ?? response.value ?? null;
    await (await this.rpc()).call("ui.respond", { requestId: request.id, value });
  }

  /** One Host RPC, for the session list and other calls outside a runtime. */
  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return (await this.rpc()).call<T>(method, params);
  }

  /** The Host's sessions, newest first. Subagent sessions belong to their parent's tool call and side chats to their panel, so both are left out. */
  async listSessions(): Promise<HostSessionInfo[]> {
    const { sessions } = await this.call<SessionListResult>("session.list");
    return sessions.filter((session) => session.parent === undefined && session.side !== true);
  }

  /** A session's whole log, without leaving a subscription behind unless a runtime watches it. */
  async readEvents(sessionId: string): Promise<PersistedEvent[]> {
    const { events } = await this.call<SessionSubscribeResult>("session.subscribe", { sessionId, afterSeq: 0 });
    if (this.runtimesOf(sessionId).length === 0) await this.call("session.unsubscribe", { sessionId }).catch(() => undefined);
    return events;
  }

  private runtime(runtimeId: string): Runtime {
    const runtime = this.runtimes.get(runtimeId);
    if (runtime === undefined) throw new Error("Harness 任务已结束");
    this.lastActive = runtimeId;
    return runtime;
  }

  /** Send a prompt, creating the session on the first one. */
  async prompt(runtimeId: string, input: PromptInput): Promise<void> {
    const runtime = this.runtime(runtimeId);
    await this.ensureSession(runtime);
    await (await this.rpc()).call("session.prompt", { sessionId: runtime.sessionId, content: promptContent(input) });
  }

  /** Redirect the running turn (`steer`) or queue a message after it (`followUp`). */
  async queue(runtimeId: string, behavior: "steer" | "followUp", input: PromptInput): Promise<void> {
    const runtime = this.runtime(runtimeId);
    await this.ensureSession(runtime);
    await (await this.rpc()).call(behavior === "steer" ? "session.steer" : "session.followUp", { sessionId: runtime.sessionId, content: promptContent(input) });
  }

  async abort(runtimeId: string): Promise<void> {
    const runtime = this.runtime(runtimeId);
    if (runtime.sessionId !== undefined) await (await this.rpc()).call("session.abort", { sessionId: runtime.sessionId });
  }

  /** The permission mode or agent mode of the runtime's session. */
  async setPermission(runtimeId: string, change: { permission?: string; agentMode?: string }): Promise<void> {
    const runtime = this.runtime(runtimeId);
    await this.ensureSession(runtime);
    await (await this.rpc()).call("permission.set", { sessionId: runtime.sessionId, ...change });
  }

  async messages(runtimeId: string): Promise<AgentMessage[]> {
    const runtime = this.runtime(runtimeId);
    if (runtime.sessionId === undefined) return [];
    const replay = await (await this.rpc()).call<SessionSubscribeResult>("session.subscribe", { sessionId: runtime.sessionId, afterSeq: 0 });
    return toAgentMessages(replay.events);
  }

  thinkingLevels(): string[] {
    return HARNESS_THINKING_LEVELS;
  }

  async forkPoints(runtimeId: string): Promise<ForkPoint[]> {
    const runtime = this.runtime(runtimeId);
    return runtime.sessionId === undefined ? [] : forkPointsOf(await this.readEvents(runtime.sessionId));
  }

  async tree(runtimeId: string): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
    const runtime = this.runtime(runtimeId);
    if (runtime.sessionId === undefined) return { tree: [], leafId: null };
    return sessionTreeOf(await this.readEvents(runtime.sessionId));
  }

  /**
   * Continue in a new session forked at `entryId`. From a user message the
   * fork stops before it; from a reply it keeps the reply.
   */
  async fork(runtimeId: string, entryId: string): Promise<void> {
    const runtime = this.runtime(runtimeId);
    if (runtime.sessionId === undefined) throw new Error("任务尚未开始");
    const seq = Number(entryId);
    const entry = (await this.readEvents(runtime.sessionId)).find((event) => event.seq === seq);
    if (entry === undefined) throw new Error("找不到要分叉的消息");
    const rpc = await this.rpc();
    await this.switchTo(runtime, await rpc.call<SessionResult>("session.fork", { sessionId: runtime.sessionId, seq: entry.type === "user" ? seq - 1 : seq }));
  }

  /** Continue in a full copy of the session. */
  async clone(runtimeId: string): Promise<void> {
    const runtime = this.runtime(runtimeId);
    if (runtime.sessionId === undefined) throw new Error("任务尚未开始");
    await this.switchTo(runtime, await (await this.rpc()).call<SessionResult>("session.fork", { sessionId: runtime.sessionId }));
  }

  /** Start over: the next prompt creates a new session. */
  newSession(runtimeId: string): void {
    const runtime = this.runtime(runtimeId);
    runtime.sessionId = undefined;
    runtime.lastSeq = 0;
    runtime.title = undefined;
  }

  async setModel(runtimeId: string, provider: string, modelId: string): Promise<ModelInfo> {
    const runtime = this.runtime(runtimeId);
    const model = { provider, model: modelId };
    if (runtime.sessionId === undefined) runtime.pendingModel = model;
    else await (await this.rpc()).call("model.set", { sessionId: runtime.sessionId, ...model });
    runtime.model = model;
    return this.modelInfo(model);
  }

  async setThinkingLevel(runtimeId: string, level: string): Promise<void> {
    const runtime = this.runtime(runtimeId);
    if (runtime.sessionId === undefined) runtime.pendingLevel = level;
    else await (await this.rpc()).call("model.setEffort", { sessionId: runtime.sessionId, effort: effortForLevel(level) });
  }

  async rename(runtimeId: string, name: string): Promise<void> {
    const runtime = this.runtime(runtimeId);
    await this.ensureSession(runtime);
    await (await this.rpc()).call("session.rename", { sessionId: runtime.sessionId, title: name });
    runtime.title = name;
  }

  async compact(runtimeId: string): Promise<void> {
    const runtime = this.runtime(runtimeId);
    if (runtime.sessionId !== undefined) await (await this.rpc()).call("session.compact", { sessionId: runtime.sessionId });
  }

  /** Point the runtime at another session (a fork or clone), as Pi's runtime switches to it. */
  private async switchTo(runtime: Runtime, created: SessionResult): Promise<void> {
    const previous = runtime.sessionId;
    runtime.sessionId = created.session.id;
    runtime.lastSeq = 0;
    runtime.title = created.session.title;
    await this.attach(runtime);
    if (previous !== undefined && this.runtimesOf(previous).length === 0) await this.call("session.unsubscribe", { sessionId: previous }).catch(() => undefined);
  }

  /**
   * Rewind to before the user message at `entryId` (its seq): when the files
   * changed since its checkpoint, ask before restoring them, then continue the
   * session from just before the message. False when the user declines.
   */
  async rewind(runtimeId: string, entryId: string): Promise<boolean> {
    const runtime = this.runtime(runtimeId);
    if (runtime.sessionId === undefined) throw new Error("任务尚未开始");
    const userSeq = Number(entryId);
    const rpc = await this.rpc();
    const sessionId = runtime.sessionId;
    const { checkpoints } = await rpc.call<CheckpointListResult>("checkpoint.list", { sessionId });
    if (checkpoints.some((checkpoint) => checkpoint.userSeq === userSeq)) {
      const diff = await rpc.call<CheckpointDiffResult>("checkpoint.diff", { sessionId, userSeq });
      if (diff.changed) {
        const fileSummary = diff.files.length > 0 ? `${diff.files.length} 个文件将恢复到此消息发送前的状态。` : "Git 暂存区将恢复到此消息发送前的状态。";
        const confirmed = await this.askLocally(runtime.id, "回退消息和工作区？", `${fileSummary}\n\n此操作不会删除已有对话分支，你之后仍可从会话树切回。`);
        if (!confirmed) return false;
        await rpc.call("checkpoint.restore", { sessionId, userSeq });
      }
    }
    await rpc.call("session.rewind", { sessionId, toSeq: userSeq - 1, reason: "rewind to before a message" });
    return true;
  }

  private askLocally(runtimeId: string, title: string, message: string): Promise<boolean> {
    const id = `harness-local-${Date.now().toString(36)}-${this.localQuestions.size}`;
    return new Promise((resolve) => {
      this.localQuestions.set(id, resolve);
      this.emit(runtimeId, [{ type: "extension_ui_request", id, method: "confirm", title, message }]);
    });
  }

  /** The runtime's session, model, effort and whether it is running. */
  async state(runtimeId: string): Promise<RuntimeStateInfo> {
    const runtime = this.runtime(runtimeId);
    if (runtime.sessionId === undefined) {
      const model = runtime.model ?? runtime.pendingModel;
      return {
        isStreaming: false,
        isCompacting: false,
        ...(runtime.pendingLevel === undefined ? {} : { thinkingLevel: runtime.pendingLevel }),
        ...(model === undefined ? {} : { model: await this.modelInfo(model) }),
      };
    }
    const got = await (await this.rpc()).call<SessionGetResult>("session.get", { sessionId: runtime.sessionId });
    if (got.model !== undefined) runtime.model = got.model;
    runtime.streaming = got.status.running;
    return {
      sessionFile: `${HARNESS_SESSION_PREFIX}${got.session.id}`,
      sessionId: got.session.id,
      ...(got.session.title === undefined ? {} : { sessionName: got.session.title }),
      isStreaming: got.status.running,
      isCompacting: false,
      ...(got.effort === undefined ? {} : { thinkingLevel: got.effort }),
      ...(got.model === undefined ? {} : { model: await this.modelInfo(got.model) }),
    };
  }

  /** Token totals of the runtime's session. The Host does not count messages by role or compute costs. */
  async stats(runtimeId: string): Promise<SessionStats> {
    const runtime = this.runtime(runtimeId);
    if (runtime.sessionId === undefined) throw new Error("任务尚未开始");
    const got = await (await this.rpc()).call<SessionGetResult>("session.get", { sessionId: runtime.sessionId });
    const usage = got.session.usage;
    return {
      sessionFile: `${HARNESS_SESSION_PREFIX}${got.session.id}`,
      sessionId: got.session.id,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: got.session.messageCount,
      tokens: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
        total: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      },
      cost: 0,
    };
  }

  /** Every model the Host's providers offer; a provider that cannot be reached is skipped. */
  models(): Promise<ModelInfo[]> {
    if (this.catalog !== undefined && Date.now() - this.catalog.at < MODEL_CATALOG_TTL_MS) return this.catalog.models;
    const models = (async () => {
      const rpc = await this.rpc();
      const { providers } = await rpc.call<ProviderListResult>("provider.list");
      const lists = await Promise.all(providers.map(async (provider) => {
        try {
          const { models: found } = await rpc.call<ModelListResult>("model.list", { provider: provider.id });
          return found.map((model): ModelInfo => ({
            id: model.id,
            name: model.name ?? model.id,
            provider: provider.id,
            api: provider.api,
            ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
            ...(model.input === undefined ? {} : { input: model.input }),
            ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
            ...(model.maxOutputTokens === undefined ? {} : { maxTokens: model.maxOutputTokens }),
          }));
        } catch {
          return [];
        }
      }));
      return lists.flat();
    })();
    this.catalog = { at: Date.now(), models };
    models.catch(() => {
      if (this.catalog?.models === models) this.catalog = undefined;
    });
    return models;
  }

  private async modelInfo(model: { provider: string; model: string }): Promise<ModelInfo> {
    const known = (await this.models().catch(() => [] as ModelInfo[])).find((item) => item.provider === model.provider && item.id === model.model);
    return known ?? { id: model.model, name: model.model, provider: model.provider };
  }

  private async ensureSession(runtime: Runtime): Promise<void> {
    if (runtime.sessionId !== undefined) return;
    const rpc = await this.rpc();
    const model = runtime.pendingModel ?? runtime.model;
    const created = await rpc.call<SessionResult>("session.create", {
      cwd: runtime.cwd,
      ...(model === undefined ? {} : { model }),
      ...(runtime.pendingLevel === undefined ? {} : { effort: effortForLevel(runtime.pendingLevel) }),
    });
    runtime.sessionId = created.session.id;
    runtime.pendingModel = undefined;
    runtime.pendingLevel = undefined;
    await this.attach(runtime);
  }

  /** Subscribe to the runtime's session, starting live from what the log already holds. */
  private async attach(runtime: Runtime): Promise<void> {
    const rpc = await this.rpc();
    const replay = await rpc.call<SessionSubscribeResult>("session.subscribe", { sessionId: runtime.sessionId, afterSeq: runtime.lastSeq });
    runtime.lastSeq = Math.max(runtime.lastSeq, replay.events.at(-1)?.seq ?? 0);
    runtime.streaming = replay.status.running;
  }

  private rpc(): Promise<HarnessConnection> {
    if (this.connection === undefined) {
      const connecting = this.connect().then((connection) => {
        connection.onNotification((method, params) => this.notify(method, params));
        return connection;
      });
      this.connection = connecting;
      connecting.catch(() => {
        if (this.connection === connecting) this.connection = undefined;
      });
    }
    return this.connection;
  }

  private emit(runtimeId: string, events: PiEvent[]): void {
    for (const event of events) for (const listener of this.listeners) listener(runtimeId, event);
  }

  private runtimesOf(sessionId: string | undefined): Runtime[] {
    return [...this.runtimes.values()].filter((runtime) => runtime.sessionId !== undefined && runtime.sessionId === sessionId);
  }

  private notify(method: string, params: unknown): void {
    for (const listener of this.notificationListeners.get(method) ?? []) listener(params);
    if (method === "session/event") {
      const { sessionId, event } = params as SessionEventNotification;
      for (const runtime of this.runtimesOf(sessionId)) {
        if (event.seq <= runtime.lastSeq) continue;
        runtime.lastSeq = event.seq;
        if (event.type === "model") runtime.model = event.data as { provider: string; model: string };
        this.emit(runtime.id, runtime.translator.event(event as PersistedEvent));
      }
    } else if (method === "session/delta") {
      const { sessionId, delta } = params as SessionDeltaNotification;
      for (const runtime of this.runtimesOf(sessionId)) {
        if (delta.type === "agent-start") runtime.streaming = true;
        if (delta.type === "agent-end") runtime.streaming = false;
        this.emit(runtime.id, runtime.translator.delta(delta));
      }
    } else if (method === "ui/request") {
      const request = params as UiRequestNotification;
      const event = uiRequestEvent(request);
      if (event === undefined) return;
      // A subagent's session has no runtime here: its question goes to the task in front.
      const targets = this.runtimesOf(request.sessionId);
      const fallback = this.lastActive !== undefined && this.runtimes.has(this.lastActive) ? [this.lastActive] : [];
      for (const runtimeId of targets.length > 0 ? targets.map((runtime) => runtime.id) : fallback) this.emit(runtimeId, [event]);
    }
  }
}

/** A prompt as the composer builds it: its text and attached images. */
export interface PromptInput {
  message: string;
  images: Array<{ type?: "image"; data: string; mimeType: string }>;
}

/** What `state` reports about a runtime. */
export interface RuntimeStateInfo {
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  thinkingLevel?: string;
  model?: ModelInfo;
}

/** A prompt as Host prompt content. */
export function promptContent(input: PromptInput): Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> {
  const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [];
  if (input.message !== "") content.push({ type: "text", text: input.message });
  for (const image of input.images) content.push({ type: "image", mimeType: image.mimeType, data: image.data });
  return content;
}

/** A Host `ui/request` as Pi's extension UI request. */
export function uiRequestEvent(request: UiRequestNotification): ExtensionUIRequest | undefined {
  const id = request.requestId ?? `harness-notify-${Date.now()}`;
  switch (request.kind) {
    case "confirm":
      return { type: "extension_ui_request", id, method: "confirm", title: request.title, message: request.message };
    case "select":
      return { type: "extension_ui_request", id, method: "select", title: request.title, options: request.options };
    case "input":
      return { type: "extension_ui_request", id, method: "input", title: request.title, ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }) };
    case "notify":
      return { type: "extension_ui_request", id, method: "notify", message: request.message, notifyType: request.level };
    default:
      return undefined;
  }
}

/** The app's one adapter. */
export const harnessRuntimes = new HarnessRuntimes();
