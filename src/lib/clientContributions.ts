/**
 * Unified Client Contribution Registry (`ctx.contributions` / `@qianji/client`).
 *
 * Replaces DSH's multi-tree slot bridge with a single reactive contribution
 * registry shared by Qianji's own React tree and dynamic UI/theme plugins.
 * Every contribution kind listed in `ClientContributionKinds` is a flat
 * registration returning an idempotent disposer `() => void` for HMR.
 * Contribution shapes live in `clientContributionTypes.ts`.
 */
import { useSyncExternalStore } from "react";
import { Context, Service } from "@deepseek-ai/cordis";
import { CLIENT_SLOT_CATALOG, type ClientSlotMetadata } from "@qianji/protocol";
import type { UiMessage } from "../types";
import type { AppearanceThemeDefinition } from "./appearanceCatalog";
import { injectPluginScopedStyle, recordClientRenderError, resolveContextPluginId } from "./clientPluginRuntime";
import type {
  AppearanceThemeInput,
  ClientActionContribution,
  ClientCodeBlockRendererContribution,
  ClientComposerStatusContribution,
  ClientContributionKind,
  ClientContributionKinds,
  ClientContributionsSnapshot,
  ClientFileViewerContribution,
  ClientHomeQuickActionContribution,
  ClientKeybindingContribution,
  ClientMenuItemContribution,
  ClientMessageActionContribution,
  ClientPageContribution,
  ClientRewindHandlerContribution,
  ClientSettingsPageContribution,
  ClientSettingsSectionContribution,
  ClientSidebarSectionContribution,
  ClientSlashInterceptorContribution,
  ClientStatusBarContribution,
  ClientToolRendererContribution,
  ClientWorkbenchTabContribution,
  WorkbenchSlotContext,
} from "./clientContributionTypes";

export type * from "./clientContributionTypes";

declare module "@deepseek-ai/cordis" {
  interface Context {
    contributions: ClientContributionService;
    styles: ClientStylesService;
  }
}

export { CLIENT_SLOT_CATALOG, type ClientSlotMetadata };

const CONTRIBUTION_KINDS = [
  "pages", "leftSidebar", "rightWorkbenchTabs", "bottomPanelTabs", "topbarActions", "composerToolbar",
  "composerStatus", "composerBanners", "overlays", "messageActions", "toolRenderers", "fileViewers",
  "statusBarItems", "homeQuickActions", "rewindHandlers", "slashInterceptors", "settingsPages",
  "settingsSections", "menuItems", "keybindings", "codeBlockRenderers", "themes",
] as const satisfies readonly ClientContributionKind[];

type ContributionMaps = { [K in ClientContributionKind]: Map<string, ClientContributionKinds[K]> };

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

/** Match the highest-priority registered `ClientCodeBlockRendererContribution` for a fence language. */
export function matchCodeBlockRenderer(
  renderers: readonly ClientCodeBlockRendererContribution[],
  language: string,
): ClientCodeBlockRendererContribution | undefined {
  const normalized = language.trim().toLowerCase();
  if (normalized === "") return undefined;
  return renderers.find((renderer) => renderer.languages.some((lang) => lang.trim().toLowerCase() === normalized));
}

export class ClientContributionRegistry {
  private readonly maps = Object.fromEntries(
    CONTRIBUTION_KINDS.map((kind) => [kind, new Map()]),
  ) as unknown as ContributionMaps;
  private readonly listeners = new Set<() => void>();
  private snapshot: ClientContributionsSnapshot = this.buildSnapshot();

  private buildSnapshot(): ClientContributionsSnapshot {
    const next: Partial<Record<ClientContributionKind, readonly unknown[]>> = {};
    for (const kind of CONTRIBUTION_KINDS) {
      const values = this.maps[kind].values() as Iterable<{ id: string; order?: number }>;
      // Themes keep registration order so the Appearance picker stays stable.
      next[kind] = kind === "themes" ? [...values] : sortByOrder(values);
    }
    return next as ClientContributionsSnapshot;
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  /** Register one contribution of `kind`; the returned disposer only removes this exact entry. */
  add<K extends ClientContributionKind>(kind: K, item: ClientContributionKinds[K]): () => void {
    const map = this.maps[kind];
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
    return this.add("pages", page);
  }

  registerLeftSidebar(section: ClientSidebarSectionContribution): () => void {
    return this.add("leftSidebar", section);
  }

  registerRightWorkbenchTab(tab: ClientWorkbenchTabContribution): () => void {
    return this.add("rightWorkbenchTabs", tab);
  }

  registerBottomPanelTab(tab: ClientWorkbenchTabContribution): () => void {
    return this.add("bottomPanelTabs", tab);
  }

  registerTopbarAction(action: ClientActionContribution): () => void {
    return this.add("topbarActions", action);
  }

  registerComposerToolbar(item: ClientActionContribution): () => void {
    return this.add("composerToolbar", item);
  }

  registerComposerStatus(item: ClientComposerStatusContribution): () => void {
    return this.add("composerStatus", item);
  }

  registerComposerBanner(item: ClientActionContribution): () => void {
    return this.add("composerBanners", item);
  }

  registerOverlay(item: ClientActionContribution): () => void {
    return this.add("overlays", item);
  }

  registerMessageAction(item: ClientMessageActionContribution): () => void {
    return this.add("messageActions", item);
  }

  registerToolRenderer(item: ClientToolRendererContribution): () => void {
    return this.add("toolRenderers", item);
  }

  registerFileViewer(item: ClientFileViewerContribution): () => void {
    return this.add("fileViewers", item);
  }

  registerStatusBarItem(item: ClientStatusBarContribution): () => void {
    return this.add("statusBarItems", item);
  }

  registerHomeQuickAction(item: ClientHomeQuickActionContribution): () => void {
    return this.add("homeQuickActions", item);
  }

  registerRewindHandler(handler: ClientRewindHandlerContribution): () => void {
    return this.add("rewindHandlers", handler);
  }

  registerSlashInterceptor(interceptor: ClientSlashInterceptorContribution): () => void {
    return this.add("slashInterceptors", interceptor);
  }

  registerSettingsPage(page: ClientSettingsPageContribution): () => void {
    return this.add("settingsPages", page);
  }

  registerSettingsSection(section: ClientSettingsSectionContribution): () => void {
    return this.add("settingsSections", section);
  }

  registerMenuItem(item: ClientMenuItemContribution): () => void {
    return this.add("menuItems", item);
  }

  registerKeybinding(binding: ClientKeybindingContribution): () => void {
    return this.add("keybindings", binding);
  }

  registerCodeBlockRenderer(renderer: ClientCodeBlockRendererContribution): () => void {
    return this.add("codeBlockRenderers", renderer);
  }

  registerTheme(theme: AppearanceThemeInput): () => void {
    const definition: AppearanceThemeDefinition = { ...theme, scope: theme.scope ?? "user" };
    return this.add("themes", definition);
  }

  findToolRenderer(toolName: string): ClientToolRendererContribution | undefined {
    return matchToolRenderer(this.snapshot.toolRenderers, toolName);
  }

  findFileViewer(file: { path: string; mimeType?: string }): ClientFileViewerContribution | undefined {
    return matchFileViewer(this.snapshot.fileViewers, file);
  }

  findCodeBlockRenderer(language: string): ClientCodeBlockRendererContribution | undefined {
    return matchCodeBlockRenderer(this.snapshot.codeBlockRenderers, language);
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

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ClientContributionsSnapshot => this.snapshot;

  clear(): void {
    for (const kind of CONTRIBUTION_KINDS) this.maps[kind].clear();
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

  /** Tag `item` with the calling plugin and tie its disposer to the plugin's Cordis Fiber. */
  private add<K extends Exclude<ClientContributionKind, "themes">>(kind: K, item: ClientContributionKinds[K]): () => void {
    const pluginId = item.pluginId ?? resolveContextPluginId(this.ctx);
    const tagged = pluginId === undefined || item.pluginId !== undefined ? item : { ...item, pluginId };
    return this.track(this.registry.add(kind, tagged));
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
    return this.add("pages", page);
  }

  registerLeftSidebar(section: ClientSidebarSectionContribution): () => void {
    return this.add("leftSidebar", section);
  }

  registerRightWorkbenchTab(tab: ClientWorkbenchTabContribution): () => void {
    return this.add("rightWorkbenchTabs", tab);
  }

  registerBottomPanelTab(tab: ClientWorkbenchTabContribution): () => void {
    return this.add("bottomPanelTabs", tab);
  }

  registerTopbarAction(action: ClientActionContribution): () => void {
    return this.add("topbarActions", action);
  }

  registerComposerToolbar(item: ClientActionContribution): () => void {
    return this.add("composerToolbar", item);
  }

  registerComposerStatus(item: ClientComposerStatusContribution): () => void {
    return this.add("composerStatus", item);
  }

  registerComposerBanner(item: ClientActionContribution): () => void {
    return this.add("composerBanners", item);
  }

  registerOverlay(item: ClientActionContribution): () => void {
    return this.add("overlays", item);
  }

  registerMessageAction(item: ClientMessageActionContribution): () => void {
    return this.add("messageActions", item);
  }

  registerToolRenderer(item: ClientToolRendererContribution): () => void {
    return this.add("toolRenderers", item);
  }

  registerFileViewer(item: ClientFileViewerContribution): () => void {
    return this.add("fileViewers", item);
  }

  registerStatusBarItem(item: ClientStatusBarContribution): () => void {
    return this.add("statusBarItems", item);
  }

  registerHomeQuickAction(item: ClientHomeQuickActionContribution): () => void {
    return this.add("homeQuickActions", item);
  }

  registerRewindHandler(handler: ClientRewindHandlerContribution): () => void {
    return this.add("rewindHandlers", handler);
  }

  registerSlashInterceptor(interceptor: ClientSlashInterceptorContribution): () => void {
    return this.add("slashInterceptors", interceptor);
  }

  registerSettingsPage(page: ClientSettingsPageContribution): () => void {
    return this.add("settingsPages", page);
  }

  registerSettingsSection(section: ClientSettingsSectionContribution): () => void {
    return this.add("settingsSections", section);
  }

  registerMenuItem(item: ClientMenuItemContribution): () => void {
    return this.add("menuItems", item);
  }

  registerKeybinding(binding: ClientKeybindingContribution): () => void {
    return this.add("keybindings", binding);
  }

  registerCodeBlockRenderer(renderer: ClientCodeBlockRendererContribution): () => void {
    return this.add("codeBlockRenderers", renderer);
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
