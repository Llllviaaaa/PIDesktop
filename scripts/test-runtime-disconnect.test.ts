import assert from "node:assert/strict";
import { agent } from "../src/lib/agent.ts";
import { useAppStore } from "../src/store/index.ts";
import { test } from "vitest";

test("runtime disconnect", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: () => undefined,
      setTimeout: () => 0,
    },
  });

  const runtimeId = "runtime-being-archived";
  const originalStop = agent.stop;

  useAppStore.setState({
    runtimeId,
    connection: "running",
    isStreaming: false,
    messages: [{ id: "message-1", timestamp: 0, role: "assistant", content: "done" }],
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

  agent.stop = async (stoppingRuntimeId: string) => {
    assert.equal(stoppingRuntimeId, runtimeId);
    useAppStore.getState().handleStatus({
      runtimeId,
      status: "exited",
      code: 1,
      cwd: "D:\\project",
    });
  };

  try {
    await useAppStore.getState().disconnect();
  } finally {
    agent.stop = originalStop;
  }

  assert.equal(useAppStore.getState().connection, "disconnected");
  assert.equal(useAppStore.getState().runtimeId, null);
  assert.equal(useAppStore.getState().messages.length, 0);
  assert.equal(useAppStore.getState().toasts.length, 0, "an intentional runtime stop must not show an exit error");

  const crashedRuntimeId = "runtime-that-crashed";
  useAppStore.setState({
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
  useAppStore.getState().handleStatus({
    runtimeId: crashedRuntimeId,
    status: "exited",
    code: 1,
    cwd: "D:\\project",
  });

  assert.equal(useAppStore.getState().connection, "exited");
  assert.match(useAppStore.getState().toasts[0]?.message ?? "", /Pi 已退出/);

  useAppStore.setState({ toasts: [] });
  let toastUpdates = 0;
  const unsubscribeToastUpdates = useAppStore.subscribe(() => {
    toastUpdates += 1;
  });
  useAppStore.getState().showToast("相同错误", "error");
  useAppStore.getState().showToast("相同错误", "error");
  assert.equal(useAppStore.getState().toasts.length, 1, "identical active toasts must be deduplicated");
  assert.equal(toastUpdates, 1, "a duplicate toast must not trigger another store update");
  useAppStore.getState().showToast("相同错误", "warning");
  assert.equal(useAppStore.getState().toasts.length, 2, "toast severity remains part of the deduplication key");
  unsubscribeToastUpdates();
});
