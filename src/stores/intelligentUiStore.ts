import { create } from "zustand";
import { INTELLIGENT_UI_CANVAS_TAB_ID } from "../lib/intelligentUi";
import { useWorkbenchStore } from "./workbenchStore";

export interface IntelligentUiStoreState {
  /** Mirrors whether the built-in `intelligent-ui` plugin is active in Settings → Plugins. */
  pluginEnabled: boolean;
  /** Currently focused widget ID inside the Right Workbench Canvas tab. */
  selectedWidgetId: string | null;
  /** Explicit version overrides selected by the user (`widgetId -> version`). */
  selectedVersionById: Record<string, number>;
  /** Custom bridge registered by `App.tsx` so widget prompts exit Home draftMode cleanly if needed. */
  promptDispatcher: ((prompt: string) => Promise<boolean> | void) | null;

  setPluginEnabled: (enabled: boolean) => void;
  setSelectedWidgetId: (widgetId: string | null) => void;
  selectVersion: (widgetId: string, version: number) => void;
  openInCanvas: (widgetId: string, version?: number) => void;
  setPromptDispatcher: (dispatcher: ((prompt: string) => Promise<boolean> | void) | null) => void;
  dispatchWidgetPrompt: (prompt: string) => void;
}

export const useIntelligentUiStore = create<IntelligentUiStoreState>((set, get) => ({
  pluginEnabled: true,
  selectedWidgetId: null,
  selectedVersionById: {},
  promptDispatcher: null,

  setPluginEnabled: (enabled) => set({ pluginEnabled: enabled }),

  setSelectedWidgetId: (widgetId) => set({ selectedWidgetId: widgetId }),

  selectVersion: (widgetId, version) =>
    set((state) => ({
      selectedVersionById: {
        ...state.selectedVersionById,
        [widgetId]: version,
      },
    })),

  openInCanvas: (widgetId, version) => {
    set((state) => ({
      selectedWidgetId: widgetId,
      selectedVersionById: version !== undefined
        ? { ...state.selectedVersionById, [widgetId]: version }
        : state.selectedVersionById,
    }));
    useWorkbenchStore.getState().openTab(INTELLIGENT_UI_CANVAS_TAB_ID);
  },

  setPromptDispatcher: (dispatcher) => set({ promptDispatcher: dispatcher }),

  dispatchWidgetPrompt: (prompt) => {
    const clean = prompt.trim();
    if (!clean) return;
    const dispatcher = get().promptDispatcher;
    if (dispatcher) {
      void dispatcher(clean);
    }
  },
}));
