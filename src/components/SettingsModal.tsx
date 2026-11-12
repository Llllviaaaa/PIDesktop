import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { ArrowLeft, Maximize2, Minimize2, X } from "lucide-react";
import { BUILTIN_APPEARANCE_CATALOG, type AppearanceCatalog } from "../lib/appearanceCatalog";
import { useClientContributions, type SettingsSlotContext } from "../lib/clientContributions";
import type { SettingsPageId } from "../lib/shellBridge";
import { ModelsPage } from "./ModelsPage";
import { PluginsSettingsPanel } from "./PluginsSettingsPanel";
import { AppearancePage } from "./settings/AppearanceSettingsPage";
import { GeneralPage } from "./settings/GeneralSettingsPage";
import {
  BUILTIN_SETTINGS_NAV,
  PluginSettingsContent,
  pluginSettingsNavItems,
  type SettingsNavItem,
} from "./settings/settingsNavigation";
import { DEFAULTS, NAV_SPRING, normalizeSettingsDisplayMode } from "./settings/settingsPrimitives";
import type { AppSettings } from "../types";

export { DEFAULTS, formatShortcutChord, normalizeSettingsDisplayMode } from "./settings/settingsPrimitives";

/** A built-in Settings category, or `plugin:<id>` for a page from `registerSettingsPage`. */
export type SettingsPage = SettingsPageId;

export function SettingsModal({
  settings,
  cwd,
  sessionFile = null,
  appearanceCatalog = BUILTIN_APPEARANCE_CATALOG,
  onSave,
  onClose,
  initialPage = "general",
}: {
  settings: AppSettings | null;
  cwd: string;
  sessionFile?: string | null;
  appearanceCatalog?: AppearanceCatalog;
  onSave: (settings: AppSettings) => Promise<void> | void;
  onClose: () => void;
  initialPage?: SettingsPage;
}) {
  const [form, setForm] = useState<AppSettings>({ ...DEFAULTS, ...settings, language: "zh-CN" });
  const formRef = useRef(form);
  const [active, setActive] = useState<SettingsPage>(initialPage);
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saving" | "saved" | "error">("idle");
  const editedRef = useRef(false);
  const pendingSaveRef = useRef<AppSettings | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveStatusTimerRef = useRef<number | null>(null);
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  const onSaveRef = useRef(onSave);
  const pageScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0;
  }, [active]);

  useEffect(() => {
    if (!editedRef.current) {
      const synced: AppSettings = { ...DEFAULTS, ...settings, language: "zh-CN" };
      formRef.current = synced;
      setForm(synced);
    }
  }, [settings]);

  const [requestedPage, setRequestedPage] = useState(initialPage);
  if (requestedPage !== initialPage) {
    setRequestedPage(initialPage);
    setActive(initialPage);
  }

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    if (saveStatusTimerRef.current !== null) window.clearTimeout(saveStatusTimerRef.current);
    if (pendingSaveRef.current) {
      const unsaved = pendingSaveRef.current;
      pendingSaveRef.current = null;
      void Promise.resolve(onSaveRef.current({ ...unsaved, language: "zh-CN" })).catch(() => undefined);
    }
  }, []);

  const flushSettings = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (inFlightSaveRef.current) await inFlightSaveRef.current;
    while (pendingSaveRef.current) {
      const next = pendingSaveRef.current;
      pendingSaveRef.current = null;
      setSaveState("saving");
      const task = Promise.resolve(onSave({ ...next, language: "zh-CN" }))
        .then(() => {
          if (!pendingSaveRef.current) editedRef.current = false;
          setSaveState("saved");
          if (saveStatusTimerRef.current !== null) window.clearTimeout(saveStatusTimerRef.current);
          saveStatusTimerRef.current = window.setTimeout(() => setSaveState("idle"), 1200);
        })
        .catch(() => setSaveState("error"));
      inFlightSaveRef.current = task;
      await task;
      inFlightSaveRef.current = null;
    }
  }, [onSave]);

  const scheduleSave = useCallback((next: AppSettings) => {
    pendingSaveRef.current = next;
    setSaveState("pending");
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void flushSettings(), 260);
  }, [flushSettings]);

  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next: AppSettings = { ...formRef.current, [key]: value };
    formRef.current = next;
    editedRef.current = true;
    setForm(next);
    if (key === "settingsDisplayMode") {
      pendingSaveRef.current = next;
      void flushSettings();
    } else {
      scheduleSave(next);
    }
  }, [flushSettings, scheduleSave]);

  const closeSettings = useCallback(() => {
    void flushSettings().finally(onClose);
  }, [flushSettings, onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (document.querySelector("[data-escape-layer]")) return;
        event.preventDefault();
        closeSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSettings]);

  const displayMode = normalizeSettingsDisplayMode(form.settingsDisplayMode);
  const isPage = displayMode === "page";
  const toggleDisplayMode = useCallback(() => {
    update("settingsDisplayMode", isPage ? "modal" : "page");
  }, [isPage, update]);
  const { settingsPages, settingsSections } = useClientContributions();
  const pluginNav = useMemo(() => pluginSettingsNavItems(settingsPages), [settingsPages]);
  // A plugin page that was unloaded while open falls back to "general".
  const activeMeta = [...BUILTIN_SETTINGS_NAV, ...pluginNav].find((item) => item.id === active) ?? BUILTIN_SETTINGS_NAV[0];
  const shownPage = activeMeta.id;
  const isWideGrid = activeMeta.wide;
  const slotContext: SettingsSlotContext = { cwd, sessionFile, page: shownPage, closeSettings };
  const renderNavButton = (item: SettingsNavItem) => {
    const isActive = shownPage === item.id;
    return (
      <button
        key={item.id}
        type="button"
        className={isActive ? "active" : ""}
        data-qj-contributed-by={item.plugin ? item.plugin.pluginId ?? "builtin" : undefined}
        onClick={() => setActive(item.id)}
      >
        {isActive && (
          <motion.span
            layoutId="settings-nav-pill"
            className="settings-nav-pill"
            transition={NAV_SPRING}
          />
        )}
        {item.icon}
        <span>{item.label}</span>
      </button>
    );
  };

  return (
    <motion.div
      className={`settings-backdrop ${isPage ? "is-page" : "is-modal"}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: isPage ? 0.14 : 0.16, ease: [0.16, 1, 0.3, 1] }}
      onMouseDown={(event) => {
        if (!isPage && event.target === event.currentTarget) closeSettings();
      }}
    >
      <motion.div
        className={`settings-center ${isPage ? "is-page" : "is-modal"}`}
        data-settings-mode={displayMode}
        role={isPage ? "region" : "dialog"}
        aria-modal={isPage ? undefined : "true"}
        aria-label="设置"
        initial={isPage ? { opacity: 0 } : { opacity: 0, scale: 0.965, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={isPage ? { opacity: 0 } : { opacity: 0, scale: 0.975, y: 6 }}
        transition={{ duration: isPage ? 0.14 : 0.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <aside className="settings-navigation">
          {isPage && (
            <button
              type="button"
              className="settings-back-btn"
              onClick={closeSettings}
              title="返回应用 (Esc)"
              aria-label="返回应用"
            >
              <ArrowLeft size={15} strokeWidth={1.9} />
              <span>返回应用</span>
            </button>
          )}
          <div className="settings-modal-brand">设置</div>

          <LayoutGroup id="settings-sidebar-nav">
            <nav className="settings-nav-scroll" aria-label="设置分类">
              {BUILTIN_SETTINGS_NAV.map(renderNavButton)}
              {pluginNav.length > 0 && <div className="settings-nav-group-label">扩展</div>}
              {pluginNav.map(renderNavButton)}
            </nav>
          </LayoutGroup>

          <div className="settings-nav-footer">
            <span className="settings-nav-app">千机 · v0.3.0</span>
            <kbd>{form.shortcutSettings || "Ctrl+,"}</kbd>
          </div>
        </aside>

        <main className="settings-content">
          <header className="settings-stage-header">
            <div className={`settings-stage-header-inner ${isWideGrid ? "is-wide" : ""}`}>
              <div className="settings-header-titles">
                <h1>{activeMeta.heading}</h1>
                <span className={`settings-save-status ${saveState}`} aria-live="polite">
                  {saveState === "pending" || saveState === "saving"
                    ? "正在保存…"
                    : saveState === "saved"
                      ? "已保存"
                      : saveState === "error"
                        ? "保存失败"
                        : ""}
                </span>
              </div>
              <div className="settings-header-actions">
                <button
                  type="button"
                  className="settings-mode-toggle-btn"
                  onClick={toggleDisplayMode}
                  title={isPage ? "切换为居中弹窗展示" : "切换为独立页面展示"}
                  aria-label={isPage ? "切换为居中弹窗" : "切换为独立页面"}
                >
                  {isPage ? <Minimize2 size={13} strokeWidth={1.9} /> : <Maximize2 size={13} strokeWidth={1.9} />}
                  <span>{isPage ? "弹窗视图" : "页面视图"}</span>
                </button>
                {!isPage && (
                  <button
                    type="button"
                    className="settings-close-circle"
                    onClick={closeSettings}
                    title="返回应用 (Esc)"
                    aria-label="返回应用"
                  >
                    <X size={15} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          </header>

          <div ref={pageScrollRef} className="settings-page-scroll">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={shownPage}
                className={`settings-page ${isWideGrid ? "is-wide" : ""}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
              >
                <p className="settings-header-sub">{activeMeta.subtitle}</p>
                {shownPage === "general" && <GeneralPage form={form} update={update} />}
                {shownPage === "appearance" && <AppearancePage form={form} update={update} catalog={appearanceCatalog} />}
                {shownPage === "providers" && <ModelsPage form={form} update={update} />}
                {shownPage === "plugins" && <PluginsSettingsPanel cwd={cwd} form={form} onSyncAppSetting={update} />}
                <PluginSettingsContent page={activeMeta} sections={settingsSections} context={slotContext} />
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </motion.div>
    </motion.div>
  );
}
