/**
 * Frontend Intelligent UI engine (`src/lib/intelligentUi.ts`).
 *
 * Powers Qianji's built-in `intelligent-ui` plugin with:
 * 1. Versioned widget extraction across session turns (`render_ui`, `update_ui`, and ```intelligent-ui fences)
 * 2. A zero-eval, CSP-safe recursive-descent expression parser for live formulas
 * 3. A Cool-Gray Minimalist sandboxed HTML escape pod (`sandbox="allow-scripts"` + `connect-src 'none'`)
 */
import type { UiMessage, UiToolCall } from "../types";
import { normalizedToolName } from "./toolPresentation";

export const INTELLIGENT_UI_FENCE_LANGUAGE = "intelligent-ui";
export const INTELLIGENT_UI_CANVAS_TAB_ID = "intelligent-ui-canvas";
export const INTELLIGENT_UI_COMPOSER_ACTION_ID = "intelligent-ui-trigger";

export * from "./intelligentUiFormula";
export * from "./intelligentUiSandbox";

export type IntelligentUiEngine = "declarative" | "html";
export type IntelligentUiStateValue = number | string | boolean;
export type IntelligentUiStateMap = Record<string, IntelligentUiStateValue>;

export interface IntelligentUiControlOption {
  label: string;
  value: string | number;
}

export interface IntelligentUiControlItem {
  key: string;
  label: string;
  kind: "slider" | "number" | "text" | "select" | "toggle";
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  help?: string;
  options?: IntelligentUiControlOption[];
}

export interface IntelligentUiStatItem {
  label: string;
  formula?: string;
  value?: string | number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  caption?: string;
  tone?: "default" | "accent" | "good" | "warn";
}

export interface IntelligentUiChartDatum {
  label: string;
  value?: number;
  formula?: string;
  secondaryValue?: number;
  secondaryFormula?: string;
  tone?: "accent" | "muted" | "good" | "warn";
}

export interface IntelligentUiTableColumn {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  sortable?: boolean;
}

export interface IntelligentUiChecklistItem {
  id: string;
  label: string;
  detail?: string;
  checked?: boolean;
}

export interface IntelligentUiTabItem {
  id: string;
  label: string;
  content?: string;
  blocks?: IntelligentUiBlock[];
}

export type IntelligentUiBlock =
  | {
      type: "controls";
      title?: string;
      columns?: number;
      items: IntelligentUiControlItem[];
    }
  | {
      type: "stats";
      title?: string;
      columns?: number;
      items: IntelligentUiStatItem[];
    }
  | {
      type: "chart";
      title?: string;
      subtitle?: string;
      kind?: "bar" | "line" | "area" | "donut";
      unit?: string;
      secondaryLabel?: string;
      height?: number;
      series: IntelligentUiChartDatum[];
    }
  | {
      type: "table";
      title?: string;
      searchable?: boolean;
      columns: IntelligentUiTableColumn[];
      rows: Array<Record<string, unknown>>;
    }
  | {
      type: "tabs";
      items: IntelligentUiTabItem[];
    }
  | {
      type: "form";
      title?: string;
      description?: string;
      submitLabel?: string;
      promptTemplate?: string;
      fields?: IntelligentUiControlItem[];
    }
  | {
      type: "callout";
      tone?: "neutral" | "info" | "warn" | "good";
      title?: string;
      body: string;
    }
  | {
      type: "checklist";
      title?: string;
      submitLabel?: string;
      promptTemplate?: string;
      items: IntelligentUiChecklistItem[];
    };

export interface IntelligentUiDeclarativeSpec {
  state?: IntelligentUiStateMap;
  blocks: IntelligentUiBlock[];
}

export interface IntelligentUiArtifact {
  id: string;
  version: number;
  title: string;
  subtitle?: string;
  engine: IntelligentUiEngine;
  spec?: IntelligentUiDeclarativeSpec;
  html?: string;
  updatedAt: string;
  running?: boolean;
}

export interface IntelligentUiVersionGroup {
  id: string;
  versions: IntelligentUiArtifact[];
  latest: IntelligentUiArtifact;
}

export interface TurnWidgetRef {
  id: string;
  version: number;
  action: "render" | "update" | "fence";
}

export interface SessionIntelligentUiSummary {
  groupsById: Map<string, IntelligentUiVersionGroup>;
  orderedGroups: IntelligentUiVersionGroup[];
  turnWidgetsByMessageId: Map<string, TurnWidgetRef[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeWidgetId(raw: unknown, fallback = "widget"): string {
  if (typeof raw !== "string") return fallback;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, 80);
}

function coerceStateMap(raw: unknown): IntelligentUiStateMap {
  if (!isRecord(raw)) return {};
  const result: IntelligentUiStateMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    } else if (typeof value === "string" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

function parseDeclarativeSpec(raw: unknown): IntelligentUiDeclarativeSpec | undefined {
  let candidate: unknown = raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(candidate) || !Array.isArray(candidate.blocks) || candidate.blocks.length === 0) {
    return undefined;
  }
  const blocks = candidate.blocks.filter(
    (item): item is IntelligentUiBlock => isRecord(item) && typeof item.type === "string" && item.type.trim() !== "",
  );
  if (blocks.length === 0) return undefined;
  return {
    state: coerceStateMap(candidate.state),
    blocks,
  };
}

/**
 * Extracts initial default state for a declarative spec, combining `spec.state`
 * with sensible defaults inferred from `controls` / `form.fields`.
 */
export function buildInitialWidgetState(spec?: IntelligentUiDeclarativeSpec): IntelligentUiStateMap {
  if (!spec) return {};
  const merged: IntelligentUiStateMap = { ...(spec.state ?? {}) };
  const seedControl = (item: IntelligentUiControlItem) => {
    if (!item?.key || item.key in merged) return;
    if (item.kind === "toggle") {
      merged[item.key] = false;
    } else if (item.kind === "select") {
      const first = item.options?.[0]?.value;
      merged[item.key] = first !== undefined ? first : "";
    } else if (item.kind === "slider" || item.kind === "number") {
      merged[item.key] = typeof item.min === "number" ? item.min : 0;
    } else {
      merged[item.key] = "";
    }
  };
  const walkBlocks = (blocks: readonly IntelligentUiBlock[]) => {
    for (const block of blocks) {
      if (block.type === "controls" && Array.isArray(block.items)) {
        block.items.forEach(seedControl);
      } else if (block.type === "form" && Array.isArray(block.fields)) {
        block.fields.forEach(seedControl);
      } else if (block.type === "tabs" && Array.isArray(block.items)) {
        for (const tab of block.items) {
          if (Array.isArray(tab.blocks)) walkBlocks(tab.blocks);
        }
      }
    }
  };
  walkBlocks(spec.blocks);
  return merged;
}

/* ============================================================================
 * Artifact Extraction & Version History Derivation
 * ========================================================================== */

function artifactFromDetails(details: unknown): IntelligentUiArtifact | null {
  if (!isRecord(details) || typeof details.id !== "string" || typeof details.title !== "string") {
    return null;
  }
  const engine: IntelligentUiEngine = details.engine === "html" ? "html" : "declarative";
  if (engine === "html") {
    if (typeof details.html !== "string" || !details.html.trim()) return null;
    return {
      id: normalizeWidgetId(details.id),
      version: typeof details.version === "number" && details.version > 0 ? details.version : 1,
      title: details.title.trim(),
      ...(typeof details.subtitle === "string" && details.subtitle.trim() ? { subtitle: details.subtitle.trim() } : {}),
      engine: "html",
      html: details.html,
      updatedAt: typeof details.updatedAt === "string" ? details.updatedAt : new Date(0).toISOString(),
    };
  }
  const spec = parseDeclarativeSpec(details.spec);
  if (!spec) return null;
  return {
    id: normalizeWidgetId(details.id),
    version: typeof details.version === "number" && details.version > 0 ? details.version : 1,
    title: details.title.trim(),
    ...(typeof details.subtitle === "string" && details.subtitle.trim() ? { subtitle: details.subtitle.trim() } : {}),
    engine: "declarative",
    spec,
    updatedAt: typeof details.updatedAt === "string" ? details.updatedAt : new Date(0).toISOString(),
  };
}

function artifactFromToolCall(
  call: UiToolCall,
  toolName: "render_ui" | "update_ui",
  previous: IntelligentUiArtifact | undefined,
  fallbackTimestamp: number,
): IntelligentUiArtifact | null {
  if (call.isError) return null;

  const fromDetails = artifactFromDetails(call.details);
  if (fromDetails) {
    return {
      ...fromDetails,
      version: previous ? Math.max(previous.version + 1, fromDetails.version) : fromDetails.version,
      running: call.running === true,
    };
  }

  const args = isRecord(call.args) ? call.args : {};
  const rawId = typeof args.id === "string" && args.id.trim() ? args.id : previous?.id;
  if (!rawId) return null;
  const id = normalizeWidgetId(rawId);
  const title = typeof args.title === "string" && args.title.trim()
    ? args.title.trim()
    : previous?.title;
  if (!title) return null;

  const subtitle = typeof args.subtitle === "string" && args.subtitle.trim()
    ? args.subtitle.trim()
    : previous?.subtitle;
  const hasHtml = typeof args.html === "string" && args.html.trim() !== "";
  const parsedSpec = parseDeclarativeSpec(args.spec);
  const engine: IntelligentUiEngine = args.engine === "html" || (hasHtml && !parsedSpec && args.engine !== "declarative")
    ? "html"
    : args.engine === "declarative" || parsedSpec
      ? "declarative"
      : previous?.engine ?? "declarative";

  const version = (previous?.version ?? 0) + 1;
  const updatedAt = new Date(call.finishedAt ?? call.startedAt ?? fallbackTimestamp).toISOString();

  if (engine === "html") {
    const html = hasHtml ? String(args.html).trim() : previous?.html;
    if (!html) return null;
    return {
      id,
      version,
      title,
      ...(subtitle ? { subtitle } : {}),
      engine: "html",
      html,
      updatedAt,
      running: call.running === true,
    };
  }

  let spec = parsedSpec ?? (previous?.spec ? { ...previous.spec, state: { ...(previous.spec.state ?? {}) } } : undefined);
  if (!spec) return null;
  if (toolName === "update_ui" && isRecord(args.state)) {
    spec = {
      ...spec,
      state: {
        ...(spec.state ?? {}),
        ...coerceStateMap(args.state),
      },
    };
  }

  return {
    id,
    version,
    title,
    ...(subtitle ? { subtitle } : {}),
    engine: "declarative",
    spec,
    updatedAt,
    running: call.running === true,
  };
}

export function parseIntelligentUiFence(rawText: string, fallbackId = "inline-widget"): IntelligentUiArtifact | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return null;
    const id = normalizeWidgetId(parsed.id, fallbackId);
    const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "交互式组件";
    const subtitle = typeof parsed.subtitle === "string" && parsed.subtitle.trim() ? parsed.subtitle.trim() : undefined;
    if (parsed.engine === "html" || (typeof parsed.html === "string" && parsed.html.trim())) {
      return {
        id,
        version: 1,
        title,
        ...(subtitle ? { subtitle } : {}),
        engine: "html",
        html: String(parsed.html).trim(),
        updatedAt: new Date(0).toISOString(),
      };
    }
    const spec = parseDeclarativeSpec(parsed.spec ?? parsed);
    if (!spec) return null;
    return {
      id,
      version: 1,
      title,
      ...(subtitle ? { subtitle } : {}),
      engine: "declarative",
      spec,
      updatedAt: new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function extractIntelligentUiFences(markdown: string, messageId: string): IntelligentUiArtifact[] {
  if (!markdown.includes(INTELLIGENT_UI_FENCE_LANGUAGE)) return [];
  const artifacts: IntelligentUiArtifact[] = [];
  const fenceRegex = /```intelligent-ui[ \t]*\r?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = fenceRegex.exec(markdown)) !== null) {
    index += 1;
    const artifact = parseIntelligentUiFence(match[1] ?? "", `fence-${messageId}-${index}`);
    if (artifact) artifacts.push(artifact);
  }
  return artifacts;
}

const sessionIntelligentUiCache = new WeakMap<readonly UiMessage[], SessionIntelligentUiSummary>();

export function messageMayContainIntelligentUi(message: UiMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  if (message.content && message.content.includes(INTELLIGENT_UI_FENCE_LANGUAGE)) return true;
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      const normalized = normalizedToolName(call.name);
      if (normalized === "render_ui" || normalized === "update_ui") return true;
    }
  }
  return false;
}

export function deriveSessionIntelligentUis(messages: readonly UiMessage[]): SessionIntelligentUiSummary {
  const cached = sessionIntelligentUiCache.get(messages);
  if (cached) return cached;

  const groupsById = new Map<string, IntelligentUiVersionGroup>();
  const orderedIds: string[] = [];
  const turnWidgetsByMessageId = new Map<string, TurnWidgetRef[]>();

  const recordArtifact = (
    messageId: string,
    artifact: IntelligentUiArtifact,
    action: TurnWidgetRef["action"],
  ) => {
    let group = groupsById.get(artifact.id);
    if (!group) {
      group = {
        id: artifact.id,
        versions: [artifact],
        latest: artifact,
      };
      groupsById.set(artifact.id, group);
      orderedIds.push(artifact.id);
    } else {
      const nextVersion = group.versions.length + 1;
      const versioned: IntelligentUiArtifact = { ...artifact, version: nextVersion };
      group.versions.push(versioned);
      group.latest = versioned;
      artifact = versioned;
    }

    const turnList = turnWidgetsByMessageId.get(messageId) ?? [];
    const existingIdx = turnList.findIndex((item) => item.id === artifact.id);
    const nextRef: TurnWidgetRef = { id: artifact.id, version: artifact.version, action };
    if (existingIdx >= 0) {
      turnList[existingIdx] = nextRef;
    } else {
      turnList.push(nextRef);
    }
    turnWidgetsByMessageId.set(messageId, turnList);
  };

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const calls = message.toolCalls ?? [];
    const renderedIdsInTurn = new Set<string>();

    for (const call of calls) {
      const normalized = normalizedToolName(call.name);
      if (normalized !== "render_ui" && normalized !== "update_ui") continue;
      const rawId = isRecord(call.args) && typeof call.args.id === "string"
        ? normalizeWidgetId(call.args.id)
        : undefined;
      const previous = rawId ? groupsById.get(rawId)?.latest : undefined;
      const artifact = artifactFromToolCall(call, normalized, previous, message.timestamp);
      if (!artifact) continue;
      renderedIdsInTurn.add(artifact.id);
      recordArtifact(message.id, artifact, normalized === "render_ui" ? "render" : "update");
    }

    // Also register standalone ```intelligent-ui fences so they appear in the Canvas workbench too,
    // without duplicating widgets already emitted via tool calls in the same turn.
    if (message.content) {
      const fenced = extractIntelligentUiFences(message.content, message.id);
      for (const item of fenced) {
        if (renderedIdsInTurn.has(item.id)) continue;
        const previous = groupsById.get(item.id)?.latest;
        const artifact: IntelligentUiArtifact = {
          ...item,
          version: (previous?.version ?? 0) + 1,
          updatedAt: new Date(message.timestamp).toISOString(),
        };
        const existingGroup = groupsById.get(artifact.id);
        if (!existingGroup) {
          groupsById.set(artifact.id, { id: artifact.id, versions: [artifact], latest: artifact });
          orderedIds.push(artifact.id);
        } else {
          existingGroup.versions.push(artifact);
          existingGroup.latest = artifact;
        }
      }
    }
  }

  const orderedGroups: IntelligentUiVersionGroup[] = [];
  for (const id of orderedIds) {
    const grp = groupsById.get(id);
    if (grp) orderedGroups.push(grp);
  }

  const summary: SessionIntelligentUiSummary = {
    groupsById,
    orderedGroups,
    turnWidgetsByMessageId,
  };
  sessionIntelligentUiCache.set(messages, summary);
  return summary;
}
