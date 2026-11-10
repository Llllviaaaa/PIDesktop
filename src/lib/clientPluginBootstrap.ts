/**
 * Unified self-owned client plugin bootstrap (`src/lib/clientPluginBootstrap.ts`).
 *
 * Replaces `src/dsh-host/client-plugins.ts` and `src/dsh-host/boot.ts` with a
 * single lightweight Cordis root context (`pidClientRoot`) wired directly to
 * `ClientContributionService` and `createClientPluginRuntime`.
 */
import { createElement, type ReactNode } from "react";
import { Context, Service, type Plugin } from "@deepseek-ai/cordis";
import { Layers } from "lucide-react";
import { agent } from "./agent";
import {
  ClientContributionRegistry,
  ClientContributionService,
  clientContributions,
  useClientContributions,
} from "./clientContributions";
import {
  createClientPluginRuntime,
  type ClientPluginRuntimeHandle,
  type ClientPluginTransport,
  type ModuleLoaderGlobal,
} from "./clientPluginRuntime";
import { HARNESS_SESSION_PREFIX, harnessRuntimes, isHarnessSessionFile } from "./harnessRuntime";
import { messageImagesToAttachments, rewindController } from "./rewindController";
import {
  deriveSessionIntelligentUis,
  INTELLIGENT_UI_CANVAS_TAB_ID,
} from "./intelligentUi";
import { pluginClient } from "./pluginClient";
import { groupTranscriptMessages } from "./transcriptTurns";
import { IntelligentUiCanvasTab } from "../components/workbench/IntelligentUiCanvasTab";
import { useAppStore } from "../store";
import { useIntelligentUiStore } from "../stores/intelligentUiStore";
import { useWorkbenchStore } from "../stores/workbenchStore";

declare module "@deepseek-ai/cordis" {
  interface Context {
    betterSidebar: BetterSidebarCompatService;
  }
}

declare global {
  interface Window {
    __ModuleLoader__?: ModuleLoaderGlobal;
  }
}

export interface LegacySidebarTabDescriptor {
  id: string;
  title?: string | (() => string);
  label?: string;
  icon?: ReactNode | ((size: number) => ReactNode);
  order?: number;
  bottomOnly?: boolean;
  component?: (props: Record<string, unknown>) => ReactNode;
  render?: (props: Record<string, unknown>) => ReactNode;
}

/**
 * Lightweight compatibility shim for external client-only plugins declaring
 * `inject: ["betterSidebar"]` or importing `"dsh-better-sidebar"`. Maps tab
 * contributions directly into `ClientContributionRegistry` (`rightWorkbenchTabs`
 * or `bottomPanelTabs`) with zero legacy DSH bundle weight.
 */
export class BetterSidebarCompatService extends Service {
  static provide = "betterSidebar";
  readonly version = "0.26.0";
  readonly features = ["openFile", "targetedOpen"] as const;
  private readonly registry: ClientContributionRegistry;

  constructor(ctx: Context, registry: ClientContributionRegistry = clientContributions) {
    super(ctx, "betterSidebar");
    this.registry = registry;
  }

  registerTab(descriptor: LegacySidebarTabDescriptor): () => void {
    const callerCtx = this.ctx;
    const resolveLabel = (): string => {
      if (typeof descriptor.title === "function") return descriptor.title();
      if (typeof descriptor.title === "string" && descriptor.title !== "") return descriptor.title;
      return descriptor.label || descriptor.id;
    };
    const icon = typeof descriptor.icon === "function" ? descriptor.icon(14) : descriptor.icon;
    const contribution = {
      id: descriptor.id,
      label: resolveLabel(),
      ...(icon === undefined ? {} : { icon }),
      ...(descriptor.order === undefined ? {} : { order: descriptor.order }),
      render: ({ cwd, sessionFile }: { cwd: string; sessionFile: string | null }): ReactNode => {
        const sessionId = sessionFile && isHarnessSessionFile(sessionFile)
          ? sessionFile.slice(HARNESS_SESSION_PREFIX.length)
          : "";
        const props = {
          ctx: callerCtx,
          cwd,
          sessionFile,
          scope: { sessionId, cwd },
          tab: { id: descriptor.id, type: descriptor.id, title: resolveLabel() },
          visible: true,
          onOpenFile: (path: string) => {
            void useWorkbenchStore.getState().openFile(cwd, path);
          },
        };
        if (typeof descriptor.component === "function") return descriptor.component(props);
        if (typeof descriptor.render === "function") return descriptor.render(props);
        return null;
      },
    };
    const dispose = descriptor.bottomOnly
      ? this.registry.registerBottomPanelTab(contribution)
      : this.registry.registerRightWorkbenchTab(contribution);
    callerCtx.effect(() => dispose);
    return dispose;
  }

  registerFileViewer(_descriptor: unknown): () => void {
    return () => {};
  }

  registerFileIcon(_descriptor: unknown): () => void {
    return () => {};
  }

  openFile(scope: { cwd?: string } | undefined, path: string): void {
    const cwd = scope?.cwd || useAppStore.getState().cwd;
    void useWorkbenchStore.getState().openFile(cwd, path);
  }

  openTab(seed: { type?: string; id?: string; path?: string }, scope?: { cwd?: string }): void {
    if (typeof seed.path === "string" && seed.path !== "") {
      const cwd = scope?.cwd || useAppStore.getState().cwd;
      void useWorkbenchStore.getState().openFile(cwd, seed.path);
      return;
    }
    const target = seed.type ?? seed.id;
    if (typeof target === "string" && target !== "") {
      useWorkbenchStore.getState().openTab(target);
    }
  }

  closeTab(_tabId: string): void {}
  activateTab(tabId: string): void {
    useWorkbenchStore.getState().openTab(tabId);
  }
  subscribe(_listener: () => void): () => void {
    return () => {};
  }
  subscribeState(_listener: () => void): () => void {
    return () => {};
  }
  getSnapshot(): Record<string, unknown> {
    return {};
  }
}

const betterSidebarCompatModule = {
  BetterSidebarCompatService,
  SIDEBAR_SERVICE_VERSION: "0.26.0",
};

/** Public client SDK exposed to dynamic `.tsx` plugins via `import ... from "@qianji/client"`. */
export {
  clientContributions,
  useClientContributions,
  useWorkbenchStore,
  harnessRuntimes,
  rewindController,
  messageImagesToAttachments,
  agent,
  useAppStore,
};
export type {
  ClientComposerStatusContribution,
  WorkbenchSlotContext,
} from "./clientContributions";
export type {
  ComposerDraftSnapshot,
  PerformedRewindResult,
  RewindExecutionResult,
  RewindInspection,
  RewindMode,
  RewindTargetSummary,
  RewindTurnSummary,
} from "./rewindController";
export type { UiMessage, AttachmentPayload } from "../types";

export const pidClientSdk = {
  clientContributions,
  useClientContributions,
  useWorkbenchStore,
  harnessRuntimes,
  rewindController,
  messageImagesToAttachments,
  agent,
  useAppStore,
};

/** Shared browser singletons exposed via both `ctx.modules.import()` and CJS `require()`. */
export const CLIENT_MODULES: Record<string, () => Promise<unknown>> = {
  "react": () => import("react"),
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  "react/jsx-dev-runtime": async () => {
    const [devMod, prodMod] = await Promise.all([
      import("react/jsx-dev-runtime"),
      import("react/jsx-runtime"),
    ]);
    const devRecord = devMod as Record<string, unknown>;
    if (typeof devRecord.jsxDEV === "function") return devMod;
    const prodRecord = prodMod as {
      Fragment: unknown;
      jsx: (type: unknown, props: unknown, key?: unknown) => unknown;
      jsxs: (type: unknown, props: unknown, key?: unknown) => unknown;
    };
    const jsxDEV = (
      type: unknown,
      props: unknown,
      key?: unknown,
      isStaticChildren?: boolean,
    ) => (isStaticChildren ? prodRecord.jsxs(type, props, key) : prodRecord.jsx(type, props, key));
    return {
      Fragment: prodRecord.Fragment,
      jsxDEV,
      default: { Fragment: prodRecord.Fragment, jsxDEV },
    };
  },
  "react-dom": () => import("react-dom"),
  "react-dom/client": () => import("react-dom/client"),
  "cordis": () => import("@deepseek-ai/cordis"),
  "@deepseek-ai/cordis": () => import("@deepseek-ai/cordis"),
  "schemastery": () => import("@deepseek-ai/schemastery"),
  "@deepseek-ai/schemastery": () => import("@deepseek-ai/schemastery"),
  "@qianji/client": async () => pidClientSdk,
  "@qianji/protocol": () => import("@qianji/protocol"),
  "@pid/client": async () => pidClientSdk,
  "@pid/protocol": () => import("@qianji/protocol"),
  "dsh-better-sidebar": async () => betterSidebarCompatModule,
  "dsh-better-sidebar/client": async () => betterSidebarCompatModule,
  "lucide-react": () => import("lucide-react"),
};

const defaultTransport: ClientPluginTransport = {
  list: (workspace) => pluginClient.list(workspace),
  clientBundle: (params) => pluginClient.clientBundle(params),
  onChanged: (listener) => pluginClient.onChanged(() => listener()),
  onTrustChanged: (listener) => pluginClient.onTrustChanged(() => listener()),
  onHostReconnect: (listener) => {
    let seenConnected = false;
    return harnessRuntimes.onHostStatus((status) => {
      if (status === "connected") {
        if (seenConnected) listener();
        seenConnected = true;
      }
    });
  },
};

let singletonRoot: Context | undefined;
let singletonRuntime: ClientPluginRuntimeHandle | undefined;

function mountBuiltinIntelligentUiSync(): void {
  let mountedDisposers: Array<() => void> = [];
  let currentWorkspace: string | undefined;

  const applyEnabled = (enabled: boolean) => {
    useIntelligentUiStore.getState().setPluginEnabled(enabled);
    if (enabled) {
      if (mountedDisposers.length > 0) return;
      mountedDisposers = [
        clientContributions.registerRightWorkbenchTab({
          id: INTELLIGENT_UI_CANVAS_TAB_ID,
          label: "画布",
          icon: createElement(Layers, { size: 13 }),
          order: 15,
          render: () => createElement(IntelligentUiCanvasTab),
        }),
      ];
    } else {
      for (const dispose of mountedDisposers) dispose();
      mountedDisposers = [];
      if (useWorkbenchStore.getState().activeTab === INTELLIGENT_UI_CANVAS_TAB_ID) {
        useWorkbenchStore.getState().openTab("files");
      }
    }
  };

  // Mount immediately by default so offline / browser / fixture boots have Intelligent UI ready.
  applyEnabled(true);

  const syncFromHost = async () => {
    try {
      const items = await pluginClient.list(currentWorkspace);
      const entry = items.find((item) => item.id === "intelligent-ui");
      if (entry !== undefined) {
        applyEnabled(entry.enabled !== false && entry.status !== "disabled");
      }
    } catch {
      // Keep current state when host is not yet connected or running in browser mode.
    }
  };

  void syncFromHost();
  pluginClient.onChanged(() => {
    void syncFromHost();
  });
  harnessRuntimes.onHostStatus((status) => {
    if (status === "connected") {
      void syncFromHost();
    }
  });
  const seenHtmlArtifacts = new Set<string>();
  let trackedSessionFile: string | null = useAppStore.getState().sessionFile;

  useAppStore.subscribe((state, prev) => {
    if (state.cwd !== prev.cwd) {
      currentWorkspace = state.cwd || undefined;
      void syncFromHost();
    }
    if (state.messages !== prev.messages || state.sessionFile !== prev.sessionFile) {
      const sessionChangedIdle = state.sessionFile !== trackedSessionFile && !state.isStreaming;
      trackedSessionFile = state.sessionFile;
      if (state.messages.length === 0) return;
      const summary = deriveSessionIntelligentUis(groupTranscriptMessages(state.messages));
      for (const grp of summary.orderedGroups) {
        if (grp.latest.engine !== "html") continue;
        const key = `${state.sessionFile ?? "draft"}::${grp.id}::v${grp.latest.version}`;
        if (!seenHtmlArtifacts.has(key)) {
          seenHtmlArtifacts.add(key);
          if (!sessionChangedIdle && useIntelligentUiStore.getState().pluginEnabled) {
            useIntelligentUiStore.getState().openInCanvas(grp.id, grp.latest.version);
          }
        }
      }
    }
  });
}

export function ensureClientPluginRuntime(): ClientPluginRuntimeHandle {
  if (singletonRuntime !== undefined) return singletonRuntime;
  const root = new Context();
  root.plugin(ClientContributionService, clientContributions);
  root.plugin(BetterSidebarCompatService, clientContributions);
  mountBuiltinIntelligentUiSync();
  singletonRoot = root;
  singletonRuntime = createClientPluginRuntime<Plugin>(root, {
    transport: defaultTransport,
    modules: CLIENT_MODULES,
  });
  return singletonRuntime;
}

export function getClientRootContext(): Context | undefined {
  return singletonRoot;
}
