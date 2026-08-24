import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { subscribeToPi } from "../lib/pi";
import { sameLocalPath } from "../lib/pathIdentity";
import { usePiStore } from "../store";
import type { ConnectionState, SessionInfo } from "../types";

export const ACTIVE_RUNTIME_KEY = "pid-desktop:active-runtime";
export const LAST_TASK_KEY = "pid-desktop:last-task";

interface PersistedTask {
  cwd: string;
  sessionFile: string;
}

export function readPersistedTask(): PersistedTask | null {
  try {
    const raw = window.localStorage.getItem(LAST_TASK_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersistedTask>;
    return typeof value.cwd === "string" && typeof value.sessionFile === "string"
      ? { cwd: value.cwd, sessionFile: value.sessionFile }
      : null;
  } catch {
    return null;
  }
}

interface RuntimeBootstrapOptions {
  isTauri: boolean;
  connection: ConnectionState;
  sessions: SessionInfo[];
  autoConnect: boolean;
  runtimeId: string | null;
  cwd: string;
  sessionFile: string | null;
  draftMode: boolean;
  onDraftModeChange: (draft: boolean) => void;
  onDraftWorkspaceChange: (cwd: string) => void;
}

interface RuntimeBootstrapResult {
  runtimeRecoveryDone: boolean;
  startupAutoConnectRef: MutableRefObject<boolean>;
}

export function useRuntimeBootstrap({
  isTauri,
  connection,
  sessions,
  autoConnect,
  runtimeId,
  cwd,
  sessionFile,
  draftMode,
  onDraftModeChange,
  onDraftWorkspaceChange,
}: RuntimeBootstrapOptions): RuntimeBootstrapResult {
  const [runtimeRecoveryDone, setRuntimeRecoveryDone] = useState(false);
  const autoConnectedRef = useRef(false);
  const startupAutoConnectRef = useRef(false);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      const store = usePiStore.getState();
      cleanup = await subscribeToPi({
        onEvent: store.handleEvent,
        onStatus: store.handleStatus,
        onLog: store.handleLog,
        onProtocolError: (message) => usePiStore.getState().appendLog(`Pi 协议错误：${message}`),
      });
      if (disposed) {
        cleanup();
        return;
      }
      await Promise.all([store.loadSettings(), store.refreshSessions()]);
      const preferredRuntimeId = window.localStorage.getItem(ACTIVE_RUNTIME_KEY);
      const restored = await store.restoreRuntimes(preferredRuntimeId);
      if (restored && !disposed) {
        const current = usePiStore.getState();
        const restoredSessionMissing = current.sessionFile
          && !current.sessions.some((session) => sameLocalPath(session.file, current.sessionFile));
        if (restoredSessionMissing) {
          const workspace = current.cwd;
          window.localStorage.removeItem(ACTIVE_RUNTIME_KEY);
          window.localStorage.removeItem(LAST_TASK_KEY);
          try {
            await current.disconnect();
          } catch (error) {
            current.appendLog(`关闭已归档的恢复任务失败：${error instanceof Error ? error.message : String(error)}`);
          }
          current.prepareNewTask();
          onDraftModeChange(true);
          if (workspace) {
            window.localStorage.setItem("pid-desktop:last-workspace", workspace);
            onDraftWorkspaceChange(workspace);
          }
        } else {
          onDraftModeChange(!current.sessionFile);
        }
      }
      if (!disposed) setRuntimeRecoveryDone(true);
    })().catch((error) => {
      usePiStore.getState().appendLog(`初始化失败：${error instanceof Error ? error.message : String(error)}`);
      if (!disposed) setRuntimeRecoveryDone(true);
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [isTauri, onDraftModeChange, onDraftWorkspaceChange]);

  useEffect(() => {
    if (!runtimeRecoveryDone || !autoConnect || autoConnectedRef.current || connection !== "disconnected") return;
    const lastTask = readPersistedTask();
    const lastWorkspace = lastTask?.cwd || window.localStorage.getItem("pid-desktop:last-workspace");
    if (!lastWorkspace) return;
    const restoredSession = lastTask?.sessionFile
      && sessions.some((session) => sameLocalPath(session.file, lastTask.sessionFile))
      ? lastTask.sessionFile
      : undefined;
    autoConnectedRef.current = true;
    onDraftModeChange(!restoredSession);
    startupAutoConnectRef.current = true;
    void usePiStore.getState().connect(lastWorkspace, restoredSession).finally(() => {
      startupAutoConnectRef.current = false;
    });
  }, [autoConnect, connection, onDraftModeChange, runtimeRecoveryDone, sessions]);

  useEffect(() => {
    if (!runtimeId || !cwd) return;
    window.localStorage.setItem(ACTIVE_RUNTIME_KEY, runtimeId);
    window.localStorage.setItem("pid-desktop:last-workspace", cwd);
    if (!draftMode && sessionFile) {
      window.localStorage.setItem(LAST_TASK_KEY, JSON.stringify({ cwd, sessionFile } satisfies PersistedTask));
    } else {
      window.localStorage.removeItem(LAST_TASK_KEY);
    }
  }, [cwd, draftMode, runtimeId, sessionFile]);

  return { runtimeRecoveryDone, startupAutoConnectRef };
}
