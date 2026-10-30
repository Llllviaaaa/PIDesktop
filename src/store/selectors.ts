/**
 * Reading the store by slice: each hook takes the names of the fields and
 * actions a component uses, from its own slice only, and re-renders the
 * component when one of those changes (a shallow comparison of the picks).
 *
 *   const { cwd, model, setModel } = useRuntime("cwd", "model", "setModel");
 */
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "./index";
import type { AppState, RuntimeSlice, SessionsSlice, TranscriptSlice, UiSlice } from "./types";

function usePick<K extends keyof AppState>(keys: readonly K[]): Pick<AppState, K> {
  return useAppStore(useShallow((state) => {
    const picked = {} as Pick<AppState, K>;
    for (const key of keys) picked[key] = state[key];
    return picked;
  }));
}

/**
 * Picks from several slices as one object, which keeps its identity while
 * none of the picks change, so hooks can depend on it.
 */
export function useSlices<
  R extends keyof RuntimeSlice = never,
  S extends keyof SessionsSlice = never,
  T extends keyof TranscriptSlice = never,
  U extends keyof UiSlice = never,
>(picks: { runtime?: R[]; sessions?: S[]; transcript?: T[]; ui?: U[] }): Pick<AppState, R | S | T | U> {
  return usePick([...(picks.runtime ?? []), ...(picks.sessions ?? []), ...(picks.transcript ?? []), ...(picks.ui ?? [])]);
}

export const useRuntime = <K extends keyof RuntimeSlice>(...keys: K[]): Pick<RuntimeSlice, K> => usePick(keys);
export const useSessions = <K extends keyof SessionsSlice>(...keys: K[]): Pick<SessionsSlice, K> => usePick(keys);
export const useTranscript = <K extends keyof TranscriptSlice>(...keys: K[]): Pick<TranscriptSlice, K> => usePick(keys);
export const useUi = <K extends keyof UiSlice>(...keys: K[]): Pick<UiSlice, K> => usePick(keys);
