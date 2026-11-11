// Generate offline zero-dependency TypeScript declarations (`plugin-types/`)
// for external Qianji plugins (`@qianji/client`, `@qianji/protocol`,
// `@qianji/tools`, `@deepseek-ai/cordis`, `react`, `lucide-react`,
// `dsh-better-sidebar`) so workspace plugins pass `tsc --noEmit` without
// installing npm dependencies.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function writePkgDts(baseDir, pkgName, content) {
  const dir = join(baseDir, ...pkgName.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.d.ts"), content, "utf8");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: pkgName, version: "0.0.0-qianji", types: "./index.d.ts" }, null, 2)}\n`,
    "utf8",
  );
}

function emitTsDeclarations({ entryFile, rootDir, outDir, paths = {} }) {
  mkdirSync(outDir, { recursive: true });
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
    skipLibCheck: true,
    strict: true,
    jsx: ts.JsxEmit.ReactJSX,
    rootDir,
    outDir,
    baseUrl: defaultRepoRoot,
    paths,
  };
  const program = ts.createProgram([entryFile], options);
  program.emit();
}

const REACT_INDEX_DTS = `export type Key = string | number | bigint;
export type ReactNode =
  | ReactElement
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Iterable<ReactNode>;

export interface ReactElement<P = any, T = any> {
  type: T;
  props: P;
  key: string | null;
}

export type CSSProperties = Record<string, string | number | undefined>;
export type FC<P = {}> = (props: P) => ReactNode;
export type ComponentType<P = {}> = ((props: P) => ReactNode) | (new (props: P) => any);

export interface RefObject<T> {
  readonly current: T | null;
}

export interface HTMLAttributes<T = Element> {
  id?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  role?: string;
  tabIndex?: number;
  children?: ReactNode;
  dangerouslySetInnerHTML?: { __html: string };
  onClick?: (event: any) => void;
  onDoubleClick?: (event: any) => void;
  onMouseEnter?: (event: any) => void;
  onMouseLeave?: (event: any) => void;
  onPointerDown?: (event: any) => void;
  onKeyDown?: (event: any) => void;
  onKeyUp?: (event: any) => void;
  onFocus?: (event: any) => void;
  onBlur?: (event: any) => void;
  onChange?: (event: any) => void;
  onInput?: (event: any) => void;
  onSubmit?: (event: any) => void;
  [dataOrAriaAttr: string]: any;
}

export interface ButtonHTMLAttributes<T = HTMLButtonElement> extends HTMLAttributes<T> {
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
}

export interface InputHTMLAttributes<T = HTMLInputElement> extends HTMLAttributes<T> {
  type?: string;
  value?: string | number | readonly string[];
  defaultValue?: string | number;
  checked?: boolean;
  defaultChecked?: boolean;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  min?: number | string;
  max?: number | string;
  step?: number | string;
}

export interface SelectHTMLAttributes<T = HTMLSelectElement> extends HTMLAttributes<T> {
  value?: string | number | readonly string[];
  defaultValue?: string | number;
  disabled?: boolean;
}

export interface TextareaHTMLAttributes<T = HTMLTextAreaElement> extends HTMLAttributes<T> {
  value?: string;
  defaultValue?: string;
  rows?: number;
  cols?: number;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  spellCheck?: boolean;
}

export type ChangeEvent<T = Element> = { target: T; currentTarget: T; preventDefault(): void };
export type FormEvent<T = Element> = { target: T; currentTarget: T; preventDefault(): void };
export type MouseEvent<T = Element> = {
  target: EventTarget | null;
  currentTarget: T;
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
};
export type KeyboardEvent<T = Element> = {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
};

export function useState<S>(initialState: S | (() => S)): [S, (value: S | ((prev: S) => S)) => void];
export function useState<S = undefined>(): [S | undefined, (value: S | undefined | ((prev: S | undefined) => S | undefined)) => void];
export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly unknown[]): T;
export function useRef<T>(initialValue: T): { current: T };
export function useRef<T>(initialValue: T | null): RefObject<T>;
export function useId(): string;
export function useSyncExternalStore<Snapshot>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot?: () => Snapshot,
): Snapshot;
export function createElement(type: any, props?: any, ...children: ReactNode[]): ReactElement;
export const Fragment: unique symbol;

export declare namespace JSX {
  type Element = ReactElement;
  type ElementType = string | ((props: any) => ReactNode) | (new (props: any) => any);
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicAttributes {
    key?: Key | null;
  }
  interface IntrinsicElements {
    div: HTMLAttributes<HTMLDivElement>;
    span: HTMLAttributes<HTMLSpanElement>;
    p: HTMLAttributes<HTMLParagraphElement>;
    section: HTMLAttributes<HTMLElement>;
    article: HTMLAttributes<HTMLElement>;
    header: HTMLAttributes<HTMLElement>;
    footer: HTMLAttributes<HTMLElement>;
    main: HTMLAttributes<HTMLElement>;
    aside: HTMLAttributes<HTMLElement>;
    nav: HTMLAttributes<HTMLElement>;
    h1: HTMLAttributes<HTMLHeadingElement>;
    h2: HTMLAttributes<HTMLHeadingElement>;
    h3: HTMLAttributes<HTMLHeadingElement>;
    h4: HTMLAttributes<HTMLHeadingElement>;
    ul: HTMLAttributes<HTMLUListElement>;
    ol: HTMLAttributes<HTMLOListElement>;
    li: HTMLAttributes<HTMLLIElement>;
    button: ButtonHTMLAttributes<HTMLButtonElement>;
    input: InputHTMLAttributes<HTMLInputElement>;
    select: SelectHTMLAttributes<HTMLSelectElement>;
    option: HTMLAttributes<HTMLOptionElement> & { value?: string | number; disabled?: boolean };
    textarea: TextareaHTMLAttributes<HTMLTextAreaElement>;
    label: HTMLAttributes<HTMLLabelElement> & { htmlFor?: string };
    form: HTMLAttributes<HTMLFormElement>;
    code: HTMLAttributes<HTMLElement>;
    pre: HTMLAttributes<HTMLPreElement>;
    strong: HTMLAttributes<HTMLElement>;
    em: HTMLAttributes<HTMLElement>;
    small: HTMLAttributes<HTMLElement>;
    a: HTMLAttributes<HTMLAnchorElement> & { href?: string; target?: string; rel?: string };
    img: HTMLAttributes<HTMLImageElement> & { src?: string; alt?: string; width?: number | string; height?: number | string };
    table: HTMLAttributes<HTMLTableElement>;
    thead: HTMLAttributes<HTMLTableSectionElement>;
    tbody: HTMLAttributes<HTMLTableSectionElement>;
    tr: HTMLAttributes<HTMLTableRowElement>;
    th: HTMLAttributes<HTMLTableCellElement>;
    td: HTMLAttributes<HTMLTableCellElement>;
    svg: HTMLAttributes<SVGSVGElement> & Record<string, any>;
    path: Record<string, any>;
    circle: Record<string, any>;
    rect: Record<string, any>;
    line: Record<string, any>;
    [tagName: string]: any;
  }
}

declare const ReactDefault: {
  createElement: typeof createElement;
  Fragment: typeof Fragment;
  useState: typeof useState;
  useEffect: typeof useEffect;
  useLayoutEffect: typeof useLayoutEffect;
  useMemo: typeof useMemo;
  useCallback: typeof useCallback;
  useRef: typeof useRef;
  useId: typeof useId;
  useSyncExternalStore: typeof useSyncExternalStore;
};
export default ReactDefault;
`;

const REACT_JSX_RUNTIME_DTS = `import type { JSX as ReactJSX, Key, ReactElement } from "./index.js";
export { Fragment } from "./index.js";
export namespace JSX {
  export type Element = ReactJSX.Element;
  export type ElementType = ReactJSX.ElementType;
  export type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute;
  export type IntrinsicAttributes = ReactJSX.IntrinsicAttributes;
  export type IntrinsicElements = ReactJSX.IntrinsicElements;
}
export function jsx(type: any, props: unknown, key?: Key): ReactElement;
export function jsxs(type: any, props: unknown, key?: Key): ReactElement;
export function jsxDEV(
  type: any,
  props: unknown,
  key?: Key,
  isStaticChildren?: boolean,
  source?: unknown,
  self?: unknown,
): ReactElement;
`;

const LUCIDE_REACT_DTS = `import type { CSSProperties, ReactElement } from "react";
export interface LucideProps {
  size?: number | string;
  color?: string;
  strokeWidth?: number | string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  "aria-hidden"?: boolean | "true" | "false";
  [key: string]: unknown;
}
export type LucideIcon = (props: LucideProps) => ReactElement | null;
export const AlertTriangle: LucideIcon;
export const Activity: LucideIcon;
export const ArrowRight: LucideIcon;
export const Blocks: LucideIcon;
export const Check: LucideIcon;
export const ChevronDown: LucideIcon;
export const ChevronRight: LucideIcon;
export const Code2: LucideIcon;
export const Copy: LucideIcon;
export const Database: LucideIcon;
export const ExternalLink: LucideIcon;
export const Eye: LucideIcon;
export const FileCode2: LucideIcon;
export const FileText: LucideIcon;
export const Folder: LucideIcon;
export const Globe: LucideIcon;
export const History: LucideIcon;
export const Info: LucideIcon;
export const Layers: LucideIcon;
export const LoaderCircle: LucideIcon;
export const Play: LucideIcon;
export const Plus: LucideIcon;
export const RefreshCw: LucideIcon;
export const RotateCcw: LucideIcon;
export const Search: LucideIcon;
export const Settings2: LucideIcon;
export const Sparkles: LucideIcon;
export const Terminal: LucideIcon;
export const Trash2: LucideIcon;
export const Wrench: LucideIcon;
export const X: LucideIcon;
export const Zap: LucideIcon;
`;

const CORDIS_HOST_AND_CLIENT_AUGMENTATION = `
import type { ToolDefinition, ToolOutput } from "@qianji/tools";
import type {
  ClientContributionService,
  ClientStylesService,
} from "@qianji/client";

export interface HostToolsService {
  register<P extends Record<string, unknown> = Record<string, unknown>>(tool: ToolDefinition<P>): () => void;
  get(name: string): ToolDefinition | undefined;
  listDefinitions(): ToolDefinition[];
  schemas(sessionId?: string): Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  execute(
    call: { id: string; name: string; args: Record<string, unknown> },
    env: { sessionId: string; cwd: string; signal: AbortSignal },
  ): Promise<ToolOutput>;
}

export interface CommandEnv {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
}

export interface CommandResult {
  output?: string;
  prompt?: string;
  clientAction?: string;
  isError?: boolean;
}

export interface HostCommandDefinition {
  name: string;
  description: string;
  argsHint?: string;
  source?: string;
  execute(args: string, env: CommandEnv): Promise<CommandResult> | CommandResult;
}

export interface HostCommandsService {
  register(command: HostCommandDefinition): () => void;
  registerProvider(provider: (cwd?: string) => Iterable<HostCommandDefinition>): () => void;
  list(cwd?: string): Array<{ name: string; description: string; argsHint?: string; source?: string }>;
}

export interface PromptEnv {
  sessionId: string;
  cwd: string;
  model: { provider: string; model: string; contextWindow?: number };
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  agentMode?: "agent" | "plan" | "ask";
  signal?: AbortSignal;
}

export interface HostSystemPromptService {
  section(
    id: string,
    render: (env: PromptEnv) => string | undefined | Promise<string | undefined>,
    options?: { order?: number },
  ): () => void;
  build(env: PromptEnv): Promise<string>;
}

export interface RpcCall {
  signal: AbortSignal;
  clientId?: string;
}

export interface HostRpcService {
  method<P = unknown, R = unknown>(name: string, handler: (params: P, call: RpcCall) => Promise<R> | R): () => void;
  methods(): string[];
  broadcast(method: string, params?: unknown): void;
}

export interface WebRouteRequestLike {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface WebRouteResponseLike {
  statusCode: number;
  writeHead(statusCode: number, headers?: Record<string, string | number | readonly string[]>): this;
  setHeader(name: string, value: string | number | readonly string[]): this;
  end(chunk?: unknown): this;
}

export interface WebRoute {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: WebRouteRequestLike, res: WebRouteResponseLike) => void | Promise<void>;
}

export interface WebUpgradeRoute {
  path: string;
  handler: (req: WebRouteRequestLike, socket: unknown, head: unknown) => void | Promise<void>;
}

export interface HostWebServerService {
  register(route: WebRoute): () => void;
  registerUpgrade(route: WebUpgradeRoute): () => void;
}

export interface BetterSidebarService {
  readonly version: string;
  registerTab(descriptor: {
    id: string;
    title?: string | (() => string);
    label?: string;
    icon?: unknown;
    order?: number;
    bottomOnly?: boolean;
    component?: (props: Record<string, unknown>) => unknown;
    render?: (props: Record<string, unknown>) => unknown;
  }): () => void;
  registerFileViewer(descriptor: {
    id: string;
    title?: string | (() => string);
    label?: string;
    extensions?: readonly string[];
    mimeTypes?: readonly string[];
    order?: number;
    component?: (props: Record<string, unknown>) => unknown;
    render?: (props: Record<string, unknown>) => unknown;
  }): () => void;
  openFile(scope: { cwd?: string } | undefined, path: string): void;
  openTab(seed: { type?: string; id?: string; path?: string }, scope?: { cwd?: string }): void;
}

export interface Context {
  tools: HostToolsService;
  commands: HostCommandsService;
  systemPrompt: HostSystemPromptService;
  rpc: HostRpcService;
  webServer: HostWebServerService;
  contributions: ClientContributionService;
  styles: ClientStylesService;
  betterSidebar: BetterSidebarService;
}
`;

export function generatePluginTypes({
  repoRoot = defaultRepoRoot,
  targetDir = join(repoRoot, "src-tauri", "resources", "harness", "plugin-types"),
} = {}) {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  // 1. Emit real `.d.ts` from `@qianji/protocol` and `@qianji/tools`.
  emitTsDeclarations({
    entryFile: join(repoRoot, "packages", "protocol", "src", "index.ts"),
    rootDir: join(repoRoot, "packages", "protocol", "src"),
    outDir: join(targetDir, "@qianji", "protocol"),
  });
  writeFileSync(
    join(targetDir, "@qianji", "protocol", "package.json"),
    `${JSON.stringify({ name: "@qianji/protocol", version: "0.0.0-qianji", types: "./index.d.ts" }, null, 2)}\n`,
    "utf8",
  );
  writePkgDts(targetDir, "@pid/protocol", 'export * from "@qianji/protocol";\n');

  emitTsDeclarations({
    entryFile: join(repoRoot, "packages", "tools", "src", "index.ts"),
    rootDir: join(repoRoot, "packages", "tools", "src"),
    outDir: join(targetDir, "@qianji", "tools"),
    paths: {
      "@deepseek-ai/cordis": ["./src/types/cordis.d.ts"],
    },
  });
  writeFileSync(
    join(targetDir, "@qianji", "tools", "package.json"),
    `${JSON.stringify({ name: "@qianji/tools", version: "0.0.0-qianji", types: "./index.d.ts" }, null, 2)}\n`,
    "utf8",
  );

  // 2. Emit `@deepseek-ai/cordis` & `cordis` with merged Host + Client Context services.
  const baseCordisDts = readFileSync(join(repoRoot, "src", "types", "cordis.d.ts"), "utf8");
  const fullCordisDts = `${baseCordisDts}\n${CORDIS_HOST_AND_CLIENT_AUGMENTATION}\n`;
  writePkgDts(targetDir, "@deepseek-ai/cordis", fullCordisDts);
  writePkgDts(targetDir, "cordis", 'export * from "@deepseek-ai/cordis";\n');

  // 3. Emit standalone `@qianji/client` public SDK declarations (free of internal zustand dependencies).
  const clientSdkDts = `import type { ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";

export interface WorkbenchSlotContext {
  cwd: string;
  sessionFile: string | null;
  variant?: "task-start" | "follow-up";
}

export interface UiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  running?: boolean;
  startedAt?: number;
  endedAt?: number;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant" | "terminal" | "notice";
  content: string;
  timestamp: number;
  thinking?: string;
  isError?: boolean;
  isStreaming?: boolean;
  toolCalls?: UiToolCall[];
}

export interface AttachmentPayload {
  name?: string;
  mimeType: string;
  data: string;
}

export interface SessionStats {
  cost?: number;
  tokens: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
  };
  contextUsage?: {
    tokens: number;
    contextWindow: number;
    percent: number;
  };
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
  toolNames: readonly string[];
  order?: number;
  render: (context: ToolRendererSlotContext) => ReactNode;
}

export interface ClientFileViewerContribution {
  id: string;
  pluginId?: string;
  label?: string;
  extensions?: readonly string[];
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

export type AppearanceScope = "builtin" | "user" | "workspace";

export interface ThemePalette {
  app?: string;
  canvas?: string;
  sidebar?: string;
  panel?: string;
  panelSoft?: string;
  panelStrong?: string;
  hover?: string;
  active?: string;
  border?: string;
  borderStrong?: string;
  text?: string;
  text2?: string;
  text3?: string;
  accent?: string;
  accentSoft?: string;
  accentContrast?: string;
  success?: string;
  warning?: string;
  danger?: string;
  info?: string;
  codeBg?: string;
  fontUi?: string;
  fontCode?: string;
  shadowSm?: string;
  shadowMd?: string;
  shadowLg?: string;
}

export interface AppearanceThemeDefinition {
  id: string;
  label: string;
  mode: "system" | "light" | "dark";
  scope: AppearanceScope;
  sourcePath?: string;
  palette?: ThemePalette;
}

export type AppearanceThemeInput = Omit<AppearanceThemeDefinition, "scope"> & {
  scope?: AppearanceScope;
};

export interface ClientSlotMetadata {
  readonly name: string;
  readonly slot: string;
  readonly method: string;
  readonly registerMethod: string;
  readonly summary: string;
  readonly options: readonly string[];
  readonly contextFields: readonly string[];
  readonly contextProps: readonly string[];
  readonly note?: string;
}

export declare const CLIENT_SLOT_CATALOG: readonly ClientSlotMetadata[];

export interface ClientContributionService {
  registerPage(page: ClientPageContribution): () => void;
  registerLeftSidebar(section: ClientSidebarSectionContribution): () => void;
  registerRightWorkbenchTab(tab: ClientWorkbenchTabContribution): () => void;
  registerBottomPanelTab(tab: ClientWorkbenchTabContribution): () => void;
  registerTopbarAction(action: ClientActionContribution): () => void;
  registerComposerToolbar(item: ClientActionContribution): () => void;
  registerComposerStatus(item: ClientComposerStatusContribution): () => void;
  registerComposerBanner(item: ClientActionContribution): () => void;
  registerOverlay(item: ClientActionContribution): () => void;
  registerMessageAction(item: ClientMessageActionContribution): () => void;
  registerToolRenderer(item: ClientToolRendererContribution): () => void;
  registerFileViewer(item: ClientFileViewerContribution): () => void;
  registerStatusBarItem(item: ClientStatusBarContribution): () => void;
  registerHomeQuickAction(item: ClientHomeQuickActionContribution): () => void;
  registerRewindHandler(handler: ClientRewindHandlerContribution): () => void;
  registerSlashInterceptor(interceptor: ClientSlashInterceptorContribution): () => void;
  registerTheme(theme: AppearanceThemeInput): () => void;
}

export interface ClientStylesService {
  inject(css: string, key?: string): () => void;
}

export interface ActiveSessionModelSummary {
  provider: string;
  id: string;
  contextWindow?: number;
}

export interface ActiveSessionSnapshot {
  sessionId: string | null;
  sessionFile: string | null;
  cwd: string;
  isStreaming: boolean;
  isCompacting: boolean;
  model: ActiveSessionModelSummary | null;
  stats: SessionStats | null;
  messageCount: number;
}

export interface ActiveWorkspaceSnapshot {
  cwd: string;
  connected: boolean;
  hostConnected: boolean;
}

export interface AppearanceThemeSnapshot {
  themeId: string;
  resolvedScheme: "light" | "dark";
  accentColor: string;
}

export interface HostRpcQueryOptions {
  enabled?: boolean;
  refreshIntervalMs?: number;
}

export interface HostRpcQueryResult<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refetch: () => Promise<void>;
}

export interface SendChatPromptOptions {
  prefillOnly?: boolean;
  attachments?: AttachmentPayload[];
  behavior?: "steer" | "followUp";
}

export declare function getActiveSessionSnapshot(): ActiveSessionSnapshot;
export declare function subscribeSessionActivity(listener: (snapshot: ActiveSessionSnapshot) => void): () => void;
export declare function useActiveSession(): ActiveSessionSnapshot;
export declare function useActiveWorkspace(): ActiveWorkspaceSnapshot;
export declare function useAppearanceTheme(): AppearanceThemeSnapshot;
export declare function usePluginConfig<T extends object = Record<string, unknown>>(
  pluginId: string,
  fallback?: T,
): T;
export declare function useHostRpcQuery<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  options?: HostRpcQueryOptions,
): HostRpcQueryResult<T>;

export declare function callHostRpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
export declare function openWorkbenchTab(target: string): void;
export declare function openWorkspaceFile(path: string, line?: number): Promise<void>;
export declare function sendChatPrompt(text: string, options?: SendChatPromptOptions): Promise<boolean>;
export declare function showToast(message: string, kind?: "info" | "success" | "warning" | "error"): void;
export declare function useClientContributions(): Record<string, readonly unknown[]>;
export declare const clientContributions: ClientContributionService;
export type ClientPluginApply<C = Record<string, unknown>> = (ctx: Context, config: C) => void;
`;
  writePkgDts(targetDir, "@qianji/client", clientSdkDts);
  writePkgDts(targetDir, "@pid/client", 'export * from "@qianji/client";\n');

  // 4. Emit zero-dependency React, JSX runtime, Lucide icons, and dsh-better-sidebar shim types.
  writePkgDts(targetDir, "react", REACT_INDEX_DTS);
  writeFileSync(join(targetDir, "react", "jsx-runtime.d.ts"), REACT_JSX_RUNTIME_DTS, "utf8");
  writeFileSync(join(targetDir, "react", "jsx-dev-runtime.d.ts"), REACT_JSX_RUNTIME_DTS, "utf8");
  writePkgDts(targetDir, "lucide-react", LUCIDE_REACT_DTS);
  writePkgDts(
    targetDir,
    "dsh-better-sidebar",
    `import type { BetterSidebarService } from "@deepseek-ai/cordis";
export type { BetterSidebarService };
export declare const SIDEBAR_SERVICE_VERSION: string;
`,
  );
  writePkgDts(targetDir, "dsh-better-sidebar/client", 'export * from "dsh-better-sidebar";\n');

  // 5. Emit a base tsconfig preset external plugins can `extends` or reference via `paths`.
  writeFileSync(
    join(targetDir, "tsconfig.plugin.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          baseUrl: ".",
          paths: {
            "react/jsx-runtime": ["./react/jsx-runtime.d.ts"],
            "react/jsx-dev-runtime": ["./react/jsx-dev-runtime.d.ts"],
            "*": ["./*/index.d.ts", "./*"],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return targetDir;
}

export function syncBundledPluginAssets(repoRoot = defaultRepoRoot) {
  const outputDir = join(repoRoot, "src-tauri", "resources", "harness");
  mkdirSync(outputDir, { recursive: true });

  const bundledPluginsSource = join(repoRoot, "plugins");
  const bundledPluginsTarget = join(outputDir, "bundled-plugins");
  if (existsSync(bundledPluginsSource)) {
    rmSync(bundledPluginsTarget, { recursive: true, force: true });
    cpSync(bundledPluginsSource, bundledPluginsTarget, { recursive: true });
  }

  const bundledSkillsSource = join(repoRoot, "skills");
  const bundledSkillsTarget = join(outputDir, "bundled-skills");
  if (existsSync(bundledSkillsSource)) {
    rmSync(bundledSkillsTarget, { recursive: true, force: true });
    cpSync(bundledSkillsSource, bundledSkillsTarget, { recursive: true });
  }

  generatePluginTypes({ repoRoot, targetDir: join(outputDir, "plugin-types") });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = generatePluginTypes();
  console.log(`Generated Qianji offline plugin types: ${target}`);
}
