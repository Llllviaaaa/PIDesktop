/**
 * `useHostRpcQuery` for `@qianji/client`: a small polling-aware query hook
 * over `qianji-harness` JSON-RPC, with in-flight request de-duplication.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { harnessRuntimes as internalHarnessRuntimes } from "../lib/harnessRuntime";

export interface HostRpcQueryOptions {
  enabled?: boolean;
  refreshIntervalMs?: number;
}

export interface HostRpcQueryResult<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refetch: () => Promise<void>;
}

const inflightHostRpcQueries = new Map<string, Promise<unknown>>();

function callDedupedHostRpc<T>(
  queryKey: string,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<T> {
  let pending = inflightHostRpcQueries.get(queryKey) as Promise<T> | undefined;
  if (!pending) {
    const request = internalHarnessRuntimes.call<T>(method, params).finally(() => {
      if (inflightHostRpcQueries.get(queryKey) === request) {
        inflightHostRpcQueries.delete(queryKey);
      }
    });
    pending = request;
    inflightHostRpcQueries.set(queryKey, request);
  }
  return pending;
}

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

/** Read-only reactive RPC query hook against `qianji-harness` JSON-RPC methods. */
export function useHostRpcQuery<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  options?: HostRpcQueryOptions,
): HostRpcQueryResult<T> {
  const enabled = options?.enabled !== false;
  const refreshIntervalMs = options?.refreshIntervalMs;
  const serializedParams = JSON.stringify(params ?? null);
  const queryKey = `${method}::${serializedParams}`;
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  const [state, setState] = useState<{
    data: T | undefined;
    error: string | null;
    loading: boolean;
  }>(() => ({
    data: undefined,
    error: null,
    loading: enabled,
  }));

  const seqRef = useRef(0);
  const runQuery = useCallback(async (silent: boolean) => {
    if (!enabled) return;
    const seq = ++seqRef.current;
    if (!silent) {
      setState((prev) => (
        prev.loading && prev.error === null
          ? prev
          : { ...prev, loading: prev.data === undefined, error: null }
      ));
    }
    try {
      const result = await callDedupedHostRpc<T>(queryKey, method, paramsRef.current);
      if (seq !== seqRef.current) return;
      setState((prev) => {
        if (silent && prev.error === null && !prev.loading && prev.data !== undefined) {
          try {
            if (JSON.stringify(prev.data) === JSON.stringify(result)) {
              return prev;
            }
          } catch {
            // Fall through to state update when non-JSON values are returned.
          }
        }
        return { data: result, error: null, loading: false };
      });
    } catch (err) {
      if (seq !== seqRef.current) return;
      setState((prev) => ({
        data: prev.data,
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      }));
    }
  }, [enabled, method, queryKey]);

  const refetch = useCallback(async () => {
    await runQuery(false);
  }, [runQuery]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const seq = ++seqRef.current;
    void (async () => {
      try {
        const result = await callDedupedHostRpc<T>(queryKey, method, paramsRef.current);
        if (cancelled || seq !== seqRef.current) return;
        setState({ data: result, error: null, loading: false });
      } catch (err) {
        if (cancelled || seq !== seqRef.current) return;
        setState((prev) => ({
          data: prev.data,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        }));
      }
    })();

    let timer: number | undefined;
    const hasInterval = typeof refreshIntervalMs === "number"
      && refreshIntervalMs > 0
      && typeof window !== "undefined"
      && typeof window.setInterval === "function";

    if (hasInterval) {
      timer = window.setInterval(() => {
        if (isDocumentHidden()) return;
        void runQuery(true);
      }, refreshIntervalMs);
    }

    const handleVisibilityChange = () => {
      if (!isDocumentHidden()) {
        void runQuery(true);
      }
    };
    const canListenVisibility = hasInterval
      && typeof document !== "undefined"
      && typeof document.addEventListener === "function";
    if (canListenVisibility) {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      cancelled = true;
      if (timer !== undefined && typeof window !== "undefined" && typeof window.clearInterval === "function") {
        window.clearInterval(timer);
      }
      if (canListenVisibility && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, [enabled, method, queryKey, refreshIntervalMs, runQuery]);

  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    refetch,
  };
}
