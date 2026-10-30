// The store's slices (src/store, P6e): each provides its own members, none
// provides another's, and together they are the whole store, so composing
// them with spreads cannot silently overwrite a field or an action.
import { describe, expect, it } from "vitest";

Object.assign(globalThis, { window: globalThis });
const { useAppStore } = await import("../src/store/index.ts");
const { StoreContext } = await import("../src/store/context.ts");
const { createRuntimeSlice } = await import("../src/store/runtime.ts");
const { createSessionsSlice } = await import("../src/store/sessions.ts");
const { createTranscriptSlice } = await import("../src/store/transcript.ts");
const { createUiSlice } = await import("../src/store/ui.ts");

describe("store slices", () => {
  it("do not overlap and together make up the store", () => {
    const { setState: set, getState: get } = useAppStore;
    const ctx = new StoreContext(set, get);
    const slices = [createRuntimeSlice, createSessionsSlice, createTranscriptSlice, createUiSlice].map((create) => Object.keys(create(set, get, ctx)));
    const all = slices.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(Object.keys(useAppStore.getState())));
    expect(slices.map((keys) => keys.length)).toEqual([35, 16, 18, 14]);
  });
});
