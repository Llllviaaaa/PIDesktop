/**
 * The desktop's store (P6e): four slices composed into one zustand store.
 * Each slice (runtime.ts, sessions.ts, transcript.ts, ui.ts) owns its state
 * and the actions that change it; what they share lives in context.ts.
 * Components read named fields, through the hooks in selectors.ts or a
 * selector of their own, never the whole store.
 */
import { create } from "zustand";
import { StoreContext } from "./context";
import { createRuntimeSlice } from "./runtime";
import { createSessionsSlice } from "./sessions";
import { createTranscriptSlice } from "./transcript";
import { createUiSlice } from "./ui";
import type { AppState } from "./types";

export type { AppState, RuntimeSlice, RuntimeState, SessionsSlice, TerminalState, TranscriptSlice, UiSlice } from "./types";

export const usePiStore = create<AppState>((set, get) => {
  const ctx = new StoreContext(set, get);
  return {
    ...createRuntimeSlice(set, get, ctx),
    ...createSessionsSlice(set, get, ctx),
    ...createTranscriptSlice(set, get, ctx),
    ...createUiSlice(set, get, ctx),
  };
});
