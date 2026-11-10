/**
 * Client-side Checkpoint Rewind & Composer Draft SDK (`rewindController`).
 *
 * Bridges Qianji's live Composer input/attachments, `useAppStore` session
 * rewind actions, and Host Git checkpoints (`checkpoint.list` / `checkpoint.diff` /
 * `checkpoint.restore`), and is exposed to dynamic client plugins via `@qianji/client`.
 */
import type { AttachmentPayload, UiMessage } from "../types";
import { useAppStore } from "../store";
import {
  harnessRuntimes,
  type RewindExecutionResult,
  type RewindInspection,
  type RewindMode,
} from "./harnessRuntime";

export type { RewindExecutionResult, RewindInspection, RewindMode };

export interface ComposerDraftSnapshot {
  text: string;
  attachments: AttachmentPayload[];
}

export interface RewindTurnSummary {
  message: UiMessage;
  turnNumber: number;
  totalTurns: number;
  subsequentMessageCount: number;
}

export interface RewindTargetSummary extends RewindTurnSummary {
  entryId: string;
  sessionId: string;
  userSeq: number;
  hasCheckpoint: boolean;
  changed: boolean;
  files: string[];
}

export interface PerformedRewindResult {
  ok: true;
  mode: RewindMode;
  entryId: string;
  sessionId: string;
  turnNumber: number;
  totalTurns: number;
  toSeq: number;
  rewindSeq?: number;
  restoredFiles: string[];
  refilledText: string;
  refilledAttachments: AttachmentPayload[];
  stashedDraft: ComposerDraftSnapshot | null;
}

interface ComposerTextBridge {
  getText: () => string;
  setText: (text: string, focus: boolean) => void;
}

interface ComposerAttachmentBridge {
  getAttachments: () => AttachmentPayload[];
  setAttachments: (attachments: AttachmentPayload[]) => void;
}

/** Convert persisted `UiMessage.images` back into editable Composer `AttachmentPayload`s. */
export function messageImagesToAttachments(message: Pick<UiMessage, "id" | "images">): AttachmentPayload[] {
  return (message.images ?? []).map((image, index) => ({
    path: `rewind-image-${message.id}-${index}`,
    fileName: `image-${index + 1}.${image.mimeType.split("/")[1] || "png"}`,
    mimeType: image.mimeType,
    size: Math.floor(image.data.length * 0.75),
    kind: "image",
    data: image.data,
  }));
}

function cloneAttachments(items: readonly AttachmentPayload[]): AttachmentPayload[] {
  return items.map((item) => ({ ...item }));
}

function isRealUserTurn(message: UiMessage): boolean {
  if (message.role !== "user") return false;
  if (message.id.startsWith("slash-")) return false;
  const hasImages = Boolean(message.images && message.images.length > 0);
  return message.content.trim() !== "" || hasImages;
}

class RewindController {
  private textBridge: ComposerTextBridge | null = null;
  private attachmentBridge: ComposerAttachmentBridge | null = null;
  private readonly draftListeners = new Set<() => void>();

  bindTextBridge(bridge: ComposerTextBridge): () => void {
    this.textBridge = bridge;
    return () => {
      if (this.textBridge === bridge) {
        this.textBridge = null;
      }
    };
  }

  bindAttachmentBridge(bridge: ComposerAttachmentBridge): () => void {
    this.attachmentBridge = bridge;
    return () => {
      if (this.attachmentBridge === bridge) {
        this.attachmentBridge = null;
      }
    };
  }

  notifyDraftSent(): void {
    for (const listener of this.draftListeners) listener();
  }

  onDraftSent(listener: () => void): () => void {
    this.draftListeners.add(listener);
    return () => {
      this.draftListeners.delete(listener);
    };
  }

  getComposerDraft(): ComposerDraftSnapshot {
    return {
      text: this.textBridge?.getText() ?? useAppStore.getState().composerPrefill ?? "",
      attachments: cloneAttachments(this.attachmentBridge?.getAttachments() ?? []),
    };
  }

  setComposerDraft(options: {
    text: string;
    attachments?: AttachmentPayload[];
    focus?: boolean;
  }): void {
    const focus = options.focus !== false;
    if (options.attachments !== undefined) {
      this.attachmentBridge?.setAttachments(cloneAttachments(options.attachments));
    }
    if (this.textBridge !== null) {
      this.textBridge.setText(options.text, focus);
    } else {
      useAppStore.setState({ composerPrefill: options.text });
    }
  }

  listRewindableTurns(): RewindTurnSummary[] {
    const messages = useAppStore.getState().messages;
    const entries: Array<{ message: UiMessage; msgIdx: number }> = [];
    for (let idx = 0; idx < messages.length; idx += 1) {
      const candidate = messages[idx];
      if (candidate && isRealUserTurn(candidate)) {
        entries.push({ message: candidate, msgIdx: idx });
      }
    }
    const totalTurns = entries.length;
    return entries.map((entry, turnIdx) => ({
      message: entry.message,
      turnNumber: turnIdx + 1,
      totalTurns,
      subsequentMessageCount: Math.max(0, messages.length - 1 - entry.msgIdx),
    }));
  }

  async inspectMessage(messageId: string): Promise<RewindTargetSummary | null> {
    const state = useAppStore.getState();
    const turns = this.listRewindableTurns();
    const turn = turns.find((item) => item.message.id === messageId);
    const fallbackMsg = state.messages.find((item) => item.id === messageId);
    const targetMsg = turn?.message ?? fallbackMsg;
    if (!targetMsg || targetMsg.role !== "user") return null;

    const point = await state.resolveMessageForkPoint(messageId);
    if (!point) return null;

    const runtimeId = state.runtimeId;
    let inspection: RewindInspection = {
      entryId: point.entryId,
      sessionId: state.sessionId ?? "",
      userSeq: Number(point.entryId),
      hasCheckpoint: false,
      changed: false,
      files: [],
    };
    if (runtimeId) {
      inspection = await harnessRuntimes.inspectRewind(runtimeId, point.entryId);
    }

    const msgIdx = state.messages.findIndex((item) => item.id === messageId);
    return {
      message: targetMsg,
      turnNumber: turn?.turnNumber ?? 1,
      totalTurns: turn?.totalTurns ?? Math.max(1, turns.length),
      subsequentMessageCount: turn?.subsequentMessageCount ?? Math.max(0, state.messages.length - 1 - Math.max(0, msgIdx)),
      entryId: point.entryId,
      sessionId: inspection.sessionId,
      userSeq: inspection.userSeq,
      hasCheckpoint: inspection.hasCheckpoint,
      changed: inspection.changed,
      files: inspection.files,
    };
  }

  async performRewind(params: {
    message: UiMessage;
    entryId?: string;
    mode?: RewindMode;
    protectDraft?: boolean;
  }): Promise<PerformedRewindResult | null> {
    const mode = params.mode ?? "both";
    const protectDraft = params.protectDraft !== false;
    const state = useAppStore.getState();
    if (state.isStreaming) {
      state.showToast("请等待当前回复完成后再回退消息", "warning");
      return null;
    }

    const turns = this.listRewindableTurns();
    const turn = turns.find((item) => item.message.id === params.message.id);
    const turnNumber = turn?.turnNumber ?? 1;
    const totalTurns = turn?.totalTurns ?? Math.max(1, turns.length);

    let entryId = params.entryId;
    if (!entryId) {
      const point = await state.resolveMessageForkPoint(params.message.id);
      if (!point) {
        state.showToast("无法定位这条消息的会话检查点", "warning");
        return null;
      }
      entryId = point.entryId;
    }

    const previousDraft = this.getComposerDraft();
    const hasDifferentText = previousDraft.text.trim() !== ""
      && previousDraft.text.trim() !== params.message.content.trim();
    const hasExistingAttachments = previousDraft.attachments.length > 0;
    const shouldStash = protectDraft && mode !== "code" && (hasDifferentText || hasExistingAttachments);

    const outcome = await state.rewindMessageWithMode(entryId, mode);
    if (!outcome) return null;

    const restoredAttachments = mode === "code" ? [] : messageImagesToAttachments(params.message);
    if (mode !== "code") {
      this.setComposerDraft({
        text: params.message.content,
        attachments: restoredAttachments,
        focus: true,
      });
    }

    return {
      ok: true,
      mode,
      entryId,
      sessionId: outcome.sessionId,
      turnNumber,
      totalTurns,
      toSeq: outcome.toSeq,
      ...(outcome.rewindSeq === undefined ? {} : { rewindSeq: outcome.rewindSeq }),
      restoredFiles: outcome.restoredFiles,
      refilledText: mode === "code" ? "" : params.message.content,
      refilledAttachments: restoredAttachments,
      stashedDraft: shouldStash ? previousDraft : null,
    };
  }

  async undoBranchRewind(params: {
    sessionId: string;
    rewindSeq: number;
    restoreDraft?: ComposerDraftSnapshot | null;
  }): Promise<boolean> {
    const state = useAppStore.getState();
    if (state.isStreaming) {
      state.showToast("请等待当前回复完成后再撤销回退", "warning");
      return false;
    }
    await harnessRuntimes.call("smartRewind.undoBranch", {
      sessionId: params.sessionId,
      rewindSeq: params.rewindSeq,
    });
    await state.syncActiveSession();
    const nextDraft = params.restoreDraft ?? { text: "", attachments: [] };
    this.setComposerDraft({
      text: nextDraft.text,
      attachments: nextDraft.attachments,
      focus: true,
    });
    return true;
  }
}

export const rewindController = new RewindController();
