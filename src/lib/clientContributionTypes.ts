/**
 * Contribution shapes accepted by `ctx.contributions.*` (`@qianji/client`).
 *
 * Kept apart from the registry in `clientContributions.ts` so the registry
 * stays small and the offline declarations emitted by
 * `scripts/generate-plugin-types.mjs` have one place to mirror.
 */
import type { ReactNode } from "react";
import type { UiMessage, UiToolCall } from "../types";
import type { AppearanceScope, AppearanceThemeDefinition } from "./appearanceCatalog";

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

/** Built-in Settings categories; each one also accepts plugin `settings.sections`. */
export type BuiltinSettingsPageId = "general" | "appearance" | "providers" | "plugins";

export interface SettingsSlotContext extends WorkbenchSlotContext {
  /** Settings page on screen: a built-in id, or `plugin:<id>` for a plugin settings page. */
  page: string;
  closeSettings: () => void;
}

export interface CodeBlockRendererSlotContext extends WorkbenchSlotContext {
  /** Lower-cased fence language (```` ```plantuml ```` → `"plantuml"`). */
  language: string;
  code: string;
}

/** Right-click menu on a workspace file path (transcript links, tool cards, file lists). */
export interface FileMenuContext extends WorkbenchSlotContext {
  /** Path as it was shown (often workspace-relative). */
  path: string;
  absolutePath: string;
  line?: number;
}

/** "…" menu on a project group in the primary sidebar. */
export interface ProjectMenuContext {
  workspace: string;
  sessionFiles: readonly string[];
}

/** Right-click menu on a session row in the primary sidebar. */
export interface SessionMenuContext {
  /** Workspace the session belongs to (not necessarily the active one). */
  cwd: string;
  sessionFile: string;
  title: string;
}

/** Every menu that accepts plugin items, mapped to the context its callbacks receive. */
export interface ClientMenuContextMap {
  "menubar.file": WorkbenchSlotContext;
  "menubar.edit": WorkbenchSlotContext;
  "menubar.view": WorkbenchSlotContext;
  "menubar.help": WorkbenchSlotContext;
  /** Extra top-level "工具" menu, shown only while it has items. */
  "menubar.tools": WorkbenchSlotContext;
  /** Thread title "…" menu in the stage top bar. */
  "thread.more": WorkbenchSlotContext;
  "sidebar.project": ProjectMenuContext;
  "sidebar.thread": SessionMenuContext;
  "file.context": FileMenuContext;
}

export type ClientMenuLocation = keyof ClientMenuContextMap;

export interface ClientMenuItemFor<L extends ClientMenuLocation> {
  id: string;
  pluginId?: string;
  location: L;
  label: string;
  icon?: ReactNode;
  /** Shortcut hint shown next to the label. Register a keybinding to make it work. */
  shortcut?: string;
  order?: number;
  danger?: boolean;
  /** Hide the item for this context. */
  when?: (context: ClientMenuContextMap[L]) => boolean;
  /** Show the item greyed out for this context. */
  disabled?: (context: ClientMenuContextMap[L]) => boolean;
  onSelect: (context: ClientMenuContextMap[L]) => void | Promise<void>;
}

export type ClientMenuItemContribution = { [L in ClientMenuLocation]: ClientMenuItemFor<L> }[ClientMenuLocation];

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

/** A category in the Settings navigation, listed after the built-in ones. */
export interface ClientSettingsPageContribution {
  id: string;
  pluginId?: string;
  label: string;
  icon?: ReactNode;
  /** Page title; defaults to `label`. */
  heading?: string;
  subtitle?: string;
  order?: number;
  /** Use the wide content column (like the built-in Plugins page). */
  wide?: boolean;
  render: (context: SettingsSlotContext) => ReactNode;
}

/** A card appended to a built-in Settings page or to a plugin settings page. */
export interface ClientSettingsSectionContribution {
  id: string;
  pluginId?: string;
  /** A built-in page id, or the `id` of a page registered with `registerSettingsPage`. */
  page: BuiltinSettingsPageId | (string & {});
  title?: string;
  order?: number;
  render: (context: SettingsSlotContext) => ReactNode;
}

export interface ClientKeybindingContribution {
  id: string;
  pluginId?: string;
  /** Chord such as `"Ctrl+Shift+K"`, `"Alt+F2"` or `"F6"`; `Cmd`/`Meta` count as `Ctrl`. */
  key: string;
  /** Human-readable description, for listings. */
  label?: string;
  order?: number;
  /** Also fire while focus is in a text field, the code editor or the terminal. Default `false`. */
  allowInEditable?: boolean;
  run: (context: WorkbenchSlotContext) => void | Promise<void>;
}

export interface ClientCodeBlockRendererContribution {
  id: string;
  pluginId?: string;
  /** Fence languages handled by this renderer, matched case-insensitively (e.g. `["plantuml", "puml"]`). */
  languages: readonly string[];
  order?: number;
  render: (context: CodeBlockRendererSlotContext) => ReactNode;
}

export type AppearanceThemeInput = Omit<AppearanceThemeDefinition, "scope"> & {
  scope?: AppearanceScope;
};

/** Registry contents by kind; each list is sorted by `order` then `id` (themes keep insertion order). */
export interface ClientContributionKinds {
  pages: ClientPageContribution;
  leftSidebar: ClientSidebarSectionContribution;
  rightWorkbenchTabs: ClientWorkbenchTabContribution;
  bottomPanelTabs: ClientWorkbenchTabContribution;
  topbarActions: ClientActionContribution;
  composerToolbar: ClientActionContribution;
  composerStatus: ClientComposerStatusContribution;
  composerBanners: ClientActionContribution;
  overlays: ClientActionContribution;
  messageActions: ClientMessageActionContribution;
  toolRenderers: ClientToolRendererContribution;
  fileViewers: ClientFileViewerContribution;
  statusBarItems: ClientStatusBarContribution;
  homeQuickActions: ClientHomeQuickActionContribution;
  rewindHandlers: ClientRewindHandlerContribution;
  slashInterceptors: ClientSlashInterceptorContribution;
  settingsPages: ClientSettingsPageContribution;
  settingsSections: ClientSettingsSectionContribution;
  menuItems: ClientMenuItemContribution;
  keybindings: ClientKeybindingContribution;
  codeBlockRenderers: ClientCodeBlockRendererContribution;
  themes: AppearanceThemeDefinition;
}

export type ClientContributionKind = keyof ClientContributionKinds;

export type ClientContributionsSnapshot = {
  readonly [K in ClientContributionKind]: readonly ClientContributionKinds[K][];
};
