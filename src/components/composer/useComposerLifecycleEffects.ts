import { useEffect, useRef } from "react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { rewindController } from "../../lib/rewindController";

export interface UseComposerLifecycleEffectsOptions {
  text: string;
  setText: React.Dispatch<React.SetStateAction<string>>;
  setCaret: (next: number) => void;
  textRef: React.MutableRefObject<string>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  scope: "main" | "side";
  prefill?: string | null;
  onPrefillConsumed?: () => void;
  insertRequest?: { text: string; nonce: number } | null;
  defaultFollowUpBehavior: "steer" | "followUp";
  setStreamingBehavior: (next: "steer" | "followUp") => void;
  isStreaming: boolean;
  setStreamingMenuOpen: (next: boolean) => void;
  isSwitchingModel: boolean;
  setModelMenuOpen: (next: boolean) => void;
  workspaceOpen: boolean;
  setWorkspaceOpen: (next: boolean) => void;
  setWorkspaceQuery: (next: string) => void;
  environmentOpen: boolean;
  setEnvironmentOpen: (next: boolean) => void;
  actionsOpen: boolean;
  setActionsOpen: (next: boolean) => void;
  permissionOpen: boolean;
  setPermissionOpen: (next: boolean) => void;
  modelMenuOpen: boolean;
  streamingMenuOpen: boolean;
}

export function useComposerLifecycleEffects({
  text,
  setText,
  setCaret,
  textRef,
  textareaRef,
  disabled,
  scope,
  prefill,
  onPrefillConsumed,
  insertRequest,
  defaultFollowUpBehavior,
  setStreamingBehavior,
  isStreaming,
  setStreamingMenuOpen,
  isSwitchingModel,
  setModelMenuOpen,
  workspaceOpen,
  setWorkspaceOpen,
  setWorkspaceQuery,
  environmentOpen,
  setEnvironmentOpen,
  actionsOpen,
  setActionsOpen,
  permissionOpen,
  setPermissionOpen,
  modelMenuOpen,
  streamingMenuOpen,
}: UseComposerLifecycleEffectsOptions) {
  const resizeFrameRef = useRef<number | null>(null);

  useEffect(() => {
    textRef.current = text;
  }, [text, textRef]);

  useEffect(() => {
    if (disabled || scope !== "main") return undefined;
    return rewindController.bindTextBridge({
      getText: () => textRef.current,
      setText: (nextText, focus) => {
        textRef.current = nextText;
        setText(nextText);
        setCaret(nextText.length);
        if (focus) {
          window.requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (!el) return;
            el.focus();
            el.setSelectionRange(nextText.length, nextText.length);
          });
        }
      },
    });
  }, [disabled, scope, setCaret, setText, textRef, textareaRef]);

  useSyncOnChange([prefill], () => {
    if (prefill !== null && prefill !== undefined) {
      setText(prefill);
      setCaret(prefill.length);
    }
  });

  useEffect(() => {
    if (prefill === null || prefill === undefined) return;
    textRef.current = prefill;
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(prefill.length, prefill.length);
    });
    onPrefillConsumed?.();
  }, [onPrefillConsumed, prefill, textRef, textareaRef]);

  useSyncOnChange([insertRequest?.nonce], () => {
    if (!insertRequest) return;
    setText((current) => (current.trim() ? `${current.replace(/\s+$/, "")}\n\n${insertRequest.text}` : insertRequest.text));
  });
  useEffect(() => {
    if (insertRequest) textareaRef.current?.focus();
  }, [insertRequest, textareaRef]);

  useSyncOnChange([defaultFollowUpBehavior], () => {
    setStreamingBehavior(defaultFollowUpBehavior);
  });
  useSyncOnChange([isStreaming], () => {
    if (!isStreaming) setStreamingMenuOpen(false);
  });
  useSyncOnChange([isSwitchingModel], () => {
    if (isSwitchingModel) setModelMenuOpen(false);
  });

  useEffect(() => {
    if (!workspaceOpen && !environmentOpen && !actionsOpen && !permissionOpen && !modelMenuOpen && !streamingMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (workspaceOpen && !target.closest(".workspace-context-wrap")) {
        setWorkspaceOpen(false);
        setWorkspaceQuery("");
      }
      if (environmentOpen && !target.closest(".environment-context-wrap")) setEnvironmentOpen(false);
      if (actionsOpen && !target.closest(".composer-actions-menu, .composer-add-trigger, .chip-agent-mode")) setActionsOpen(false);
      if (permissionOpen && !target.closest(".permission-context-wrap")) setPermissionOpen(false);
      if (modelMenuOpen && !target.closest(".model-picker-wrap")) setModelMenuOpen(false);
      if (streamingMenuOpen && !target.closest(".streaming-behavior-wrap")) setStreamingMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [
    actionsOpen, environmentOpen, modelMenuOpen, permissionOpen,
    setActionsOpen, setEnvironmentOpen, setModelMenuOpen, setPermissionOpen,
    setStreamingMenuOpen, setWorkspaceOpen, setWorkspaceQuery, streamingMenuOpen, workspaceOpen,
  ]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element || resizeFrameRef.current !== null) return;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
    });
  }, [text, textareaRef]);

  useEffect(() => () => {
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
  }, []);
}
