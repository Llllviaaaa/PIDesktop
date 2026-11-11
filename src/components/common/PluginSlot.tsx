import type { CSSProperties } from "react";
import {
  useClientContributions,
  type MessageActionSlotContext,
  type WorkbenchSlotContext,
} from "../../lib/clientContributions";
import { SlotEntryHost } from "./ErrorBoundary";

export interface PluginSlotContextMap {
  leftSidebar: WorkbenchSlotContext;
  topbarActions: WorkbenchSlotContext;
  composerToolbar: WorkbenchSlotContext;
  composerStatus: WorkbenchSlotContext;
  composerBanners: WorkbenchSlotContext;
  overlays: WorkbenchSlotContext;
  "status.bar": WorkbenchSlotContext;
  "message.actions": MessageActionSlotContext;
}

export type PluginSlotName = keyof PluginSlotContextMap;

export interface PluginSlotProps<N extends PluginSlotName> {
  name: N;
  context: PluginSlotContextMap[N];
  compact?: boolean;
  itemClassName?: string;
  itemStyle?: CSSProperties;
  /** Optional sub-filter for `composerStatus` (`"before-model"` | `"after-model"`). */
  position?: "before-model" | "after-model";
  /** Optional sub-filter for `status.bar` (`"left"` | `"right"`). */
  align?: "left" | "right";
  /** Optional role filter for `message.actions` (`"user"` | `"assistant"`). */
  messageRole?: "user" | "assistant";
}

/**
 * Declarative typed `<PluginSlot>` host component.
 * Subscribes to `useClientContributions()` and isolates every registered entry
 * inside `<SlotEntryHost>` (`[data-qj-plugin]` + `<SlotErrorBoundary>` + `<SlotRenderBody>`).
 */
export function PluginSlot<N extends PluginSlotName>({
  name,
  context,
  compact = false,
  itemClassName,
  itemStyle,
  position,
  align,
  messageRole,
}: PluginSlotProps<N>) {
  const contributions = useClientContributions();

  if (name === "message.actions") {
    const msgCtx = context as MessageActionSlotContext;
    const targetRole = messageRole ?? (msgCtx.message.role === "user" ? "user" : "assistant");
    const items = contributions.messageActions.filter(
      (item) => item.role === undefined || item.role === "both" || item.role === targetRole,
    );
    if (items.length === 0) return null;
    return (
      <>
        {items.map((item) => (
          <SlotEntryHost
            key={item.id}
            entry={item}
            context={msgCtx}
            slotName="message.actions"
            compact
            className={itemClassName}
            style={itemStyle}
          />
        ))}
      </>
    );
  }

  const wbCtx = context as WorkbenchSlotContext;

  if (name === "composerStatus") {
    const items = contributions.composerStatus.filter((item) =>
      position === undefined
        ? true
        : position === "before-model"
          ? item.position === "before-model"
          : item.position !== "before-model",
    );
    if (items.length === 0) return null;
    return (
      <>
        {items.map((item) => (
          <SlotEntryHost
            key={item.id}
            entry={item}
            context={wbCtx}
            slotName="composerStatus"
            compact={compact}
            className={itemClassName}
            style={itemStyle}
          />
        ))}
      </>
    );
  }

  if (name === "status.bar") {
    const items = contributions.statusBarItems.filter((item) =>
      align === undefined
        ? true
        : align === "right"
          ? item.align === "right"
          : item.align !== "right",
    );
    if (items.length === 0) return null;
    return (
      <>
        {items.map((item) => (
          <SlotEntryHost
            key={item.id}
            entry={item}
            context={wbCtx}
            slotName="status.bar"
            compact
            className={itemClassName}
            style={itemStyle}
          />
        ))}
      </>
    );
  }

  const entries =
    name === "leftSidebar"
      ? contributions.leftSidebar
      : name === "topbarActions"
        ? contributions.topbarActions
        : name === "composerToolbar"
          ? contributions.composerToolbar
          : name === "composerBanners"
            ? contributions.composerBanners
            : contributions.overlays;

  if (entries.length === 0) return null;

  return (
    <>
      {entries.map((entry) => (
        <SlotEntryHost
          key={entry.id}
          entry={entry}
          context={wbCtx}
          slotName={name}
          compact={compact}
          className={itemClassName}
          style={itemStyle}
        />
      ))}
    </>
  );
}
