import type { NavigationTarget as BaseNavigationTarget } from "../../lib/navigationHistory";

export type HubView = "sites" | "scheduled" | `plugin:${string}`;
/** "tools" only appears while a plugin registers a `menubar.tools` item. */
export type AppMenu = "file" | "edit" | "view" | "help" | "tools";
export type NavigationTarget = BaseNavigationTarget<HubView>;
