/**
 * Authoritative shared metadata catalog of Qianji client extension slots and
 * `@qianji/client` SDK exports, consumed by both the React renderer
 * (`src/lib/clientContributions.ts`), the Host `qianji_inspect` introspection
 * tool (`packages/host/src/plugin-dev-tools.ts`), and guardrail tests so
 * frontend and backend slot schemas can never drift apart.
 */

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

function defineSlot(entry: {
  name: string;
  method: string;
  summary: string;
  options: readonly string[];
  contextFields: readonly string[];
  note?: string;
}): ClientSlotMetadata {
  return {
    name: entry.name,
    slot: entry.name,
    method: entry.method,
    registerMethod: entry.method,
    summary: entry.summary,
    options: entry.options,
    contextFields: entry.contextFields,
    contextProps: entry.contextFields,
    ...(entry.note === undefined ? {} : { note: entry.note }),
  };
}

export const CLIENT_SLOT_CATALOG: readonly ClientSlotMetadata[] = [
  defineSlot({
    name: "pages",
    method: "ctx.contributions.registerPage",
    summary: "一级侧边栏导航入口与主舞台全屏功能页",
    options: ["id", "label", "icon?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
  }),
  defineSlot({
    name: "leftSidebar",
    method: "ctx.contributions.registerLeftSidebar",
    summary: "左侧导航栏底部自定义常驻分区",
    options: ["id", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
  }),
  defineSlot({
    name: "rightWorkbenchTabs",
    method: "ctx.contributions.registerRightWorkbenchTab",
    summary: "右侧工作台独立标签页（可通过 sidebar_open / openWorkbenchTab 聚焦）",
    options: ["id", "label", "icon?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
  }),
  defineSlot({
    name: "bottomPanelTabs",
    method: "ctx.contributions.registerBottomPanelTab",
    summary: "底部终端/输出抽屉并列标签页",
    options: ["id", "label", "icon?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
  }),
  defineSlot({
    name: "topbarActions",
    method: "ctx.contributions.registerTopbarAction",
    summary: "主舞台右上角工具栏紧凑操作按钮",
    options: ["id", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
  }),
  defineSlot({
    name: "composerToolbar",
    method: "ctx.contributions.registerComposerToolbar",
    summary: "输入栏左下角工具栏胶囊/按钮",
    options: ["id", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "variant"],
  }),
  defineSlot({
    name: "composerStatus",
    method: "ctx.contributions.registerComposerStatus",
    summary: "输入栏右下角模型选择器两侧遥测微件（before-model / after-model）",
    options: ["id", "position?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "variant"],
  }),
  defineSlot({
    name: "composerBanners",
    method: "ctx.contributions.registerComposerBanner",
    summary: "输入栏顶部上下文提示条",
    options: ["id", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "variant"],
  }),
  defineSlot({
    name: "overlays",
    method: "ctx.contributions.registerOverlay",
    summary: "全局浮层/模态框槽位（根层默认 pointer-events: none 防误遮挡，交互子弹窗设 pointer-events: auto）",
    options: ["id", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
    note: "Overlay root forces pointer-events: none; set pointer-events: auto on interactive modal children.",
  }),
  defineSlot({
    name: "message.actions",
    method: "ctx.contributions.registerMessageAction",
    summary: "单条对话消息（用户/助手）底部悬浮操作栏扩展按钮",
    options: ["id", "role?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "message", "contentText"],
  }),
  defineSlot({
    name: "message.toolRenderer",
    method: "ctx.contributions.registerToolRenderer",
    summary: "按工具名或前缀通配（如 sqlite_*）匹配自定义对话流卡片视图",
    options: ["id", "toolNames", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "call", "state"],
  }),
  defineSlot({
    name: "file.viewer",
    method: "ctx.contributions.registerFileViewer",
    summary: "按扩展名或 MIME 类型注册右侧工作台自定义文件预览器（如 SQLite、XLSX、3D、流程图）",
    options: ["id", "label?", "extensions?", "mimeTypes?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "path", "content", "isBinary", "mimeType", "dataBase64", "size"],
  }),
  defineSlot({
    name: "status.bar",
    method: "ctx.contributions.registerStatusBarItem",
    summary: "工作区底部全局状态栏微件（支持 left / right 对齐）",
    options: ["id", "align?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
  }),
  defineSlot({
    name: "home.quickActions",
    method: "ctx.contributions.registerHomeQuickAction",
    summary: "新任务首页快捷启动指令胶囊",
    options: ["id", "label?", "icon?", "prompt?", "order?", "onSelect?(ctx)", "render?(ctx)"],
    contextFields: ["cwd", "sessionFile", "prefillComposer", "sendPrompt"],
  }),
  defineSlot({
    name: "slashInterceptors",
    method: "ctx.contributions.registerSlashInterceptor",
    summary: "客户端斜杠命令（/xxx）前端优先拦截器",
    options: ["id", "order?", "onSlashCommand(name, rawArgs, ctx)"],
    contextFields: ["name", "rawArgs", "cwd", "sessionFile"],
  }),
  defineSlot({
    name: "rewindHandlers",
    method: "ctx.contributions.registerRewindHandler",
    summary: "会话消息检查点回退与时间轴拦截器",
    options: ["id", "order?", "onRewindMessage(message)", "onOpenTimeline?()"],
    contextFields: ["message"],
  }),
  defineSlot({
    name: "themes",
    method: "ctx.contributions.registerTheme",
    summary: "动态外观配色皮肤与桌宠主题贡献",
    options: ["id", "label", "mode", "scope?", "sourcePath?", "palette?"],
    contextFields: ["AppearanceThemeDefinition"],
  }),
] as const;

export const CLIENT_SDK_EXPORTS = {
  hooks: [
    "useActiveSession()",
    "useActiveWorkspace()",
    "useAppearanceTheme()",
    "usePluginConfig<T>(pluginId, defaults?)",
    "useHostRpcQuery<T>(method, params?, options?)",
  ],
  actions: [
    "callHostRpc<T>(method, params?)",
    "openWorkbenchTab(tabId)",
    "openWorkspaceFile(path, line?)",
    "sendChatPrompt(text, options?)",
    "showToast(message, kind?)",
    "getActiveSessionSnapshot()",
    "subscribeSessionActivity(listener)",
  ],
} as const;
