import { LayoutGroup, motion } from "motion/react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { AppearanceCatalog, AppearanceThemeDefinition } from "../../lib/appearanceCatalog";
import type { AppSettings } from "../../types";
import {
  DEFAULTS,
  NAV_SPRING,
  normalizeSettingsDisplayMode,
  Row,
  Section,
  SettingsSwitch,
  ShortcutRecorder,
  type Update,
} from "./settingsPrimitives";

function ThemeModeIcon({ theme }: { theme: AppearanceThemeDefinition }) {
  if (theme.id === "system") return <Monitor size={13} strokeWidth={1.85} />;
  if (theme.mode === "dark") return <Moon size={13} strokeWidth={1.85} />;
  return <Sun size={13} strokeWidth={1.85} />;
}

function MiniWindowGraphic({ mode }: { mode: "light" | "dark" }) {
  return (
    <div className={`theme-preview-window is-${mode}`} aria-hidden="true">
      <div className="tp-sidebar">
        <span className="tp-dot" />
        <span className="tp-line" />
        <span className="tp-line" style={{ width: "64%" }} />
      </div>
      <div className="tp-stage">
        <span className="tp-bubble-user" />
        <span className="tp-bubble-agent" />
        <span className="tp-composer" />
      </div>
    </div>
  );
}

function ThemePreviewIllustration({ theme }: { theme: AppearanceThemeDefinition }) {
  if (theme.id === "system" || theme.mode === "system") {
    return (
      <div className="theme-preview-system-split" aria-hidden="true">
        <MiniWindowGraphic mode="light" />
        <MiniWindowGraphic mode="dark" />
      </div>
    );
  }
  return <MiniWindowGraphic mode={theme.mode === "dark" ? "dark" : "light"} />;
}

export function AppearancePage({
  form,
  update,
  catalog,
}: {
  form: AppSettings;
  update: Update;
  catalog: AppearanceCatalog;
}) {
  return (
    <>
      <section className="settings-layered-section">
        <h2>主题模式</h2>
        <div className="theme-mode-grid" role="radiogroup" aria-label="主题模式">
          {catalog.themes.map((theme) => {
            const selected = form.theme === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`theme-mode-card ${selected ? "active" : ""}`}
                onClick={() => update("theme", theme.id)}
              >
                <ThemePreviewIllustration theme={theme} />
                <div className="theme-mode-footer">
                  <span className="theme-mode-label-group">
                    <span className="theme-mode-icon" aria-hidden="true">
                      <ThemeModeIcon theme={theme} />
                    </span>
                    <span className="theme-mode-label">{theme.label}</span>
                  </span>
                  {selected && (
                    <span className="theme-mode-check" aria-hidden="true">
                      <Check size={10} strokeWidth={2.6} />
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <Section title="界面布局">
        <Row
          title="设置页面展示方式"
          description="默认以全窗口独立页面展开设置，也可切换为居中悬浮弹窗叠加在当前对话上方"
        >
          <LayoutGroup id="appearance-settings-mode-seg">
            <div className="settings-segmented" role="radiogroup" aria-label="设置页面展示方式">
              {([
                ["page", "独立页面"],
                ["modal", "居中弹窗"],
              ] as const).map(([val, label]) => {
                const active = normalizeSettingsDisplayMode(form.settingsDisplayMode) === val;
                return (
                  <button
                    key={val}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={active ? "active" : ""}
                    onClick={() => update("settingsDisplayMode", val)}
                  >
                    {active && <motion.span layoutId="settings-mode-seg-thumb" className="settings-segmented-thumb" transition={NAV_SPRING} />}
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>
        </Row>
        <Row
          title="切换左侧栏快捷键"
          description="固定或收起左侧会话与项目边栏的全局快捷键（窄窗口下展开悬浮抽屉）"
        >
          <ShortcutRecorder
            label="切换左侧栏快捷键"
            value={form.shortcutToggleSidebar}
            defaultValue={DEFAULTS.shortcutToggleSidebar}
            onChange={(next) => update("shortcutToggleSidebar", next)}
          />
        </Row>
      </Section>

      <Section title="排版与缩放">
        <Row title="对话阅读字号" description="消息正文、列表与代码片段的基准字号">
          <LayoutGroup id="appearance-fontsize-seg">
            <div className="settings-segmented" role="radiogroup" aria-label="对话字号">
              {[13, 14, 15, 16, 18].map((size) => {
                const active = form.messageFontSize === size;
                return (
                  <button
                    key={size}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={active ? "active" : ""}
                    onClick={() => update("messageFontSize", size)}
                  >
                    {active && <motion.span layoutId="fontsize-seg-thumb" className="settings-segmented-thumb" transition={NAV_SPRING} />}
                    <span>{size}px</span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>
        </Row>
        <Row title="全局界面缩放" description="按比例缩放整个工作台窗口与控件尺寸">
          <LayoutGroup id="appearance-uiscale-seg">
            <div className="settings-segmented" role="radiogroup" aria-label="界面缩放">
              {[90, 100, 110, 125].map((scale) => {
                const active = form.uiScale === scale;
                return (
                  <button
                    key={scale}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={active ? "active" : ""}
                    onClick={() => update("uiScale", scale)}
                  >
                    {active && <motion.span layoutId="uiscale-seg-thumb" className="settings-segmented-thumb" transition={NAV_SPRING} />}
                    <span>{scale}%</span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>
        </Row>
        <Row title="消息密度" description="控制对话气泡与工具调用卡片之间的纵向留白节奏">
          <LayoutGroup id="appearance-density-seg">
            <div className="settings-segmented" role="radiogroup" aria-label="消息密度">
              {([
                ["summary", "精简"],
                ["normal", "标准"],
                ["verbose", "详细"],
              ] as const).map(([val, label]) => {
                const active = form.transcriptDensity === val;
                return (
                  <button
                    key={val}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={active ? "active" : ""}
                    onClick={() => update("transcriptDensity", val)}
                  >
                    {active && <motion.span layoutId="density-seg-thumb" className="settings-segmented-thumb" transition={NAV_SPRING} />}
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>
        </Row>
        <Row title="展示推理思考过程" description="控制是否在回复上方展示可折叠思考链（关闭后隐藏思考内容；若需模型跳过深度推理耗时，请将推理强度设为「关」）">
          <SettingsSwitch
            label="显示思考过程"
            checked={form.showThinking}
            onChange={(value) => update("showThinking", value)}
          />
        </Row>
      </Section>
    </>
  );
}
