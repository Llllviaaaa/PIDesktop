/**
 * Schema validation, normalization, and session-branch version tracking for
 * `@qianji/intelligent-ui`.
 */

export const NAMESPACE = "qianji-intelligent-ui";
export const LEGACY_NAMESPACE = "pid-intelligent-ui";
export const MAX_PAYLOAD_BYTES = 96 * 1024;
export const MAX_WIDGET_ID_LEN = 80;
export const MAX_TITLE_LEN = 120;
export const MAX_SUBTITLE_LEN = 240;

export type IntelligentUiEngine = "declarative" | "html";

export type IntelligentUiStateValue = number | string | boolean;
export type IntelligentUiStateMap = Record<string, IntelligentUiStateValue>;

export interface IntelligentUiArtifact {
  id: string;
  version: number;
  title: string;
  subtitle?: string;
  engine: IntelligentUiEngine;
  spec?: Record<string, unknown>;
  html?: string;
  updatedAt: string;
}

export interface RenderUiInput {
  id: string;
  title: string;
  subtitle?: string;
  engine?: string;
  spec?: Record<string, unknown> | string;
  html?: string;
}

export interface UpdateUiInput {
  id: string;
  title?: string;
  subtitle?: string;
  engine?: string;
  spec?: Record<string, unknown> | string;
  html?: string;
  state?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeWidgetId(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error('Widget "id" must be a non-empty string.');
  }
  const trimmed = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!trimmed) {
    throw new Error('Widget "id" must contain at least one alphanumeric character.');
  }
  return trimmed.slice(0, MAX_WIDGET_ID_LEN);
}

function normalizeTitle(raw: unknown, fallback?: string): string {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error('Widget "title" must be a non-empty string.');
  }
  return raw.trim().slice(0, MAX_TITLE_LEN);
}

function normalizeSubtitle(raw: unknown, fallback?: string): string | undefined {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, MAX_SUBTITLE_LEN) : undefined;
}

function parseSpecInput(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (isRecord(raw)) {
    const serialized = JSON.stringify(raw);
    if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new Error(`Declarative "spec" exceeds maximum size (${MAX_PAYLOAD_BYTES} bytes).`);
    }
    return raw;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    if (Buffer.byteLength(raw, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new Error(`Declarative "spec" exceeds maximum size (${MAX_PAYLOAD_BYTES} bytes).`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Declarative "spec" string is not valid JSON: ${(error as Error).message}`, { cause: error });
    }
    if (!isRecord(parsed)) {
      throw new Error('Declarative "spec" must be a JSON object with a "blocks" array.');
    }
    return parsed;
  }
  throw new Error('Declarative "spec" must be an object (e.g. { state: {...}, blocks: [...] }).');
}

function validateDeclarativeSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const blocks = spec.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('Declarative "spec" requires a non-empty "blocks" array.');
  }
  for (const [index, block] of blocks.entries()) {
    if (!isRecord(block) || typeof block.type !== "string" || !block.type.trim()) {
      throw new Error(`spec.blocks[${index}] must be an object with a "type" string.`);
    }
  }
  if (spec.state !== undefined && !isRecord(spec.state)) {
    throw new Error('spec.state must be a key-value object when provided.');
  }
  return spec;
}

function validateHtmlPayload(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error('HTML engine requires a non-empty "html" string.');
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error(`"html" exceeds maximum size (${MAX_PAYLOAD_BYTES} bytes).`);
  }
  return raw.trim();
}

function resolveEngine(rawEngine: unknown, hasSpec: boolean, hasHtml: boolean, fallback?: IntelligentUiEngine): IntelligentUiEngine {
  if (rawEngine === "declarative" || rawEngine === "dil") return "declarative";
  if (rawEngine === "html") return "html";
  if (rawEngine !== undefined) {
    throw new Error('Widget "engine" must be "declarative" or "html".');
  }
  if (hasHtml && !hasSpec) return "html";
  if (hasSpec) return "declarative";
  return fallback ?? "declarative";
}

export function buildRenderedArtifact(
  input: RenderUiInput,
  previous?: IntelligentUiArtifact,
  now = new Date(),
): IntelligentUiArtifact {
  const id = normalizeWidgetId(input.id);
  const title = normalizeTitle(input.title, previous?.title);
  const subtitle = normalizeSubtitle(input.subtitle, previous?.subtitle);
  const spec = parseSpecInput(input.spec);
  const hasHtml = typeof input.html === "string" && input.html.trim() !== "";
  const engine = resolveEngine(input.engine, spec !== undefined, hasHtml);

  const version = (previous?.version ?? 0) + 1;
  const updatedAt = now.toISOString();

  if (engine === "html") {
    const html = validateHtmlPayload(input.html);
    return {
      id,
      version,
      title,
      ...(subtitle === undefined ? {} : { subtitle }),
      engine: "html",
      html,
      updatedAt,
    };
  }

  if (spec === undefined) {
    throw new Error('render_ui with engine "declarative" requires a "spec" object (or set engine: "html" and pass "html").');
  }
  const validSpec = validateDeclarativeSpec(spec);
  return {
    id,
    version,
    title,
    ...(subtitle === undefined ? {} : { subtitle }),
    engine: "declarative",
    spec: validSpec,
    updatedAt,
  };
}

export function buildUpdatedArtifact(
  input: UpdateUiInput,
  previous: IntelligentUiArtifact | undefined,
  now = new Date(),
): IntelligentUiArtifact {
  const id = normalizeWidgetId(input.id);
  if (previous === undefined && input.title === undefined) {
    throw new Error(`No existing widget "${id}" in this session; provide "title" and a full payload to create it.`);
  }
  const title = normalizeTitle(input.title, previous?.title);
  const subtitle = normalizeSubtitle(input.subtitle, previous?.subtitle);
  const parsedSpec = parseSpecInput(input.spec);
  const hasHtml = typeof input.html === "string" && input.html.trim() !== "";
  const engine = resolveEngine(input.engine, parsedSpec !== undefined, hasHtml, previous?.engine);
  const version = (previous?.version ?? 0) + 1;
  const updatedAt = now.toISOString();

  if (engine === "html") {
    const nextHtml = hasHtml ? validateHtmlPayload(input.html) : previous?.html;
    if (!nextHtml) {
      throw new Error(`Widget "${id}" uses engine "html" and requires an "html" string.`);
    }
    return {
      id,
      version,
      title,
      ...(subtitle === undefined ? {} : { subtitle }),
      engine: "html",
      html: nextHtml,
      updatedAt,
    };
  }

  let baseSpec: Record<string, unknown> | undefined = parsedSpec ?? (previous?.spec ? { ...previous.spec } : undefined);
  if (baseSpec === undefined) {
    throw new Error(`Widget "${id}" requires a declarative "spec" object.`);
  }
  if (isRecord(input.state)) {
    const prevState = isRecord(baseSpec.state) ? baseSpec.state : {};
    baseSpec = {
      ...baseSpec,
      state: { ...prevState, ...input.state },
    };
  }
  const validSpec = validateDeclarativeSpec(baseSpec);
  return {
    id,
    version,
    title,
    ...(subtitle === undefined ? {} : { subtitle }),
    engine: "declarative",
    spec: validSpec,
    updatedAt,
  };
}
