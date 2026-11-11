import type { NavigationTarget as BaseNavigationTarget } from "../../lib/navigationHistory";

export type HubView = "sites" | "scheduled" | `plugin:${string}`;
export type AppMenu = "file" | "edit" | "view" | "help";
export type NavigationTarget = BaseNavigationTarget<HubView>;
