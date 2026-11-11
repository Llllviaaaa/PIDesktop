/**
 * Unified Client Contribution Registry (`ctx.contributions` / `@qianji/client`).
 *
 * Replaces DSH's multi-tree slot bridge with a single reactive contribution
 * registry shared by Qianji's own React tree and dynamic UI/theme plugins.
 * All contribution types (`pages`, `leftSidebar`, `rightWorkbenchTabs`,
 * `bottomPanelTabs`, `topbarActions`, `composerToolbar`, `composerStatus`,
 * `composerBanners`, `overlays`, `messageActions`, `toolRenderers`,
 * `fileViewers`, `statusBarItems`, `homeQuickActions`, `themes`) are flat
 * registrations returning an idempotent disposer `() => void` for HMR.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { Context, Service } from "@deepseek-ai/cordis";
import { CLIENT_SLOT_CATALOG, type ClientSlotMetadata } from "@qianji/protocol";
import type { UiMessage, UiToolCall } from "../types";
import type { AppearanceScope, AppearanceThemeDefinition } from "./appearanceCatalog";
import { injectPluginScopedStyle, recordClientRenderError, resolveContextPluginId } from "./clientPluginRuntime";

declare module "@deepseek-ai/cordis" {
  interface Context {
    contributions: ClientContributionService;
    styles: ClientStylesService;
  }
}

export interface WorkbenchSlotContext {
  cwd: string;
  sessionFile: string | null;
  variant?: "task-start" | "follow-up";
}

export interface MessageActionSlotContext extends WorkbenchSlotContext {
  message: UiMessage;
  contentText: string;
}

export interface ToolRendererSlotContext extends WorkbenchSlotContext {
  call: UiToolCall;
  state: "running" | "error" | "ok";
}

export interface FileViewerSlotContext extends WorkbenchSlotContext {
  path: string;
  content: string;
  isBinary: boolean;
  mimeType?: string;
  dataBase64?: string;
  size: number;
}

export interface HomeQuickActionSlotContext extends WorkbenchSlotContext {
  prefillComposer: (prompt: string) => void;
  sendPrompt: (prompt: string) => void;
}

export interface ClientPageContribution {
  id: string;
  pluginId?: string;
  label: string;
  icon?: ReactNode;
  order?: number;
  render: (context: WorkbenchSlotContext) => ReactNode;
}

export interface ClientSidebarSectionContribution {
  id: string;
  pluginId?: string;
  order?: number;
  render: (context: WorkbenchSlotContext) => ReactNode;
}

export interface ClientWorkbenchTabContribution {
  id: string;
  pluginId?: string;
  label: string;
  icon?: ReactNode;
  order?: number;
  render: (context: WorkbenchSlotContext) => ReactNode;
}

export interface ClientActionContribution {
  id: string;
  pluginId?: string;
  order?: number;
  render: (context: WorkbenchSlotContext) => ReactNode;
}

export interface ClientComposerStatusContribution {
  id: string;
  pluginId?: string;
  position?: "before-model" | "after-model";
  order?: number;
  render: (context: WorkbenchSlotContext) => ReactNode;
}

export interface ClientMessageActionContribution {
  id: string;
  pluginId?: string;
  role?: "user" | "assistant" | "both";
  order?: number;
  render: (context: MessageActionSlotContext) => ReactNode;
}

export interface ClientToolRendererContribution {
  id: string;
  pluginId?: string;
  /** Exact tool name(s) or prefix wildcard (e.g. `"sqlite_*"`) matched by this card renderer. */
  toolNames: readonly string[];
  order?: number;
  render: (context: ToolRendererSlotContext) => ReactNode;
}

export interface ClientFileViewerContribution {
  id: string;
  pluginId?: string;
  label?: string;
  /** File extensions matched case-insensitively (e.g. `[".sqlite", ".db"]` or `["csv"]`). */
  extensions?: readonly string[];
  /** Exact or wildcard MIME types (e.g. `["application/vnd.sqlite3", "audio/*"]`). */
  mimeTypes?: readonly string[];
  order?: number;
  render: (context: FileViewerSlotContext) => ReactNode;
}

export interface ClientStatusBarContribution {
  id: string;
  pluginId?: string;
  align?: "left" | "right";
  order?: number;
  render: (context: WorkbenchSlotContext) => ReactNode;
}

export interface ClientHomeQuickActionContribution {
  id: string;
  pluginId?: string;
  label?: string;
  icon?: ReactNode;
  prompt?: string;
  order?: number;
  onSelect?: (context: HomeQuickActionSlotContext) => void;
  render?: (context: HomeQuickActionSlotContext) => ReactNode;
}

export interface ClientRewindHandlerContribution {
  id: string;
  pluginId?: string;
  order?: number;
  onRewindMessage: (message: UiMessage) => Promise<boolean> | boolean;
  onOpenTimeline?: () => void;
}

export interface ClientSlashInterceptorContribution {
  id: string;
  pluginId?: string;
  order?: number;
  onSlashCommand: (name: string, rawArgs: string, context: WorkbenchSlotContext) => Promise<boolean> | boolean;
}

export interface ClientContributionsSnapshot {
  readonly pages: readonly ClientPageContribution[];
  readonly leftSidebar: readonly ClientSidebarSectionContribution[];
  readonly rightWorkbenchTabs: readonly ClientWorkbenchTabContribution[];
  readonly bottomPanelTabs: readonly ClientWorkbenchTabContribution[];
  readonly topbarActions: readonly ClientActionContribution[];
  readonly composerToolbar: readonly ClientActionContribution[];
  readonly composerStatus: readonly ClientComposerStatusContribution[];
  readonly composerBanners: readonly ClientActionContribution[];
  readonly overlays: readonly ClientActionContribution[];
  readonly messageActions: readonly ClientMessageActionContribution[];
  readonly toolRenderers: readonly ClientToolRendererContribution[];
  readonly fileViewers: readonly ClientFileViewerContribution[];
  readonly statusBarItems: readonly ClientStatusBarContribution[];
  readonly homeQuickActions: readonly ClientHomeQuickActionContribution[];
  readonly rewindHandlers: readonly ClientRewindHandlerContribution[];
  readonly slashInterceptors: readonly ClientSlashInterceptorContribution[];
  readonly themes: readonly AppearanceThemeDefinition[];
}

export type AppearanceThemeInput = Omit<AppearanceThemeDefinition, "scope"> & {
  scope?: AppearanceScope;
};

export { CLIENT_SLOT_CATALOG, type ClientSlotMetadata };

function sortByOrder<T extends { id: string; order?: number }>(items: Iterable<T>): T[] {
  return [...items].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
}

function normalizeExt(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (trimmed === "") return "";
  return trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
}

/** Match the highest-priority registered `ClientFileViewerContribution` for a file path / MIME type. */
export function matchFileViewer(
  viewers: readonly ClientFileViewerContribution[],
  file: { path: string; mimeType?: string },
): ClientFileViewerContribution | undefined {
  const lowerPath = file.path.toLowerCase();
  const lastDot = lowerPath.lastIndexOf(".");
  const fileExt = lastDot >= 0 ? lowerPath.slice(lastDot + 1) : "";
  const lowerMime = file.mimeType?.trim().toLowerCase() ?? "";

  for (const viewer of viewers) {
    if (viewer.extensions !== undefined && fileExt !== "") {
      for (const rawExt of viewer.extensions) {
        if (normalizeExt(rawExt) === fileExt) {
          return viewer;
        }
      }
    }
    if (viewer.mimeTypes !== undefined && lowerMime !== "") {
      for (const rawMime of viewer.mimeTypes) {
        const pattern = rawMime.trim().toLowerCase();
        if (pattern === "") continue;
        if (pattern.endsWith("/*")) {
          const prefix = pattern.slice(0, -1);
          if (lowerMime.startsWith(prefix)) return viewer;
        } else if (lowerMime === pattern) {
          return viewer;
        }
      }
    }
  }
  return undefined;
}

/** Match the highest-priority registered `ClientToolRendererContribution` for a tool call name. */
export function matchToolRenderer(
  renderers: readonly ClientToolRendererContribution[],
  toolName: string,
): ClientToolRendererContribution | undefined {
  const normalized = toolName.trim();
  if (normalized === "") return undefined;
  for (const renderer of renderers) {
    for (const pattern of renderer.toolNames) {
      const clean = pattern.trim();
      if (clean === "") continue;
      if (clean === "*" || clean === normalized) return renderer;
      if (clean.endsWith("*") && normalized.startsWith(clean.slice(0, -1))) {
        return renderer;
      }
    }
  }
  return undefined;
}

export class ClientContributionRegistry {
  private readonly pages = new Map<string, ClientPageContribution>();
  private readonly leftSidebar = new Map<string, ClientSidebarSectionContribution>();
  private readonly rightWorkbenchTabs = new Map<string, ClientWorkbenchTabContribution>();
  private readonly bottomPanelTabs = new Map<string, ClientWorkbenchTabContribution>();
  private readonly topbarActions = new Map<string, ClientActionContribution>();
  private readonly composerToolbar = new Map<string, ClientActionContribution>();
  private readonly composerStatus = new Map<string, ClientComposerStatusContribution>();
  private readonly composerBanners = new Map<string, ClientActionContribution>();
  private readonly overlays = new Map<string, ClientActionContribution>();
  private readonly messageActions = new Map<string, ClientMessageActionContribution>();
  private readonly toolRenderers = new Map<string, ClientToolRendererContribution>();
  private readonly fileViewers = new Map<string, ClientFileViewerContribution>();
  private readonly statusBarItems = new Map<string, ClientStatusBarContribution>();
  private readonly homeQuickActions = new Map<string, ClientHomeQuickActionContribution>();
  private readonly rewindHandlers = new Map<string, ClientRewindHandlerContribution>();
  private readonly slashInterceptors = new Map<string, ClientSlashInterceptorContribution>();
  private readonly themes = new Map<string, AppearanceThemeDefinition>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ClientContributionsSnapshot = this.buildSnapshot();

  private buildSnapshot(): ClientContributionsSnapshot {
    return {
      pages: sortByOrder(this.pages.values()),
      leftSidebar: sortByOrder(this.leftSidebar.values()),
      rightWorkbenchTabs: sortByOrder(this.rightWorkbenchTabs.values()),
      bottomPanelTabs: sortByOrder(this.bottomPanelTabs.values()),
      topbarActions: sortByOrder(this.topbarActions.values()),
      composerToolbar: sortByOrder(this.composerToolbar.values()),
      composerStatus: sortByOrder(this.composerStatus.values()),
      composerBanners: sortByOrder(this.composerBanners.values()),
      overlays: sortByOrder(this.overlays.values()),
      messageActions: sortByOrder(this.messageActions.values()),
      toolRenderers: sortByOrder(this.toolRenderers.values()),
      fileViewers: sortByOrder(this.fileViewers.values()),
      statusBarItems: sortByOrder(this.statusBarItems.values()),
      homeQuickActions: sortByOrder(this.homeQuickActions.values()),
      rewindHandlers: sortByOrder(this.rewindHandlers.values()),
      slashInterceptors: sortByOrder(this.slashInterceptors.values()),
      themes: [...this.themes.values()],
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private insert<T extends { id: string }>(map: Map<string, T>, item: T): () => void {
    map.set(item.id, item);
    this.emit();
    return () => {
      if (map.get(item.id) === item) {
        map.delete(item.id);
        this.emit();
      }
    };
  }

  registerPage(page: ClientPageContribution): () => void {
    return this.insert(this.pages, page);
  }

  registerLeftSidebar(section: ClientSidebarSectionContribution): () => void {
    return this.insert(this.leftSidebar, section);
  }

  registerRightWorkbenchTab(tab: ClientWorkbenchTabContribution): () => void {
    return this.insert(this.rightWorkbenchTabs, tab);
  }

  registerBottomPanelTab(tab: ClientWorkbenchTabContribution): () => void {
    return this.insert(this.bottomPanelTabs, tab);
  }

  registerTopbarAction(action: ClientActionContribution): () => void {
    return this.insert(this.topbarActions, action);
  }

  registerComposerToolbar(item: ClientActionContribution): () => void {
    return this.insert(this.composerToolbar, item);
  }

  registerComposerStatus(item: ClientComposerStatusContribution): () => void {
    return this.insert(this.composerStatus, item);
  }

  registerComposerBanner(item: ClientActionContribution): () => void {
    return this.insert(this.composerBanners, item);
  }

  registerOverlay(item: ClientActionContribution): () => void {
    return this.insert(this.overlays, item);
  }

  registerMessageAction(item: ClientMessageActionContribution): () => void {
    return this.insert(this.messageActions, item);
  }

  registerToolRenderer(item: ClientToolRendererContribution): () => void {
    return this.insert(this.toolRenderers, item);
  }

  registerFileViewer(item: ClientFileViewerContribution): () => void {
    return this.insert(this.fileViewers, item);
  }

  registerStatusBarItem(item: ClientStatusBarContribution): () => void {
    return this.insert(this.statusBarItems, item);
  }

  registerHomeQuickAction(item: ClientHomeQuickActionContribution): () => void {
    return this.insert(this.homeQuickActions, item);
  }

  registerRewindHandler(handler: ClientRewindHandlerContribution): () => void {
    return this.insert(this.rewindHandlers, handler);
  }

  registerSlashInterceptor(interceptor: ClientSlashInterceptorContribution): () => void {
    return this.insert(this.slashInterceptors, interceptor);
  }

  findToolRenderer(toolName: string): ClientToolRendererContribution | undefined {
    return matchToolRenderer(this.snapshot.toolRenderers, toolName);
  }

  findFileViewer(file: { path: string; mimeType?: string }): ClientFileViewerContribution | undefined {
    return matchFileViewer(this.snapshot.fileViewers, file);
  }

  hasRewindHandler(): boolean {
    return this.snapshot.rewindHandlers.length > 0;
  }

  async tryHandleRewind(message: UiMessage): Promise<boolean> {
    for (const handler of this.snapshot.rewindHandlers) {
      try {
        if (await handler.onRewindMessage(message)) {
          return true;
        }
      } catch (error) {
        recordClientRenderError(handler.pluginId, `rewind:${handler.id}`, error);
        console.error(`[qianji-client-plugins] rewind handler "${handler.id}" failed:`, error);
      }
    }
    return false;
  }

  openRewindTimeline(): boolean {
    for (const handler of this.snapshot.rewindHandlers) {
      if (typeof handler.onOpenTimeline === "function") {
        try {
          handler.onOpenTimeline();
          return true;
        } catch (error) {
          recordClientRenderError(handler.pluginId, `rewind-timeline:${handler.id}`, error);
          console.error(`[qianji-client-plugins] rewind timeline handler "${handler.id}" failed:`, error);
        }
      }
    }
    return false;
  }

  async tryHandleSlashCommand(name: string, rawArgs: string, context: WorkbenchSlotContext): Promise<boolean> {
    for (const item of this.snapshot.slashInterceptors) {
      try {
        if (await item.onSlashCommand(name, rawArgs, context)) {
          return true;
        }
      } catch (error) {
        recordClientRenderError(item.pluginId, `slash:${item.id}`, error);
        console.error(`[qianji-client-plugins] slash interceptor "${item.id}" failed:`, error);
      }
    }
    return false;
  }

  registerTheme(theme: AppearanceThemeInput): () => void {
    return this.insert(this.themes, { ...theme, scope: theme.scope ?? "user" });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ClientContributionsSnapshot => this.snapshot;

  clear(): void {
    this.pages.clear();
    this.leftSidebar.clear();
    this.rightWorkbenchTabs.clear();
    this.bottomPanelTabs.clear();
    this.topbarActions.clear();
    this.composerToolbar.clear();
    this.composerStatus.clear();
    this.composerBanners.clear();
    this.overlays.clear();
    this.messageActions.clear();
    this.toolRenderers.clear();
    this.fileViewers.clear();
    this.statusBarItems.clear();
    this.homeQuickActions.clear();
    this.rewindHandlers.clear();
    this.slashInterceptors.clear();
    this.themes.clear();
    this.emit();
  }
}

export class ClientContributionService extends Service {
  static provide = "contributions";
  readonly registry: ClientContributionRegistry;

  constructor(ctx: Context, registry: ClientContributionRegistry = clientContributions) {
    super(ctx, "contributions");
    this.registry = registry;
  }

  private withPluginId<T extends { pluginId?: string }>(item: T): T {
    if (item.pluginId !== undefined) return item;
    const pluginId = resolveContextPluginId(this.ctx);
    return pluginId === undefined ? item : { ...item, pluginId };
  }

  private track(dispose: () => void): () => void {
    let disposed = false;
    const once = () => {
      if (disposed) return;
      disposed = true;
      dispose();
    };
    return this.ctx.effect(() => once);
  }

  registerPage(page: ClientPageContribution): () => void {
    return this.track(this.registry.registerPage(this.withPluginId(page)));
  }

  registerLeftSidebar(section: ClientSidebarSectionContribution): () => void {
    return this.track(this.registry.registerLeftSidebar(this.withPluginId(section)));
  }

  registerRightWorkbenchTab(tab: ClientWorkbenchTabContribution): () => void {
    return this.track(this.registry.registerRightWorkbenchTab(this.withPluginId(tab)));
  }

  registerBottomPanelTab(tab: ClientWorkbenchTabContribution): () => void {
    return this.track(this.registry.registerBottomPanelTab(this.withPluginId(tab)));
  }

  registerTopbarAction(action: ClientActionContribution): () => void {
    return this.track(this.registry.registerTopbarAction(this.withPluginId(action)));
  }

  registerComposerToolbar(item: ClientActionContribution): () => void {
    return this.track(this.registry.registerComposerToolbar(this.withPluginId(item)));
  }

  registerComposerStatus(item: ClientComposerStatusContribution): () => void {
    return this.track(this.registry.registerComposerStatus(this.withPluginId(item)));
  }

  registerComposerBanner(item: ClientActionContribution): () => void {
    return this.track(this.registry.registerComposerBanner(this.withPluginId(item)));
  }

  registerOverlay(item: ClientActionContribution): () => void {
    return this.track(this.registry.registerOverlay(this.withPluginId(item)));
  }

  registerMessageAction(item: ClientMessageActionContribution): () => void {
    return this.track(this.registry.registerMessageAction(this.withPluginId(item)));
  }

  registerToolRenderer(item: ClientToolRendererContribution): () => void {
    return this.track(this.registry.registerToolRenderer(this.withPluginId(item)));
  }

  registerFileViewer(item: ClientFileViewerContribution): () => void {
    return this.track(this.registry.registerFileViewer(this.withPluginId(item)));
  }

  registerStatusBarItem(item: ClientStatusBarContribution): () => void {
    return this.track(this.registry.registerStatusBarItem(this.withPluginId(item)));
  }

  registerHomeQuickAction(item: ClientHomeQuickActionContribution): () => void {
    return this.track(this.registry.registerHomeQuickAction(this.withPluginId(item)));
  }

  registerRewindHandler(handler: ClientRewindHandlerContribution): () => void {
    return this.track(this.registry.registerRewindHandler(this.withPluginId(handler)));
  }

  registerSlashInterceptor(interceptor: ClientSlashInterceptorContribution): () => void {
    return this.track(this.registry.registerSlashInterceptor(this.withPluginId(interceptor)));
  }

  registerTheme(theme: AppearanceThemeInput): () => void {
    return this.track(this.registry.registerTheme(theme));
  }
}

/**
 * Scoped stylesheet injection service (`ctx.styles.inject(css, key?)`).
 * Automatically wraps plugin rules inside `@layer plugin-ui { @scope ([data-qj-plugin="<id>"]) { ... } }`
 * and disposes the `<style>` element when the owning Cordis Fiber unmounts.
 */
export class ClientStylesService extends Service {
  static provide = "styles";

  constructor(ctx: Context) {
    super(ctx, "styles");
  }

  inject(css: string, key?: string): () => void {
    const callerCtx = this.ctx;
    const pluginId = resolveContextPluginId(callerCtx) ?? "builtin";
    const rawDispose = injectPluginScopedStyle(pluginId, css, key);
    let disposed = false;
    const once = () => {
      if (disposed) return;
      disposed = true;
      rawDispose();
    };
    return callerCtx.effect(() => once);
  }
}

export const clientContributions = new ClientContributionRegistry();

export function useClientContributions(): ClientContributionsSnapshot {
  return useSyncExternalStore(clientContributions.subscribe, clientContributions.getSnapshot, clientContributions.getSnapshot);
}

