/**
 * Narrow bridge from `@qianji/client` actions to shell navigation owned by
 * `App.tsx` (Settings visibility and the main-stage hub view).
 *
 * The shell binds it once on mount; SDK calls made before that, or after
 * unmount, are reported as `false` instead of throwing.
 */
import type { BuiltinSettingsPageId } from "./clientContributionTypes";

/** A Settings category: built-in, or `plugin:<id>` for a page from `registerSettingsPage`. */
export type SettingsPageId = BuiltinSettingsPageId | `plugin:${string}`;

export const BUILTIN_SETTINGS_PAGES: readonly BuiltinSettingsPageId[] = ["general", "appearance", "providers", "plugins"];

export function isBuiltinSettingsPage(value: string): value is BuiltinSettingsPageId {
  return (BUILTIN_SETTINGS_PAGES as readonly string[]).includes(value);
}

/** Accepts a built-in id, a plugin settings page id, or an already-prefixed `plugin:<id>`. */
export function resolveSettingsPageId(page?: string): SettingsPageId {
  const trimmed = page?.trim() ?? "";
  if (trimmed === "") return "general";
  if (isBuiltinSettingsPage(trimmed)) return trimmed;
  return trimmed.startsWith("plugin:") ? (trimmed as `plugin:${string}`) : `plugin:${trimmed}`;
}

/** Id of the plugin page behind a `plugin:<id>` settings page, else `undefined`. */
export function pluginSettingsPageId(page: string): string | undefined {
  return page.startsWith("plugin:") ? page.slice("plugin:".length) : undefined;
}

export interface ShellNavigationBridge {
  openSettings: (page: SettingsPageId) => void;
  /** Show a page registered with `ctx.contributions.registerPage` in the main stage. */
  openHubPage: (pageId: string) => void;
}

let currentBridge: ShellNavigationBridge | null = null;

export function bindShellNavigation(bridge: ShellNavigationBridge): () => void {
  currentBridge = bridge;
  return () => {
    if (currentBridge === bridge) currentBridge = null;
  };
}

export function requestOpenSettings(page?: string): boolean {
  if (!currentBridge) return false;
  currentBridge.openSettings(resolveSettingsPageId(page));
  return true;
}

export function requestOpenHubPage(pageId: string): boolean {
  const trimmed = pageId.trim();
  if (!currentBridge || trimmed === "") return false;
  currentBridge.openHubPage(trimmed.startsWith("plugin:") ? trimmed.slice("plugin:".length) : trimmed);
  return true;
}
