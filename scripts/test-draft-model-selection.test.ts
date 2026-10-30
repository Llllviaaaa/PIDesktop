import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { AppSettings, ModelInfo, RpcResponse } from "../src/types.ts";

// The store reads window at import time.
vi.hoisted(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      },
    },
  });
});

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));

const { pi } = await import("../src/lib/pi.ts");
const { harnessRuntimes } = await import("../src/lib/harnessRuntime.ts");
const { usePiStore } = await import("../src/store.ts");

const DEFAULT_MODEL: ModelInfo = { provider: "example", id: "default-model", name: "Default" };
const PICKED_MODEL: ModelInfo = { provider: "example", id: "picked-model", name: "Picked" };
const REMOVED_MODEL: ModelInfo = { provider: "example", id: "removed-model", name: "Removed" };
const PROJECT = "D:\\project";
const WORKTREE = "D:\\project-worktree";
const SAVED_SESSION = "D:\\sessions\\saved.jsonl";

interface FakeRuntime {
  id: string;
  cwd: string;
  model: ModelInfo;
  thinkingLevel: string;
  sessionFile: string;
  history: unknown[];
  /** A real Pi process accepts commands on stdin long before it can answer them. */
  booted: boolean;
  backlog: Array<() => void>;
  setModelRequests: string[];
  prompts: Array<{ message: string; model: string; thinkingLevel: string }>;
}

const runtimes: FakeRuntime[] = [];
let startGate: Promise<void> = Promise.resolve();
let bootOnStart = true;

function handle(runtime: FakeRuntime, request: Record<string, unknown>): { data?: unknown; error?: string } {
  switch (request.type) {
    case "get_state":
      return { data: {
        model: runtime.model,
        thinkingLevel: runtime.thinkingLevel,
        isStreaming: false,
        isCompacting: false,
        sessionFile: runtime.sessionFile,
        sessionId: runtime.id,
      } };
    case "get_available_models":
      return { data: { models: [DEFAULT_MODEL, PICKED_MODEL] } };
    case "get_available_thinking_levels":
      return { data: { levels: ["off", "medium", "high"] } };
    case "set_model": {
      runtime.setModelRequests.push(String(request.modelId));
      const model = [DEFAULT_MODEL, PICKED_MODEL]
        .find((item) => item.provider === request.provider && item.id === request.modelId);
      if (!model) return { error: `Model not found: ${String(request.provider)}/${String(request.modelId)}` };
      runtime.model = model;
      return { data: model };
    }
    case "set_thinking_level":
      runtime.thinkingLevel = String(request.level);
      return { data: {} };
    case "prompt":
      runtime.prompts.push({
        message: String(request.message),
        model: runtime.model.id,
        thinkingLevel: runtime.thinkingLevel,
      });
      return { data: {} };
    case "get_messages":
      return { data: { messages: runtime.history } };
    case "get_fork_messages":
      return { data: { messages: [] } };
    case "get_commands":
      return { data: { commands: [] } };
    default:
      return { data: {} };
  }
}

function boot(runtime: FakeRuntime) {
  runtime.booted = true;
  for (const reply of runtime.backlog.splice(0)) reply();
}

function gate() {
  let open = () => undefined as void;
  startGate = new Promise<void>((resolve) => { open = resolve; });
  return { open };
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), "condition was never reached");
}

const store = () => usePiStore.getState();
const defaults = (model: ModelInfo, thinkingLevel: string) =>
  ({ provider: model.provider, model: model.id, thinkingLevel }) as AppSettings;
const savedDefault = () => {
  const { provider, model, thinkingLevel } = store().settings ?? ({} as AppSettings);
  return { provider, model, thinkingLevel };
};
const runtimeIn = (cwd: string) => {
  const runtime = runtimes.filter((item) => item.cwd === cwd).pop();
  assert.ok(runtime, `no runtime was started in ${cwd}`);
  return runtime;
};

pi.start = async (cwd, sessionFile) => {
  await startGate;
  const saved = sessionFile === SAVED_SESSION;
  const runtime: FakeRuntime = {
    id: `runtime-${runtimes.length + 1}`,
    cwd,
    model: DEFAULT_MODEL,
    thinkingLevel: "medium",
    // Pi names a session file for a blank session too; it is only written on the first turn.
    sessionFile: sessionFile ?? `D:\\sessions\\blank-${runtimes.length + 1}.jsonl`,
    history: saved ? [{ role: "user", content: "earlier question", timestamp: 1 }] : [],
    booted: bootOnStart,
    backlog: [],
    setModelRequests: [],
    prompts: [],
  };
  runtimes.push(runtime);
  return { runtimeId: runtime.id, sessionLoaded: Boolean(sessionFile), sessionForked: false };
};
// Commands reach the runtime through the Host adapter; a runtime that has not booted yet answers once it has.
vi.spyOn(harnessRuntimes, "command").mockImplementation((runtimeId, command, payload = {}) => new Promise<RpcResponse>((resolve) => {
  const runtime = runtimes.find((item) => item.id === runtimeId);
  assert.ok(runtime, `command sent to unknown runtime ${runtimeId}`);
  const request: Record<string, unknown> = { ...payload, type: command };
  const reply = () => {
    const { data, error } = handle(runtime, request);
    resolve({ type: "response", command, success: !error, data, error } as RpcResponse);
  };
  if (runtime.booted) queueMicrotask(reply);
  else runtime.backlog.push(reply);
}));
pi.stop = async () => undefined;
pi.bindSession = async () => undefined;
pi.sessionHistory = async () => ({ messages: [], timings: [] }) as never;
pi.sessionMessageTimings = async () => [];
pi.listSessions = async () => [];
pi.gitSnapshot = async () => null as never;

beforeEach(async () => {
  await store().disconnect();
  store().prepareNewTask();
  usePiStore.setState({
    model: DEFAULT_MODEL,
    thinkingLevel: "medium",
    toasts: [],
    // The catalog the picker lists; the new-task default is only applied when it is in here.
    availableModels: [DEFAULT_MODEL, PICKED_MODEL],
    availableThinkingLevels: ["off", "medium", "high"],
    settings: defaults(DEFAULT_MODEL, "medium"),
  });
  runtimes.length = 0;
  startGate = Promise.resolve();
  bootOnStart = true;
});

test("a model picked before Pi has started is used by a prompt sent while Pi is still booting", async () => {
  bootOnStart = false;
  const start = gate();
  const connecting = store().connect(PROJECT);

  // The picker lists the cached catalog, so the choice can land before any runtime exists.
  await store().setModel(PICKED_MODEL);
  const shown: string[] = [];
  const unsubscribe = usePiStore.subscribe((state) => shown.push(state.model?.id ?? "none"));

  start.open();
  await until(() => store().runtimeId !== null);
  assert.equal(store().connection, "running", "the composer treats a spawned runtime as ready");

  const sending = store().sendMessage("hello");
  await new Promise<void>((resolve) => setImmediate(resolve));
  boot(runtimeIn(PROJECT));
  assert.equal(await sending, true);
  await connecting;
  unsubscribe();

  assert.deepEqual(runtimeIn(PROJECT).prompts.map((prompt) => prompt.model), [PICKED_MODEL.id]);
  assert.equal(store().model?.id, PICKED_MODEL.id);
  assert.ok(!shown.includes(DEFAULT_MODEL.id), "the composer must not fall back to the default model while Pi starts");
});

test("a model picked while a saved session is still opening is applied to it and kept for new tasks", async () => {
  const start = gate();
  const connecting = store().connect(PROJECT, SAVED_SESSION);
  await store().setModel(PICKED_MODEL);
  start.open();
  await connecting;

  assert.equal(runtimeIn(PROJECT).model.id, PICKED_MODEL.id);
  assert.equal(store().model?.id, PICKED_MODEL.id);
  assert.deepEqual(savedDefault(), { provider: PICKED_MODEL.provider, model: PICKED_MODEL.id, thinkingLevel: "medium" });

  store().prepareNewTask();
  await store().connect(WORKTREE);
  assert.equal(runtimeIn(WORKTREE).model.id, PICKED_MODEL.id, "a pick made in a saved session should carry into the next new task");
});

test("the model and thinking level picked on the new-task page follow the task to the runtime that runs it", async () => {
  await store().connect(PROJECT);
  await store().setModel(PICKED_MODEL);
  await store().setThinkingLevel("high");
  assert.equal(runtimeIn(PROJECT).model.id, PICKED_MODEL.id);

  // Sending from the new-task page can move the task: a worktree, quick chat, or another project.
  await store().connect(WORKTREE);
  assert.equal(store().model?.id, PICKED_MODEL.id);
  assert.equal(store().thinkingLevel, "high");

  assert.equal(await store().sendMessage("hello"), true);
  assert.deepEqual(runtimeIn(WORKTREE).prompts, [
    { message: "hello", model: PICKED_MODEL.id, thinkingLevel: "high" },
  ]);

  // The next new task starts from the last pick, even on a runtime that booted with the old default.
  assert.deepEqual(savedDefault(), { provider: PICKED_MODEL.provider, model: PICKED_MODEL.id, thinkingLevel: "high" });
  store().prepareNewTask();
  await store().connect(PROJECT);
  const next = runtimeIn(PROJECT);
  assert.equal(next.model.id, PICKED_MODEL.id);
  assert.equal(next.thinkingLevel, "high");
  assert.equal(store().model?.id, PICKED_MODEL.id);
  assert.equal(store().thinkingLevel, "high");
});

test("a new task applies the saved default to a runtime warmed with an older one; a saved session keeps its own", async () => {
  usePiStore.setState({ settings: defaults(PICKED_MODEL, "high") });

  await store().connect(PROJECT, SAVED_SESSION);
  assert.deepEqual(runtimeIn(PROJECT).setModelRequests, [], "opening a saved session must not switch its model");
  assert.equal(runtimeIn(PROJECT).thinkingLevel, "medium");

  store().prepareNewTask();
  await store().connect(WORKTREE);
  assert.deepEqual(runtimeIn(WORKTREE).setModelRequests, [PICKED_MODEL.id]);
  assert.equal(runtimeIn(WORKTREE).thinkingLevel, "high");
  assert.equal(await store().sendMessage("hello"), true);
  assert.deepEqual(runtimeIn(WORKTREE).prompts, [
    { message: "hello", model: PICKED_MODEL.id, thinkingLevel: "high" },
  ]);
});

test("a saved default the catalog does not list is not forced onto new tasks", async () => {
  usePiStore.setState({ settings: defaults(REMOVED_MODEL, "medium") });
  await store().connect(PROJECT);
  assert.deepEqual(runtimeIn(PROJECT).setModelRequests, []);
  assert.equal(store().toasts.length, 0, "a disconnected default must not raise an error on every new task");
});

test("a model picked while another task is still attached goes to the task being opened", async () => {
  await store().connect(PROJECT);
  const start = gate();
  const connecting = store().connect(WORKTREE);
  await store().setModel(PICKED_MODEL);
  start.open();
  await connecting;

  assert.deepEqual(runtimeIn(PROJECT).setModelRequests, [], "the task being left must keep its own model");
  assert.equal(runtimeIn(WORKTREE).model.id, PICKED_MODEL.id);
  assert.equal(store().isSwitchingModel, false);
});

test("a picked model that Pi rejects is reported once and not retried on the next runtime", async () => {
  const start = gate();
  const connecting = store().connect(PROJECT);
  await store().setModel(REMOVED_MODEL);
  start.open();
  await connecting;

  assert.equal(store().model?.id, DEFAULT_MODEL.id, "the composer shows the model Pi is really using");
  assert.match(store().toasts[0]?.message ?? "", /切换模型失败/);
  assert.equal(savedDefault().model, DEFAULT_MODEL.id, "a rejected pick must not become the default");

  await store().connect(WORKTREE);
  assert.deepEqual(runtimeIn(WORKTREE).setModelRequests, []);
  assert.equal(store().model?.id, DEFAULT_MODEL.id);
});
