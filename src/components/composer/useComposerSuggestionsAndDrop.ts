import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { imageAttachmentFromBlob } from "../../lib/attachments";
import type { AttachmentPayload, SlashCommand, WorkspaceDirEntry } from "../../types";
import { MAX_COMMAND_MATCHES, MAX_MENTION_RESULTS } from "./composerHelpers";

export interface UseComposerSuggestionsAndDropOptions {
  text: string;
  setText: (next: string) => void;
  caret: number;
  setCaret: (next: number) => void;
  disabled?: boolean;
  commands: SlashCommand[];
  cardRef: React.RefObject<HTMLDivElement | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  suggestionMenuRef: React.RefObject<HTMLDivElement | null>;
  onAttachFiles?: (paths: string[]) => void;
  onAttachPayloads?: (attachments: AttachmentPayload[]) => void;
  onSearchFiles?: (query: string, signal: AbortSignal) => Promise<WorkspaceDirEntry[]>;
}

export function useComposerSuggestionsAndDrop({
  text,
  setText,
  caret,
  setCaret,
  disabled,
  commands,
  cardRef,
  textareaRef,
  suggestionMenuRef,
  onAttachFiles,
  onAttachPayloads,
  onSearchFiles,
}: UseComposerSuggestionsAndDropOptions) {
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissedFor, setSuggestionsDismissedFor] = useState<string | null>(null);
  const suggestionsId = useId();
  const [fileResults, setFileResults] = useState<{ query: string; entries: WorkspaceDirEntry[] } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const attachFilesRef = useRef(onAttachFiles);
  useEffect(() => {
    attachFilesRef.current = onAttachFiles;
  }, [onAttachFiles]);

  const canAttachFiles = Boolean(onAttachFiles) && !disabled;
  useSyncOnChange([canAttachFiles], () => {
    if (!canAttachFiles) setDragOver(false);
  });

  useEffect(() => {
    if (!canAttachFiles || !("__TAURI_INTERNALS__" in window)) return;
    const overCard = (position: { x: number; y: number }) => {
      const rect = cardRef.current?.getBoundingClientRect();
      if (!rect) return false;
      const x = position.x / window.devicePixelRatio;
      const y = position.y / window.devicePixelRatio;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === "leave") {
          setDragOver(false);
          return;
        }
        const over = overCard(payload.position);
        if (payload.type === "drop") {
          setDragOver(false);
          if (over && payload.paths.length > 0) attachFilesRef.current?.(payload.paths);
          return;
        }
        setDragOver(over);
      }),
    ).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [canAttachFiles, cardRef]);

  const attachImageFiles = async (files: File[]) => {
    const payloads = (await Promise.all(files.map(imageAttachmentFromBlob)))
      .filter((item): item is AttachmentPayload => item !== null);
    if (payloads.length > 0) onAttachPayloads?.(payloads);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onAttachPayloads || disabled) return;
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (images.length === 0 || event.clipboardData.getData("text/plain")) return;
    event.preventDefault();
    void attachImageFiles(images);
  };

  const browserDrop = Boolean(onAttachPayloads) && !disabled && !("__TAURI_INTERNALS__" in window);

  const commandQuery = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const commandMatches = useMemo(
    () => (commandQuery === null
      ? []
      : commands
          .filter((command) => command.name.toLowerCase().includes(commandQuery))
          .sort((left, right) => Number(!left.name.toLowerCase().startsWith(commandQuery)) - Number(!right.name.toLowerCase().startsWith(commandQuery)))
          .slice(0, MAX_COMMAND_MATCHES)),
    [commandQuery, commands],
  );
  const suggestionsDismissed = suggestionsDismissedFor === text;
  const commandMenuOpen = commandMatches.length > 0 && !suggestionsDismissed;
  const activeCommand = commandMenuOpen ? commandMatches[Math.min(suggestionIndex, commandMatches.length - 1)] : undefined;
  const chooseCommand = (command: SlashCommand) => {
    setText(`/${command.name} `);
    textareaRef.current?.focus();
  };

  const mention = useMemo(() => {
    if (!onSearchFiles || disabled) return null;
    const match = /(^|\s)@([^\s@"]*)$/.exec(text.slice(0, caret));
    const matchedQuery = match?.[2];
    return matchedQuery !== undefined ? { query: matchedQuery, start: caret - matchedQuery.length - 1 } : null;
  }, [caret, disabled, onSearchFiles, text]);
  const mentionQuery = mention?.query ?? null;
  const mentionMenuOpen = mention !== null && !commandMenuOpen && !suggestionsDismissed;
  const mentionEntries = fileResults?.entries ?? [];
  const mentionLoading = mentionMenuOpen && fileResults?.query !== mentionQuery;
  useSyncOnChange([mentionMenuOpen], () => {
    if (!mentionMenuOpen) setFileResults(null);
  });
  const activeEntry = mentionMenuOpen ? mentionEntries[Math.min(suggestionIndex, mentionEntries.length - 1)] : undefined;

  const searchFilesRef = useRef(onSearchFiles);
  useEffect(() => {
    searchFilesRef.current = onSearchFiles;
  }, [onSearchFiles]);

  useEffect(() => {
    if (!mentionMenuOpen || mentionQuery === null) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (searchFilesRef.current?.(mentionQuery, controller.signal) ?? Promise.resolve([]))
        .catch((): WorkspaceDirEntry[] => [])
        .then((entries) => {
          if (!controller.signal.aborted) setFileResults({ query: mentionQuery, entries: entries.slice(0, MAX_MENTION_RESULTS) });
        });
    }, mentionQuery === "" || mentionQuery.endsWith("/") ? 0 : 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mentionMenuOpen, mentionQuery]);

  const chooseEntry = (entry: WorkspaceDirEntry, enterFolder: boolean) => {
    if (!mention) return;
    const quoted = /\s/.test(entry.path);
    const keepBrowsing = enterFolder && entry.isDir && !quoted;
    const reference = quoted ? `@"${entry.path}"` : `@${entry.path}`;
    const inserted = keepBrowsing ? `${reference}/` : `${reference}${entry.isDir ? "/" : ""} `;
    const next = `${text.slice(0, mention.start)}${inserted}${text.slice(caret)}`;
    const nextCaret = mention.start + inserted.length;
    setText(next);
    setCaret(nextCaret);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const suggestionCount = commandMenuOpen ? commandMatches.length : mentionMenuOpen ? mentionEntries.length : 0;
  useSyncOnChange([commandQuery, mentionQuery], () => setSuggestionIndex(0));
  useEffect(() => {
    if (suggestionCount === 0) return;
    suggestionMenuRef.current
      ?.querySelector<HTMLElement>(`[data-suggestion-index="${suggestionIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [suggestionCount, suggestionIndex, suggestionMenuRef]);

  return {
    dragOver, setDragOver, browserDrop, attachImageFiles, handlePaste,
    suggestionIndex, setSuggestionIndex, setSuggestionsDismissedFor, suggestionsId,
    commandMatches, commandMenuOpen, activeCommand, chooseCommand,
    mentionQuery, mentionMenuOpen, mentionEntries, mentionLoading, activeEntry, chooseEntry,
    suggestionCount,
  };
}
