import assert from "node:assert/strict";
import { pi } from "../src/lib/pi.ts";
import { usePiStore } from "../src/store.ts";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    clearTimeout: () => undefined,
    setTimeout: () => 0,
  },
});

const runtimeId = "runtime-being-archived";
const originalStop = pi.stop;

usePiStore.setState({
  runtimeId,
  connection: "running",
  isStreaming: false,
  messages: [{ id: "message-1", role: "assistant", content: "done" }],
  runtimes: {
    [runtimeId]: {
      runtimeId,
      cwd: "D:\\project",
      sessionFile: "D:\\session.jsonl",
      isStreaming: false,
      status: "running",
      extensionRequest: null,
      updatedAt: Date.now(),
    },
  },
  toasts: [],
});

pi.stop = async (stoppingRuntimeId: string) => {
  assert.equal(stoppingRuntimeId, runtimeId);
  usePiStore.getState().handleStatus({
    runtimeId,
    status: "exited",
    code: 1,
    cwd: "D:\\project",
  });
};

try {
  await usePiStore.getState().disconnect();
} finally {
  pi.stop = originalStop;
}

assert.equal(usePiStore.getState().connection, "disconnected");
assert.equal(usePiStore.getState().runtimeId, null);
assert.equal(usePiStore.getState().messages.length, 0);
assert.equal(usePiStore.getState().toasts.length, 0, "an intentional runtime stop must not show an exit error");

const crashedRuntimeId = "runtime-that-crashed";
usePiStore.setState({
  runtimeId: crashedRuntimeId,
  connection: "running",
  runtimes: {
    [crashedRuntimeId]: {
      runtimeId: crashedRuntimeId,
      cwd: "D:\\project",
      sessionFile: "D:\\session.jsonl",
      isStreaming: false,
      status: "running",
      extensionRequest: null,
      updatedAt: Date.now(),
    },
  },
  toasts: [],
});
usePiStore.getState().handleStatus({
  runtimeId: crashedRuntimeId,
  status: "exited",
  code: 1,
  cwd: "D:\\project",
});

assert.equal(usePiStore.getState().connection, "exited");
assert.match(usePiStore.getState().toasts[0]?.message ?? "", /Pi 已退出/);

usePiStore.setState({ toasts: [] });
let toastUpdates = 0;
const unsubscribeToastUpdates = usePiStore.subscribe(() => {
  toastUpdates += 1;
});
usePiStore.getState().showToast("相同错误", "error");
usePiStore.getState().showToast("相同错误", "error");
assert.equal(usePiStore.getState().toasts.length, 1, "identical active toasts must be deduplicated");
assert.equal(toastUpdates, 1, "a duplicate toast must not trigger another store update");
usePiStore.getState().showToast("相同错误", "warning");
assert.equal(usePiStore.getState().toasts.length, 2, "toast severity remains part of the deduplication key");
unsubscribeToastUpdates();

console.log("runtime-disconnect: intentional stops are quiet and unexpected exits still alert");
