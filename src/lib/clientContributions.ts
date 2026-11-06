/**
 * Unified Client Contribution Registry (`ctx.contributions` / `@pid/client`).
 *
 * Replaces DSH's multi-tree slot bridge with a single reactive contribution
 * registry shared by PI-Desktop's own React tree and dynamic UI/theme/pet plugins.
 * All contribution types (`pages`, `leftSidebar`, `rightWorkbenchTabs`,
 * `bottomPanelTabs`, `topbarActions`, `composerToolbar`, `themes`, `pets`) are
 * equal, flat registrations returning a clean disposer `() => void` for HMR.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { Context, Service } from "@deepseek-ai/cordis";
import type { AppearancePetDefinition, AppearanceThemeDefinition } from "./appearanceCatalog";

declare module "@deepseek-ai/cordis" {
  interface Context {
    contributions: ClientContributionService;
  }
}

export interface WorkbenchSlotContext {
  cwd: string;
  sessionFile: string | null;
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

export interface ClientContributionsSnapshot {
  readonly pages: readonly ClientPageContribution[];
  readonly leftSidebar: readonly ClientSidebarSectionContribution[];
  readonly rightWorkbenchTabs: readonly ClientWorkbenchTabContribution[];
  readonly bottomPanelTabs: readonly ClientWorkbenchTabContribution[];
  readonly topbarActions: readonly ClientActionContribution[];
  readonly composerToolbar: readonly ClientActionContribution[];
  readonly themes: readonly AppearanceThemeDefinition[];
  readonly pets: readonly AppearancePetDefinition[];
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
  private readonly themes = new Map<string, AppearanceThemeDefinition>();
  private readonly pets = new Map<string, AppearancePetDefinition>();
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
      themes: [...this.themes.values()],
      pets: [...this.pets.values()],
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

  registerTheme(theme: AppearanceThemeDefinition): () => void {
    return this.insert(this.themes, { ...theme, scope: theme.scope ?? "user" });
  }

  registerPet(pet: AppearancePetDefinition): () => void {
    return this.insert(this.pets, { ...pet, scope: pet.scope ?? "user" });
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
    this.themes.clear();
    this.pets.clear();
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

  registerTheme(theme: AppearanceThemeDefinition): () => void {
    return this.track(this.registry.registerTheme(theme));
  }

  registerPet(pet: AppearancePetDefinition): () => void {
    return this.track(this.registry.registerPet(pet));
  }
}

export const clientContributions = new ClientContributionRegistry();

export function useClientContributions(): ClientContributionsSnapshot {
  return useSyncExternalStore(clientContributions.subscribe, clientContributions.getSnapshot);
}
