/**
 * Settings navigation: the built-in categories plus pages and sections that
 * plugins contribute through `registerSettingsPage` / `registerSettingsSection`.
 */
import type { ReactNode } from "react";
import { Boxes, Cpu, Palette, SlidersHorizontal } from "lucide-react";
import type {
  ClientSettingsPageContribution,
  ClientSettingsSectionContribution,
  SettingsSlotContext,
} from "../../lib/clientContributions";
import { pluginSettingsPageId, type SettingsPageId } from "../../lib/shellBridge";
import { SlotEntryHost } from "../common/ErrorBoundary";

export interface SettingsNavItem {
  id: SettingsPageId;
  label: string;
  heading: string;
  subtitle: string;
  icon: ReactNode;
  /** Wide content column, used by grids of cards. */
  wide: boolean;
  /** Set for pages contributed by a plugin. */
  plugin?: ClientSettingsPageContribution;
}

const ICON_PROPS = { size: 15.5, strokeWidth: 1.85 } as const;

export const BUILTIN_SETTINGS_NAV: readonly [SettingsNavItem, ...SettingsNavItem[]] = [
  { id: "general", label: "通用", heading: "通用", subtitle: "管理对话发送习惯、外部代码编辑器与桌面通知偏好", icon: <SlidersHorizontal {...ICON_PROPS} />, wide: false },
  { id: "appearance", label: "外观", heading: "外观", subtitle: "定制工作台明暗主题、阅读排版字号与窗口显示比例", icon: <Palette {...ICON_PROPS} />, wide: false },
  { id: "providers", label: "模型", heading: "模型与密钥", subtitle: "配置默认对话模型与各模型专属思考等级，按需展开服务商填写本机加密 API Key", icon: <Cpu {...ICON_PROPS} />, wide: false },
  { id: "plugins", label: "插件", heading: "连接器与插件", subtitle: "连接 MCP 工具服务、智能体核心能力与本地热更新扩展模块", icon: <Boxes {...ICON_PROPS} />, wide: true },
];

export function pluginSettingsNavItems(pages: readonly ClientSettingsPageContribution[]): SettingsNavItem[] {
  return pages.map((page) => ({
    id: `plugin:${page.id}`,
    label: page.label,
    heading: page.heading ?? page.label,
    subtitle: page.subtitle ?? "",
    icon: page.icon ?? <Boxes {...ICON_PROPS} />,
    wide: page.wide === true,
    plugin: page,
  }));
}

/** Sections whose `page` targets the page on screen (`"general"`, or a plugin page's own id). */
export function sectionsForSettingsPage(
  sections: readonly ClientSettingsSectionContribution[],
  page: SettingsPageId,
): ClientSettingsSectionContribution[] {
  const pluginPage = pluginSettingsPageId(page);
  return sections.filter((section) => section.page === page || (pluginPage !== undefined && section.page === pluginPage));
}

/** A plugin settings page body followed by every plugin section that targets the page on screen. */
export function PluginSettingsContent({
  page,
  sections,
  context,
}: {
  page: SettingsNavItem;
  sections: readonly ClientSettingsSectionContribution[];
  context: SettingsSlotContext;
}) {
  return (
    <>
      {page.plugin && <SlotEntryHost entry={page.plugin} context={context} slotName="settings.pages" />}
      {sectionsForSettingsPage(sections, page.id).map((section) => (
        <section key={section.id} className="settings-layered-section settings-plugin-section">
          {section.title !== undefined && section.title !== "" && <h2>{section.title}</h2>}
          <SlotEntryHost
            entry={section}
            context={context}
            slotName="settings.sections"
            className="settings-soft-card settings-plugin-card"
          />
        </section>
      ))}
    </>
  );
}
