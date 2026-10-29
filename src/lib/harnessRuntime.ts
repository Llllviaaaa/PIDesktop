/**
 * The Harness Host as a Pi runtime (docs/adr/0014-frontend-harness-adapter.md).
 *
 * With `engine: "harness"`, `pi.start` returns a runtime id starting with
 * `harness:`; commands sent to such a runtime are answered here with Host
 * RPCs, and the Host's notifications reach the store as the Pi events it
 * already handles. The store and the transcript do not change, and the Pi
 * path is untouched.
 *
 * A runtime creates its session on its first prompt, so a workspace that is
 * only warmed up leaves no empty session behind. Its `sessionFile` is
 * `harness:<sessionId>`, which `pi.start` accepts to reopen it.
 */
import type {
  ModelListResult,
  PersistedEvent,
  ProviderListResult,
  SessionDeltaNotification,
  SessionEventNotification,
  SessionGetResult,
  SessionResult,
  SessionSubscribeResult,
  UiRequestNotification,
} from "@pid/protocol";
import type { ExtensionUIRequest, ModelInfo, PiEvent, RpcData, RpcResponse } from "../types";
import { connectHarness, harnessEndpoint, type HarnessConnection } from "./harnessClient";
import { HARNESS_THINKING_LEVELS, HarnessEventTranslator, effortForLevel, toAgentMessages } from "./harnessTranscript";

export type RuntimeEngine = "pi" | "harness";

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
}

const MODEL_CATALOG_TTL_MS = 60_000;

export class HarnessRuntimes {
  private engine: RuntimeEngine = "pi";
  private connection: Promise<HarnessConnection> | undefined;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly listeners = new Set<Listener>();
  private catalog: { at: number; models: Promise<ModelInfo[]> } | undefined;
  private nextRuntime = 0;
  private lastActive: string | undefined;

  constructor(private readonly connect: Connect = async () => connectHarness(await harnessEndpoint(), { name: "pi-desktop", version: "1" })) {}

  setEngine(engine: RuntimeEngine | undefined): void {
    this.engine = engine === "harness" ? "harness" : "pi";
  }

  getEngine(): RuntimeEngine {
    return this.engine;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(cwd: string, sessionFile?: string): Promise<{ runtimeId: string; sessionLoaded: boolean; sessionForked: boolean }> {
    this.nextRuntime += 1;
    const id = `${HARNESS_RUNTIME_PREFIX}${Date.now().toString(36)}-${this.nextRuntime}`;
    const runtime: Runtime = { id, cwd, lastSeq: 0, streaming: false, translator: new HarnessEventTranslator(() => runtime.model) };
    this.runtimes.set(id, runtime);
    if (isHarnessSessionFile(sessionFile)) {
      runtime.sessionId = (sessionFile as string).slice(HARNESS_SESSION_PREFIX.length);
      await this.attach(runtime);
    }
    return { runtimeId: id, sessionLoaded: true, sessionForked: false };
  }

  async stop(runtimeId: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeId);
    this.runtimes.delete(runtimeId);
    if (runtime?.sessionId === undefined || this.connection === undefined) return;
    const stillWatched = [...this.runtimes.values()].some((other) => other.sessionId === runtime.sessionId);
    if (!stillWatched) await (await this.connection).call("session.unsubscribe", { sessionId: runtime.sessionId }).catch(() => undefined);
  }

  isRunning(runtimeId: string): boolean {
    return this.runtimes.has(runtimeId);
  }

  /** Answer a confirm, select or input the Host asked through `ui/request`. */
  async respond(request: ExtensionUIRequest, response: { value?: string; confirmed?: boolean; cancelled?: true }): Promise<void> {
    const value = response.cancelled ? null : response.confirmed ?? response.value ?? null;
    await (await this.rpc()).call("ui.respond", { requestId: request.id, value });
  }

  /** Answer one Pi RPC command the store sends. Unknown commands fail like Pi's would. */
  async command(runtimeId: string, command: string, payload: Record<string, unknown> = {}): Promise<RpcResponse> {
    const runtime = this.runtimes.get(runtimeId);
    if (runtime === undefined) return failure(command, "Harness 任务已结束");
    this.lastActive = runtimeId;
    try {
      const data = await this.run(runtime, command, payload);
      return { type: "response", command, success: true, ...(data === undefined ? {} : { data }) };
    } catch (error) {
      return failure(command, error instanceof Error ? error.message : String(error));
    }
  }

  private async run(runtime: Runtime, command: string, payload: Record<string, unknown>): Promise<RpcData | undefined> {
    const rpc = await this.rpc();
    switch (command) {
      case "prompt": {
        const message = typeof payload.message === "string" ? payload.message : "";
        const slash = /^\/(pidesktop-mode|pidesktop-permission)\s+(\S+)/.exec(message);
        if (slash !== null) {
          await this.ensureSession(runtime);
          await rpc.call("permission.set", { sessionId: runtime.sessionId, ...(slash[1] === "pidesktop-mode" ? { agentMode: slash[2] } : { permission: slash[2] }) });
          return undefined;
        }
        // Pi's internal slash commands (the provider service) have no Host counterpart.
        if (message.startsWith("/pidesktop-")) return undefined;
        await this.ensureSession(runtime);
        await rpc.call("session.prompt", { sessionId: runtime.sessionId, content: promptContent(payload) });
        return undefined;
      }
      case "steer":
      case "follow_up":
        await this.ensureSession(runtime);
        await rpc.call(command === "steer" ? "session.steer" : "session.followUp", { sessionId: runtime.sessionId, content: promptContent(payload) });
        return undefined;
      case "abort":
        if (runtime.sessionId !== undefined) await rpc.call("session.abort", { sessionId: runtime.sessionId });
        return undefined;
      case "get_state":
        return this.state(runtime);
      case "get_messages": {
        if (runtime.sessionId === undefined) return { messages: [] };
        const replay = await rpc.call<SessionSubscribeResult>("session.subscribe", { sessionId: runtime.sessionId, afterSeq: 0 });
        return { messages: toAgentMessages(replay.events) };
      }
      case "get_available_models":
        return { models: await this.models() };
      case "get_available_thinking_levels":
        return { levels: HARNESS_THINKING_LEVELS };
      case "get_commands":
        return { commands: [] };
      case "get_fork_messages":
        return { messages: [] };
      case "set_model": {
        const model = { provider: String(payload.provider ?? ""), model: String(payload.modelId ?? "") };
        if (runtime.sessionId === undefined) runtime.pendingModel = model;
        else await rpc.call("model.set", { sessionId: runtime.sessionId, ...model });
        runtime.model = model;
        return this.modelInfo(model) as unknown as RpcData;
      }
      case "set_thinking_level": {
        const level = String(payload.level ?? "medium");
        if (runtime.sessionId === undefined) runtime.pendingLevel = level;
        else await rpc.call("model.setEffort", { sessionId: runtime.sessionId, effort: effortForLevel(level) });
        return undefined;
      }
      case "set_session_name":
        await this.ensureSession(runtime);
        await rpc.call("session.rename", { sessionId: runtime.sessionId, title: String(payload.name ?? "") });
        runtime.title = String(payload.name ?? "");
        return undefined;
      case "compact":
        if (runtime.sessionId !== undefined) await rpc.call("session.compact", { sessionId: runtime.sessionId });
        return undefined;
      case "get_session_stats":
        return this.stats(runtime);
      default:
        throw new Error(`Harness 引擎暂不支持 ${command}`);
    }
  }

  private async state(runtime: Runtime): Promise<RpcData> {
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

  private async stats(runtime: Runtime): Promise<RpcData> {
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
  private models(): Promise<ModelInfo[]> {
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

function failure(command: string, error: string): RpcResponse {
  return { type: "response", command, success: false, error };
}

/** Pi's prompt payload (`message`, `images`) as Host prompt content. */
export function promptContent(payload: Record<string, unknown>): Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> {
  const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [];
  if (typeof payload.message === "string" && payload.message !== "") content.push({ type: "text", text: payload.message });
  for (const image of Array.isArray(payload.images) ? payload.images : []) {
    const item = image as { data?: unknown; mimeType?: unknown };
    if (typeof item.data === "string" && typeof item.mimeType === "string") content.push({ type: "image", mimeType: item.mimeType, data: item.data });
  }
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
