/**
 * Client entry for `smart-rewind` (`智能检查点回退`).
 *
 * Competitor-grade checkpoint rewind & time-machine UX (modeled after Cursor
 * Checkpoints, Claude Code `Esc Esc` / `/rewind`, and Windsurf Revert-to-Step):
 * 1. Automatically restores rewound user message text + image attachments into
 *    the Composer input box with focus & caret at end.
 * 2. Replaces native OS `confirm()` with a sleek Muse-styled Checkpoint Rewind
 *    Sheet supporting 3 modes (`both`, `conversation`, `code`) + live Git diff
 *    file preview + keyboard navigation (`1` / `2` / `3`, `↑` / `↓`, `Enter`, `Esc`).
 * 3. Protects existing unsent Composer drafts by stashing them with a 1-click
 *    2-way swap button (`恢复原草稿` / `切回回退消息`) in the Composer banner.
 * 4. Supports 1-click `撤销回退` (in-place append-only branch restoration via
 *    `smartRewind.undoBranch`) and `Esc Esc` / `/rewind` Time-Machine timeline.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  getActiveSessionSnapshot,
  rewindController,
  showToast,
  useActiveSession,
  type ComposerDraftSnapshot,
  type PerformedRewindResult,
  type RewindMode,
  type RewindTargetSummary,
  type RewindTurnSummary,
  type UiMessage,
} from "@qianji/client";
import {
  Check,
  FileCode2,
  History,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquareReply,
  RotateCcw,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";

export interface SmartRewindPluginConfig {
  defaultMode?: "both" | "conversation";
  instantWhenClean?: boolean;
  protectDraft?: boolean;
  showUndoBanner?: boolean;
  doubleEscShortcut?: boolean;
}

const INSTANT_PREF_STORAGE_KEY = "qianji-plugin:smart-rewind:instant-when-clean";

interface DialogState {
  open: boolean;
  timelineMode: boolean;
  selectedMessageId: string;
  turns: RewindTurnSummary[];
  resolve?: (rewound: boolean) => void;
}

interface BannerState {
  sessionId: string;
  mode: RewindMode;
  turnNumber: number;
  totalTurns: number;
  rewindSeq?: number;
  restoredFiles: string[];
  rewoundDraft: ComposerDraftSnapshot;
  alternateDraft: ComposerDraftSnapshot | null;
  showingAlternate: boolean;
}

interface PluginUiStoreState {
  config: Required<SmartRewindPluginConfig>;
  dialog: DialogState | null;
  banner: BannerState | null;
}

function readInstantOverride(): boolean | null {
  try {
    const raw = window.localStorage.getItem(INSTANT_PREF_STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch {
    return null;
  }
}

function writeInstantOverride(value: boolean): void {
  try {
    window.localStorage.setItem(INSTANT_PREF_STORAGE_KEY, value ? "true" : "false");
  } catch {
    // Ignore storage quota errors in restricted webviews.
  }
}

function normalizeConfig(raw: SmartRewindPluginConfig = {}): Required<SmartRewindPluginConfig> {
  return {
    defaultMode: raw.defaultMode === "conversation" ? "conversation" : "both",
    instantWhenClean: raw.instantWhenClean === true,
    protectDraft: raw.protectDraft !== false,
    showUndoBanner: raw.showUndoBanner !== false,
    doubleEscShortcut: raw.doubleEscShortcut !== false,
  };
}

class SmartRewindUiStore {
  private state: PluginUiStoreState;
  private readonly listeners = new Set<() => void>();

  constructor(initialConfig: SmartRewindPluginConfig) {
    this.state = {
      config: normalizeConfig(initialConfig),
      dialog: null,
      banner: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PluginUiStoreState => this.state;

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  setConfig(next: SmartRewindPluginConfig): void {
    this.state = { ...this.state, config: normalizeConfig(next) };
    this.emit();
  }

  openDialog(next: Omit<DialogState, "open">): void {
    if (this.state.dialog?.resolve) {
      this.state.dialog.resolve(false);
    }
    this.state = {
      ...this.state,
      dialog: { ...next, open: true },
    };
    this.emit();
  }

  closeDialog(result: boolean): void {
    const pending = this.state.dialog?.resolve;
    this.state = { ...this.state, dialog: null };
    this.emit();
    pending?.(result);
  }

  selectTurn(messageId: string): void {
    if (!this.state.dialog) return;
    this.state = {
      ...this.state,
      dialog: { ...this.state.dialog, selectedMessageId: messageId },
    };
    this.emit();
  }

  setBanner(outcome: PerformedRewindResult): void {
    if (!this.state.config.showUndoBanner) {
      this.state = { ...this.state, banner: null };
      this.emit();
      return;
    }
    this.state = {
      ...this.state,
      banner: {
        sessionId: outcome.sessionId,
        mode: outcome.mode,
        turnNumber: outcome.turnNumber,
        totalTurns: outcome.totalTurns,
        ...(outcome.rewindSeq === undefined ? {} : { rewindSeq: outcome.rewindSeq }),
        restoredFiles: outcome.restoredFiles,
        rewoundDraft: {
          text: outcome.refilledText,
          attachments: outcome.refilledAttachments,
        },
        alternateDraft: outcome.stashedDraft,
        showingAlternate: false,
      },
    };
    this.emit();
  }

  swapBannerDraft(): void {
    const banner = this.state.banner;
    if (!banner || !banner.alternateDraft) return;
    const nextShowingAlternate = !banner.showingAlternate;
    const target = nextShowingAlternate ? banner.alternateDraft : banner.rewoundDraft;
    rewindController.setComposerDraft({
      text: target.text,
      attachments: target.attachments,
      focus: true,
    });
    this.state = {
      ...this.state,
      banner: {
        ...banner,
        showingAlternate: nextShowingAlternate,
      },
    };
    this.emit();
  }

  clearBanner(): void {
    if (this.state.banner === null) return;
    this.state = { ...this.state, banner: null };
    this.emit();
  }

  dispose(): void {
    if (this.state.dialog?.resolve) {
      this.state.dialog.resolve(false);
    }
    this.state = { ...this.state, dialog: null, banner: null };
    this.emit();
  }
}

const SMART_REWIND_CSS = `
.sr-composer-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 8px 10px 2px;
  padding: 7px 10px 7px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--qj-brand-primary, #006ee4) 8%, var(--qj-bg-hover, rgba(0, 0, 0, 0.04)));
  color: var(--qj-text-primary, var(--text));
  font-family: var(--qj-font-sans, var(--font-ui));
  font-size: 12.5px;
  line-height: 1.35;
}

.sr-banner-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.sr-banner-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--qj-brand-soft, color-mix(in srgb, var(--qj-brand-primary, #006ee4) 15%, transparent));
  color: var(--qj-brand-primary, #006ee4);
  flex-shrink: 0;
}

.sr-banner-copy {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.sr-banner-copy strong {
  font-weight: 600;
  color: var(--qj-text-primary, var(--text));
}

.sr-banner-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1.5px 7px;
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--qj-text-secondary, var(--text-2));
  background: var(--qj-bg-active, rgba(0, 0, 0, 0.06));
}

.sr-banner-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.sr-banner-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 25px;
  padding: 0 9px;
  border: 0;
  border-radius: 999px;
  background: var(--qj-bg-surface, #ffffff);
  color: var(--qj-text-primary, var(--text));
  font-family: var(--qj-font-sans, var(--font-ui));
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}

.sr-banner-btn:hover:not(:disabled) {
  color: var(--qj-brand-primary, #006ee4);
}

.sr-banner-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.sr-banner-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--qj-text-muted, var(--text-3));
  cursor: pointer;
}

.sr-banner-close:hover {
  background: var(--qj-bg-active, rgba(0, 0, 0, 0.07));
  color: var(--qj-text-primary, var(--text));
}

.sr-backdrop {
  position: fixed;
  top: 34px;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 210;
  display: grid;
  place-items: center;
  padding: 20px;
  pointer-events: auto;
  background: var(--muse-dialog-scrim, rgba(17, 17, 18, 0.28));
  backdrop-filter: saturate(140%) blur(6px);
  -webkit-backdrop-filter: saturate(140%) blur(6px);
}

.sr-dialog {
  width: min(540px, calc(100vw - 32px));
  max-height: min(640px, calc(100vh - 76px));
  display: flex;
  flex-direction: column;
  border-radius: 24px;
  background: var(--qj-bg-surface, #ffffff);
  color: var(--qj-text-primary, var(--text));
  font-family: var(--qj-font-sans, var(--font-ui));
  box-shadow: var(--muse-elevation-dialog, 0 24px 64px rgba(0, 0, 0, 0.22));
  overflow: hidden;
}

.sr-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 12px;
}

.sr-head-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sr-head-badge {
  width: 34px;
  height: 34px;
  border-radius: var(--qj-radius-md, 10px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--qj-brand-soft, color-mix(in srgb, var(--qj-brand-primary, #006ee4) 12%, transparent));
  color: var(--qj-brand-primary, #006ee4);
}

.sr-head-title h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.sr-head-title p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--qj-text-muted, var(--text-3));
}

.sr-close-btn {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--qj-bg-hover, rgba(0, 0, 0, 0.05));
  color: var(--qj-text-secondary, var(--text-2));
  cursor: pointer;
}

.sr-close-btn:hover {
  background: var(--qj-bg-active, rgba(0, 0, 0, 0.09));
  color: var(--qj-text-primary, var(--text));
}

.sr-body {
  padding: 2px 20px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sr-turns-strip {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sr-section-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--qj-text-muted, var(--text-3));
}

.sr-turn-pills {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.sr-turn-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 210px;
  height: 30px;
  padding: 0 11px;
  border: 0;
  border-radius: 999px;
  background: var(--qj-bg-hover, rgba(0, 0, 0, 0.045));
  color: var(--qj-text-secondary, var(--text-2));
  font-family: var(--qj-font-sans, var(--font-ui));
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color 120ms ease, color 120ms ease;
}

.sr-turn-pill span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sr-turn-pill.active {
  background: var(--qj-brand-soft, color-mix(in srgb, var(--qj-brand-primary, #006ee4) 14%, transparent));
  color: var(--qj-brand-primary, #006ee4);
  font-weight: 600;
}

.sr-target-card {
  padding: 12px 14px;
  border-radius: 15px;
  background: var(--qj-bg-hover, rgba(0, 0, 0, 0.045));
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.sr-target-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11.5px;
  color: var(--qj-text-muted, var(--text-3));
}

.sr-target-tags {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sr-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  background: var(--qj-bg-active, rgba(0, 0, 0, 0.065));
  color: var(--qj-text-secondary, var(--text-2));
}

.sr-tag.accent {
  background: var(--qj-brand-soft, color-mix(in srgb, var(--qj-brand-primary, #006ee4) 13%, transparent));
  color: var(--qj-brand-primary, #006ee4);
}

.sr-target-preview {
  margin: 0;
  font-size: 13px;
  line-height: 1.48;
  color: var(--qj-text-primary, var(--text));
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.sr-diff-box {
  padding: 10px 13px;
  border-radius: 13px;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  background: var(--qj-bg-hover, rgba(0, 0, 0, 0.04));
  color: var(--qj-text-secondary, var(--text-2));
}

.sr-diff-box.changed {
  background: color-mix(in srgb, var(--qj-status-warning, #d97706) 10%, var(--qj-bg-hover, rgba(0, 0, 0, 0.04)));
}

.sr-diff-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 500;
  color: var(--qj-text-primary, var(--text));
}

.sr-diff-files {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  max-height: 64px;
  overflow-y: auto;
}

.sr-file-chip {
  font-family: var(--qj-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  padding: 2px 7px;
  border-radius: var(--qj-radius-sm, 6px);
  background: var(--qj-bg-surface, #ffffff);
  color: var(--qj-text-secondary, var(--text-2));
}

.sr-mode-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sr-mode-option {
  width: 100%;
  text-align: left;
  padding: 11px 13px;
  border-radius: var(--qj-radius-lg, 14px);
  border: 1.5px solid transparent;
  background: var(--qj-bg-hover, rgba(0, 0, 0, 0.045));
  color: var(--qj-text-primary, var(--text));
  font-family: var(--qj-font-sans, var(--font-ui));
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}

.sr-mode-option:hover:not(:disabled) {
  background: var(--qj-bg-active, rgba(0, 0, 0, 0.075));
}

.sr-mode-option.selected {
  border-color: var(--qj-brand-primary, #006ee4);
  background: color-mix(in srgb, var(--qj-brand-primary, #006ee4) 8%, var(--qj-bg-hover, rgba(0, 0, 0, 0.04)));
}

.sr-mode-option:disabled {
  opacity: 0.44;
  cursor: not-allowed;
}

.sr-mode-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.sr-mode-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13.5px;
  font-weight: 600;
}

.sr-mode-desc {
  font-size: 12px;
  line-height: 1.4;
  color: var(--qj-text-secondary, var(--text-2));
}

.sr-mode-right {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  padding-top: 1px;
}

.sr-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: var(--qj-radius-sm, 6px);
  font-size: 11px;
  font-weight: 600;
  background: var(--qj-bg-surface, #ffffff);
  color: var(--qj-text-muted, var(--text-3));
}

.sr-draft-guard-note {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 11px;
  border-radius: 11px;
  font-size: 12px;
  color: var(--qj-text-secondary, var(--text-2));
  background: color-mix(in srgb, var(--qj-brand-primary, #006ee4) 7%, transparent);
}

.sr-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px 18px;
}

.sr-instant-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--qj-text-secondary, var(--text-2));
  cursor: pointer;
  user-select: none;
}

.sr-instant-toggle input {
  margin: 0;
  accent-color: var(--qj-brand-primary, #006ee4);
}

.sr-foot-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sr-btn-ghost {
  height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 999px;
  background: var(--qj-bg-hover, rgba(0, 0, 0, 0.05));
  color: var(--qj-text-primary, var(--text));
  font-family: var(--qj-font-sans, var(--font-ui));
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.sr-btn-ghost:hover:not(:disabled) {
  background: var(--qj-bg-active, rgba(0, 0, 0, 0.09));
}

.sr-btn-primary {
  height: 34px;
  padding: 0 16px;
  border: 0;
  border-radius: 999px;
  background: var(--qj-brand-primary, #006ee4);
  color: var(--qj-brand-contrast, #ffffff);
  font-family: var(--qj-font-sans, var(--font-ui));
  font-size: 13px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: filter 120ms ease, opacity 120ms ease;
}

.sr-btn-primary:hover:not(:disabled) {
  filter: brightness(1.06);
}

.sr-btn-primary:disabled {
  opacity: 0.55;
  cursor: default;
}
`;

function ComposerRewindBannerView({ store }: { store: SmartRewindUiStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { sessionId: activeSessionId } = useActiveSession();
  const [undoing, setUndoing] = useState(false);

  const banner = snapshot.banner;
  useEffect(() => {
    if (!banner) return;
    if (activeSessionId && banner.sessionId && activeSessionId !== banner.sessionId) {
      store.clearBanner();
    }
  }, [activeSessionId, banner, store]);

  if (!banner) return null;

  const summaryLabel = banner.mode === "code"
    ? `已恢复第 ${banner.turnNumber} 轮前的工作区代码快照`
    : banner.mode === "conversation"
      ? `已回退至第 ${banner.turnNumber} 轮并回填原消息`
      : `已回退至第 ${banner.turnNumber} 轮并回填原消息`;

  const subPill = banner.mode === "conversation"
    ? "保留当前代码"
    : banner.restoredFiles.length > 0
      ? `已还原 ${banner.restoredFiles.length} 个文件`
      : null;

  const handleUndo = async () => {
    if (undoing || banner.rewindSeq === undefined || !banner.sessionId) return;
    setUndoing(true);
    try {
      const ok = await rewindController.undoBranchRewind({
        sessionId: banner.sessionId,
        rewindSeq: banner.rewindSeq,
        restoreDraft: banner.alternateDraft,
      });
      if (ok) {
        store.clearBanner();
        showToast("已撤销回退并恢复原对话分支", "info");
      }
    } catch (error) {
      showToast(
        `撤销回退失败：${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div className="sr-composer-banner" data-smart-rewind-banner="">
      <div className="sr-banner-main">
        <span className="sr-banner-icon" aria-hidden="true">
          <RotateCcw size={13} strokeWidth={2} />
        </span>
        <div className="sr-banner-copy">
          <strong>{summaryLabel}</strong>
          {subPill && <span className="sr-banner-pill">{subPill}</span>}
        </div>
      </div>

      <div className="sr-banner-actions">
        {banner.alternateDraft && (
          <button
            type="button"
            className="sr-banner-btn"
            disabled={undoing}
            onClick={() => store.swapBannerDraft()}
            title={banner.showingAlternate ? "重新填入刚才回退的原消息" : "恢复回退前输入框里尚未发送的草稿"}
          >
            <MessageSquareReply size={12.5} />
            <span>{banner.showingAlternate ? "切回回退消息" : "恢复原草稿"}</span>
          </button>
        )}

        {banner.rewindSeq !== undefined && banner.sessionId !== "" && (
          <button
            type="button"
            className="sr-banner-btn"
            disabled={undoing}
            onClick={() => void handleUndo()}
            title="撤销本次回退，恢复刚才被撤回的对话轮次"
          >
            {undoing ? <LoaderCircle className="spin" size={12.5} /> : <Undo2 size={12.5} />}
            <span>撤销回退</span>
          </button>
        )}

        <button
          type="button"
          className="sr-banner-close"
          aria-label="关闭回退提示"
          title="关闭提示"
          onClick={() => store.clearBanner()}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

function SmartRewindDialogOverlay({ store }: { store: SmartRewindUiStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const dialog = snapshot.dialog;
  const [inspection, setInspection] = useState<RewindTargetSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [mode, setMode] = useState<RewindMode>(snapshot.config.defaultMode);
  const [showAllTurns, setShowAllTurns] = useState(false);
  const [instantPref, setInstantPref] = useState<boolean>(() => {
    const stored = readInstantOverride();
    return stored ?? snapshot.config.instantWhenClean;
  });

  useEffect(() => {
    const stored = readInstantOverride();
    if (stored === null) {
      setInstantPref(snapshot.config.instantWhenClean);
    }
  }, [snapshot.config.instantWhenClean]);

  useEffect(() => {
    if (!dialog?.open || !dialog.selectedMessageId) {
      setInspection(null);
      setShowAllTurns(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void rewindController
      .inspectMessage(dialog.selectedMessageId)
      .then((res) => {
        if (cancelled) return;
        setInspection(res);
        if (res) {
          if (res.hasCheckpoint && res.changed) {
            setMode(snapshot.config.defaultMode);
          } else {
            setMode(snapshot.config.defaultMode === "conversation" ? "conversation" : "both");
          }
        }
      })
      .catch(() => {
        if (!cancelled) setInspection(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dialog?.open, dialog?.selectedMessageId, snapshot.config.defaultMode]);

  const currentDraft = useMemo(() => {
    if (!dialog?.open) return { text: "", attachments: [] };
    return rewindController.getComposerDraft();
  }, [dialog?.open]);

  const codeRestoreAvailable = Boolean(inspection?.hasCheckpoint && inspection?.changed);

  useEffect(() => {
    if (!dialog?.open) return;
    if (mode === "code" && !codeRestoreAvailable) {
      setMode(snapshot.config.defaultMode);
    }
  }, [codeRestoreAvailable, dialog?.open, mode, snapshot.config.defaultMode]);

  const confirmRewind = async (chosenMode: RewindMode = mode) => {
    if (!dialog || !inspection || executing) return;
    setExecuting(true);
    try {
      const outcome = await rewindController.performRewind({
        message: inspection.message,
        entryId: inspection.entryId,
        mode: chosenMode,
        protectDraft: snapshot.config.protectDraft,
      });
      if (outcome) {
        store.setBanner(outcome);
        if (chosenMode === "code") {
          showToast(
            `已恢复第 ${outcome.turnNumber} 轮前的代码快照（保留全部对话）`,
            "info",
          );
        }
        store.closeDialog(true);
      }
    } finally {
      setExecuting(false);
    }
  };

  useEffect(() => {
    if (!dialog?.open) return;
    const enabledModes: RewindMode[] = codeRestoreAvailable
      ? ["both", "conversation", "code"]
      : ["both", "conversation"];

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!executing) store.closeDialog(false);
        return;
      }
      if (event.key === "1") {
        event.preventDefault();
        setMode("both");
        return;
      }
      if (event.key === "2") {
        event.preventDefault();
        setMode("conversation");
        return;
      }
      if (event.key === "3" && codeRestoreAvailable) {
        event.preventDefault();
        setMode("code");
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setMode((curr) => {
          const idx = Math.max(0, enabledModes.indexOf(curr));
          return enabledModes[(idx + step + enabledModes.length) % enabledModes.length] ?? "both";
        });
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
        if (activeTag === "BUTTON" && (document.activeElement as HTMLElement)?.classList.contains("sr-turn-pill")) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (!loading && inspection && !executing) {
          void confirmRewind(mode);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  if (!dialog?.open) return null;

  const targetTurn = dialog.turns.find((item) => item.message.id === dialog.selectedMessageId);
  const targetMessage = inspection?.message ?? targetTurn?.message;
  const imageCount = targetMessage?.images?.length ?? 0;
  const hasUnsentDraft = snapshot.config.protectDraft
    && mode !== "code"
    && ((currentDraft.text.trim() !== "" && currentDraft.text.trim() !== (targetMessage?.content.trim() ?? ""))
      || currentDraft.attachments.length > 0);

  const showTurnsBar = dialog.timelineMode || showAllTurns;

  return (
    <div
      className="sr-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !executing) {
          store.closeDialog(false);
        }
      }}
    >
      <div
        className="sr-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={dialog.timelineMode ? "会话检查点时光机" : "智能检查点回退"}
        data-smart-rewind-dialog=""
      >
        <div className="sr-head">
          <div className="sr-head-title">
            <span className="sr-head-badge" aria-hidden="true">
              {dialog.timelineMode ? <History size={18} strokeWidth={2} /> : <RotateCcw size={17} strokeWidth={2} />}
            </span>
            <div>
              <h2>{dialog.timelineMode ? "会话检查点时光机" : "智能检查点回退"}</h2>
              <p>回退后自动将原消息与附件放回输入框 · 支持数字键 1-3 与 Enter 快捷确认</p>
            </div>
          </div>

          <button
            type="button"
            className="sr-close-btn"
            aria-label="关闭检查点回退窗口"
            disabled={executing}
            onClick={() => store.closeDialog(false)}
          >
            <X size={15} />
          </button>
        </div>

        <div className="sr-body">
          {dialog.turns.length > 1 && (
            <div className="sr-turns-strip">
              <div className="sr-section-label">
                <span>
                  {showTurnsBar
                    ? `选择要回退到的轮次（共 ${dialog.turns.length} 轮）`
                    : `当前定位：第 ${targetTurn?.turnNumber ?? 1} / ${dialog.turns.length} 轮`}
                </span>
                {!dialog.timelineMode && (
                  <button
                    type="button"
                    style={{
                      border: 0,
                      background: "transparent",
                      color: "var(--accent, #006ee4)",
                      fontSize: 11.5,
                      fontWeight: 600,
                      cursor: "pointer",
                      padding: 0,
                    }}
                    onClick={() => setShowAllTurns((val) => !val)}
                  >
                    {showTurnsBar ? "收起时间线" : "切换其他轮次"}
                  </button>
                )}
              </div>

              {showTurnsBar && (
                <div className="sr-turn-pills" role="tablist" aria-label="对话轮次列表">
                  {dialog.turns.map((item) => {
                    const active = item.message.id === dialog.selectedMessageId;
                    const label = item.message.content.replace(/\s+/g, " ").trim() || "[图片消息]";
                    return (
                      <button
                        key={item.message.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={`sr-turn-pill ${active ? "active" : ""}`}
                        onClick={() => store.selectTurn(item.message.id)}
                        title={label}
                      >
                        <strong>#{item.turnNumber}</strong>
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {targetMessage && (
            <div className="sr-target-card">
              <div className="sr-target-meta">
                <span>第 {inspection?.turnNumber ?? targetTurn?.turnNumber ?? 1} 轮用户消息</span>
                <div className="sr-target-tags">
                  {mode !== "code" && (
                    <span className="sr-tag accent">
                      <Sparkles size={11} />
                      自动回填输入框
                    </span>
                  )}
                  {imageCount > 0 && (
                    <span className="sr-tag">
                      <ImageIcon size={11} />
                      含 {imageCount} 张图片
                    </span>
                  )}
                  {(inspection?.subsequentMessageCount ?? targetTurn?.subsequentMessageCount ?? 0) > 0 && mode !== "code" && (
                    <span className="sr-tag">
                      撤回后续 {inspection?.subsequentMessageCount ?? targetTurn?.subsequentMessageCount} 条记录
                    </span>
                  )}
                </div>
              </div>
              <p className="sr-target-preview">
                {targetMessage.content || "（仅图片附件消息）"}
              </p>
            </div>
          )}

          <div className={`sr-diff-box ${inspection?.changed ? "changed" : ""}`}>
            {loading ? (
              <div className="sr-diff-row">
                <LoaderCircle className="spin" size={14} />
                <span>正在比对工作区 Git 检查点快照…</span>
              </div>
            ) : inspection?.changed ? (
              <>
                <div className="sr-diff-row">
                  <FileCode2 size={14} />
                  <span>
                    检测到 {inspection.files.length > 0 ? `${inspection.files.length} 个文件` : "Git 暂存区"} 自此轮消息后发生修改
                  </span>
                </div>
                {inspection.files.length > 0 && (
                  <div className="sr-diff-files">
                    {inspection.files.slice(0, 12).map((file) => (
                      <span key={file} className="sr-file-chip">{file}</span>
                    ))}
                    {inspection.files.length > 12 && (
                      <span className="sr-file-chip">+{inspection.files.length - 12} 个文件</span>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="sr-diff-row">
                <Check size={14} />
                <span>
                  {inspection?.hasCheckpoint
                    ? "工作区文件自此消息发送后无变动，可安全回退并重新编辑"
                    : "当前轮次未产生工作区文件快照变动，将回退对话并放回输入框"}
                </span>
              </div>
            )}
          </div>

          <div className="sr-mode-list" role="radiogroup" aria-label="回退方式">
            <button
              type="button"
              role="radio"
              aria-checked={mode === "both"}
              className={`sr-mode-option ${mode === "both" ? "selected" : ""}`}
              disabled={executing}
              onClick={() => setMode("both")}
              onDoubleClick={() => {
                if (!loading && inspection && !executing) void confirmRewind("both");
              }}
            >
              <div className="sr-mode-copy">
                <span className="sr-mode-title">回退对话与代码改动</span>
                <span className="sr-mode-desc">
                  {inspection?.changed
                    ? `还原工作区文件至本轮发送前快照，回退后续对话并将原消息放回输入框`
                    : "回退本轮及后续对话，并将原消息与图片附件放回输入框重新编辑"}
                </span>
              </div>
              <div className="sr-mode-right">
                {mode === "both" && <Check size={15} color="var(--accent, #006ee4)" />}
                <kbd className="sr-kbd">1</kbd>
              </div>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={mode === "conversation"}
              className={`sr-mode-option ${mode === "conversation" ? "selected" : ""}`}
              disabled={executing}
              onClick={() => setMode("conversation")}
              onDoubleClick={() => {
                if (!loading && inspection && !executing) void confirmRewind("conversation");
              }}
            >
              <div className="sr-mode-copy">
                <span className="sr-mode-title">仅回退对话（保留当前代码）</span>
                <span className="sr-mode-desc">
                  保留当前工作区全部文件修改不回滚，仅回退对话上下文并将原消息放回输入框
                </span>
              </div>
              <div className="sr-mode-right">
                {mode === "conversation" && <Check size={15} color="var(--accent, #006ee4)" />}
                <kbd className="sr-kbd">2</kbd>
              </div>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={mode === "code"}
              className={`sr-mode-option ${mode === "code" ? "selected" : ""}`}
              disabled={executing || !codeRestoreAvailable}
              title={!codeRestoreAvailable ? "当前轮次没有需要还原的文件改动" : undefined}
              onClick={() => setMode("code")}
              onDoubleClick={() => {
                if (!loading && inspection && !executing && codeRestoreAvailable) void confirmRewind("code");
              }}
            >
              <div className="sr-mode-copy">
                <span className="sr-mode-title">仅恢复代码快照（保留对话）</span>
                <span className="sr-mode-desc">
                  仅将工作区文件还原到本轮发送前状态，完整保留当前对话记录供对照参考
                </span>
              </div>
              <div className="sr-mode-right">
                {mode === "code" && <Check size={15} color="var(--accent, #006ee4)" />}
                <kbd className="sr-kbd">3</kbd>
              </div>
            </button>
          </div>

          {hasUnsentDraft && (
            <div className="sr-draft-guard-note">
              <MessageSquareReply size={14} />
              <span>检测到输入框内已有未发送草稿，回退后会自动暂存，可在输入框顶部一键切回。</span>
            </div>
          )}
        </div>

        <div className="sr-foot">
          <label className="sr-instant-toggle" title="开启后，若该轮消息没有触发代码文件修改，点击回退图标将直接回退并回填输入框">
            <input
              type="checkbox"
              checked={instantPref}
              onChange={(event) => {
                const next = event.target.checked;
                setInstantPref(next);
                writeInstantOverride(next);
              }}
            />
            <span>无文件改动时直接回退</span>
          </label>

          <div className="sr-foot-actions">
            <button
              type="button"
              className="sr-btn-ghost"
              disabled={executing}
              onClick={() => store.closeDialog(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="sr-btn-primary"
              disabled={loading || executing || !inspection}
              onClick={() => void confirmRewind(mode)}
            >
              {executing ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} strokeWidth={2.1} />}
              <span>{mode === "code" ? "仅恢复代码快照" : "回退并放回输入框"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export const name = "smart-rewind-client";
export const inject = ["contributions", "styles"];

export function apply(ctx: Context, rawConfig: SmartRewindPluginConfig = {}): void {
  const uiStore = new SmartRewindUiStore(rawConfig);
  uiStore.setConfig(rawConfig);
  ctx.styles.inject(SMART_REWIND_CSS, "smart-rewind");

  ctx.effect(() => {
    const offDraftSent = rewindController.onDraftSent(() => {
      uiStore.clearBanner();
    });

    let lastEscAt = 0;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      const cfg = uiStore.getSnapshot().config;
      if (!cfg.doubleEscShortcut) return;
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (uiStore.getSnapshot().dialog?.open) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (getActiveSessionSnapshot().isStreaming) return;
      const turns = rewindController.listRewindableTurns();
      if (turns.length === 0) return;

      const now = Date.now();
      if (now - lastEscAt <= 450) {
        lastEscAt = 0;
        const latest = turns[turns.length - 1];
        if (!latest) return;
        event.preventDefault();
        uiStore.openDialog({
          timelineMode: true,
          selectedMessageId: latest.message.id,
          turns,
        });
      } else {
        lastEscAt = now;
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      offDraftSent();
      uiStore.dispose();
    };
  });

  const openTimeline = (): boolean => {
    if (getActiveSessionSnapshot().isStreaming) {
      showToast("请等待当前回复完成后再打开检查点回退", "warning");
      return true;
    }
    const turns = rewindController.listRewindableTurns();
    const latest = turns[turns.length - 1];
    if (!latest) {
      showToast("当前对话暂无可回退的用户消息", "info");
      return true;
    }
    uiStore.openDialog({
      timelineMode: true,
      selectedMessageId: latest.message.id,
      turns,
    });
    return true;
  };

  ctx.contributions.registerRewindHandler({
    id: "smart-rewind:handler",
    order: 10,
    onOpenTimeline: () => {
      openTimeline();
    },
    onRewindMessage: async (message: UiMessage): Promise<boolean> => {
      const cfg = uiStore.getSnapshot().config;
      const instantOverride = readInstantOverride();
      const effectiveInstant = instantOverride ?? cfg.instantWhenClean;

      const inspected = await rewindController.inspectMessage(message.id);
      if (!inspected) {
        showToast("无法定位这条消息的会话检查点", "warning");
        return false;
      }

      if (effectiveInstant && !inspected.changed) {
        const outcome = await rewindController.performRewind({
          message,
          entryId: inspected.entryId,
          mode: cfg.defaultMode,
          protectDraft: cfg.protectDraft,
        });
        if (outcome) {
          uiStore.setBanner(outcome);
          return true;
        }
        return false;
      }

      const turns = rewindController.listRewindableTurns();
      return await new Promise<boolean>((resolve) => {
        uiStore.openDialog({
          timelineMode: false,
          selectedMessageId: message.id,
          turns: turns.length > 0 ? turns : [{
            message,
            turnNumber: 1,
            totalTurns: 1,
            subsequentMessageCount: inspected.subsequentMessageCount,
          }],
          resolve,
        });
      });
    },
  });

  ctx.contributions.registerSlashInterceptor({
    id: "smart-rewind:slash",
    order: 10,
    onSlashCommand: (name) => {
      if (name.toLowerCase() !== "rewind") return false;
      return openTimeline();
    },
  });

  ctx.contributions.registerComposerBanner({
    id: "smart-rewind:composer-banner",
    order: 10,
    render: () => <ComposerRewindBannerView store={uiStore} />,
  });

  ctx.contributions.registerOverlay({
    id: "smart-rewind:dialog-overlay",
    order: 10,
    render: () => <SmartRewindDialogOverlay store={uiStore} />,
  });
}

export default {
  name,
  inject,
  apply,
};
