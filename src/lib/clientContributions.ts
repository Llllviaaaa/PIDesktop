/**
 * Unified Client Contribution Registry (`ctx.contributions` / `@qianji/client`).
 *
 * Replaces DSH's multi-tree slot bridge with a single reactive contribution
 * registry shared by Qianji's own React tree and dynamic UI/theme plugins.
 * All contribution types (`pages`, `leftSidebar`, `rightWorkbenchTabs`,
 * `bottomPanelTabs`, `topbarActions`, `composerToolbar`, `themes`) are
 * equal, flat registrations returning a clean disposer `() => void` for HMR.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { Context, Service } from "@deepseek-ai/cordis";
import type { UiMessage } from "../types";
import type { AppearanceThemeDefinition } from "./appearanceCatalog";

declare module "@deepseek-ai/cordis" {
  interface Context {
    contributions: ClientContributionService;
  }
}

export interface WorkbenchSlotContext {
  cwd: string;
  sessionFile: string | null;
  variant?: "task-start" | "follow-up";
}

export interface ClientPageContribution {
  id: string;
  label: string;
  icon?: ReactNode;
  order?: number;
  render: (context: WorkbenchSlotContext) => ReactNode;
}

export interface ClientSidebarSectionContribution {
  id: string;
  order?: number;
  render: (context: WorkbenchSlotContext) => ReactNode;
}

export interface ClientWorkbenchTabContribution {
  id: string;
  label: string;
  icon?: ReactNode;
  order?: number;
  render: (context: WorkbenchSlotContext) => ReactNode;
}

export interface ClientActionContribution {
  id: string;
  order?: number;
  render: (context: WorkbenchSlotContext) => ReactNode;
}

export interface ClientComposerStatusContribution {
  id: string;
  position?: "before-model" | "after-model";
  order?: number;
  render: (context: WorkbenchSlotContext) => ReactNode;
}

export interface ClientRewindHandlerContribution {
  id: string;
  order?: number;
  onRewindMessage: (message: UiMessage) => Promise<boolean> | boolean;
  onOpenTimeline?: () => void;
}

export interface ClientSlashInterceptorContribution {
  id: string;
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
  readonly rewindHandlers: readonly ClientRewindHandlerContribution[];
  readonly slashInterceptors: readonly ClientSlashInterceptorContribution[];
  readonly themes: readonly AppearanceThemeDefinition[];
}

function sortByOrder<T extends { id: string; order?: number }>(items: Iterable<T>): T[] {
  return [...items].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
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

  registerRewindHandler(handler: ClientRewindHandlerContribution): () => void {
    return this.insert(this.rewindHandlers, handler);
  }

  registerSlashInterceptor(interceptor: ClientSlashInterceptorContribution): () => void {
    return this.insert(this.slashInterceptors, interceptor);
  }

  hasRewindHandler(): boolean {
    return this.snapshot.rewindHandlers.length > 0;
  }

  async tryHandleRewind(message: UiMessage): Promise<boolean> {
    const primary = this.snapshot.rewindHandlers[0];
    if (!primary) return false;
    return await primary.onRewindMessage(message);
  }

  openRewindTimeline(): boolean {
    for (const handler of this.snapshot.rewindHandlers) {
      if (typeof handler.onOpenTimeline === "function") {
        handler.onOpenTimeline();
        return true;
      }
    }
    return false;
  }

  async tryHandleSlashCommand(name: string, rawArgs: string, context: WorkbenchSlotContext): Promise<boolean> {
    for (const item of this.snapshot.slashInterceptors) {
      if (await item.onSlashCommand(name, rawArgs, context)) {
        return true;
      }
    }
    return false;
  }

  registerTheme(theme: AppearanceThemeDefinition): () => void {
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
    this.rewindHandlers.clear();
    this.slashInterceptors.clear();
    this.themes.clear();
    this.emit();
  }
}

export class ClientContributionService extends Service {
  static provide = "contributions";
  readonly registry: ClientContributionRegistry;

  constructor(ctx: Context, registry: ClientContributionRegistry) {
    super(ctx, "contributions");
    this.registry = registry;
  }

  private track(dispose: () => void): () => void {
    this.ctx.effect(() => dispose);
    return dispose;
  }

  registerPage(page: ClientPageContribution): () => void {
    return this.track(this.registry.registerPage(page));
  }

  registerLeftSidebar(section: ClientSidebarSectionContribution): () => void {
    return this.track(this.registry.registerLeftSidebar(section));
  }

  registerRightWorkbenchTab(tab: ClientWorkbenchTabContribution): () => void {
    return this.track(this.registry.registerRightWorkbenchTab(tab));
  }

  registerBottomPanelTab(tab: ClientWorkbenchTabContribution): () => void {
    return this.track(this.registry.registerBottomPanelTab(tab));
  }

  registerTopbarAction(action: ClientActionContribution): () => void {
    return this.track(this.registry.registerTopbarAction(action));
  }

  registerComposerToolbar(item: ClientActionContribution): () => void {
    return this.track(this.registry.registerComposerToolbar(item));
  }

  registerComposerStatus(item: ClientComposerStatusContribution): () => void {
    return this.track(this.registry.registerComposerStatus(item));
  }

  registerComposerBanner(item: ClientActionContribution): () => void {
    return this.track(this.registry.registerComposerBanner(item));
  }

  registerOverlay(item: ClientActionContribution): () => void {
    return this.track(this.registry.registerOverlay(item));
  }

  registerRewindHandler(handler: ClientRewindHandlerContribution): () => void {
    return this.track(this.registry.registerRewindHandler(handler));
  }

  registerSlashInterceptor(interceptor: ClientSlashInterceptorContribution): () => void {
    return this.track(this.registry.registerSlashInterceptor(interceptor));
  }

  registerTheme(theme: AppearanceThemeDefinition): () => void {
    return this.track(this.registry.registerTheme(theme));
  }
}

export const clientContributions = new ClientContributionRegistry();

export function useClientContributions(): ClientContributionsSnapshot {
  return useSyncExternalStore(clientContributions.subscribe, clientContributions.getSnapshot, clientContributions.getSnapshot);
}
