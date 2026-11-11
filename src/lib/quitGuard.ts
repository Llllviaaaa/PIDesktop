import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { harnessRuntimes } from "./harnessRuntime";
import { useAppStore } from "../store";

export interface StreamingGuardSnapshot {
  runtimeId: string | null;
  isStreaming: boolean;
  isCompacting: boolean;
  runtimes: Record<string, { isStreaming: boolean; isCompacting?: boolean }>;
}

/**
 * Count how many tasks are currently streaming or compacting across both the
 * Zustand store snapshots and live Harness Host runtimes.
 */
export function countActiveStreamingTasks(
  state: StreamingGuardSnapshot,
  adapterStreaming: number | readonly string[] = 0,
): number {
  const activeIds = new Set<string>();
  if (state.isStreaming || state.isCompacting) {
    activeIds.add(state.runtimeId ?? "__foreground__");
  }
  for (const [id, snapshot] of Object.entries(state.runtimes)) {
    if (snapshot.isStreaming || snapshot.isCompacting === true) {
      activeIds.add(id);
    }
  }
  if (typeof adapterStreaming === "number") {
    return Math.max(activeIds.size, Math.max(0, adapterStreaming));
  }
  for (const id of adapterStreaming) {
    activeIds.add(id);
  }
  return activeIds.size;
}

export function hasActiveStreamingTasks(
  state: StreamingGuardSnapshot,
  adapterStreaming: number | readonly string[] = 0,
): boolean {
  return countActiveStreamingTasks(state, adapterStreaming) > 0;
}

export interface QuitGuardDeps {
  getActiveCount?: () => number;
  confirmFn?: (message: string) => Promise<boolean>;
  invokeQuit?: (confirmed: boolean) => Promise<void>;
}

let quitConfirmInFlight = false;

/**
 * Request application exit with confirmation protection when any session is
 * actively streaming or compacting.
 */
export async function requestAppQuit(deps: QuitGuardDeps = {}): Promise<boolean> {
  if (quitConfirmInFlight) {
    return false;
  }

  const getActiveCount =
    deps.getActiveCount ??
    (() => countActiveStreamingTasks(useAppStore.getState(), harnessRuntimes.streamingRuntimeIds()));
  const confirmFn =
    deps.confirmFn ??
    ((message: string) =>
      confirm(message, {
        title: "退出千机",
        kind: "warning",
        okLabel: "仍要退出",
        cancelLabel: "继续运行",
      }));
  const invokeQuit =
    deps.invokeQuit ??
    ((confirmed: boolean) => invoke("quit_app", { confirmed }).then(() => undefined));

  const activeCount = getActiveCount();
  if (activeCount > 0) {
    quitConfirmInFlight = true;
    try {
      const taskLabel = activeCount > 1 ? `${activeCount} 个会话` : "当前会话";
      const ok = await confirmFn(
        `${taskLabel}正在流式运行中，现在退出将中断正在执行的回复或工具调用。确定仍要退出千机吗？`,
      );
      if (!ok) {
        return false;
      }
    } finally {
      quitConfirmInFlight = false;
    }
  }

  await invokeQuit(true);
  return true;
}
