import type { AttachmentPayload, ResourceItem } from "../types";

export type BuiltinPetCharacter = "cat" | "robot" | "fox";
export type AppearanceScope = "builtin" | "user" | "project";
export type PetAnimationState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export interface PetAnimationSequence {
  row: number;
  frames: number;
  frameDurationMs: number;
  loop: boolean;
}

export interface PetSpritesheetDefinition {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  states: Record<PetAnimationState, PetAnimationSequence>;
}

export interface PetBehaviorDefinition {
  idleAnimations?: Array<Extract<PetAnimationState, "waving" | "jumping">>;
  idleMinMs?: number;
  idleMaxMs?: number;
  messages?: Partial<Record<PetAnimationState, string[]>>;
}

export const DEFAULT_PET_SPRITESHEET: PetSpritesheetDefinition = {
  columns: 8,
  rows: 9,
  cellWidth: 192,
  cellHeight: 208,
  states: {
    idle: { row: 0, frames: 6, frameDurationMs: 220, loop: true },
    "running-right": { row: 1, frames: 8, frameDurationMs: 90, loop: true },
    "running-left": { row: 2, frames: 8, frameDurationMs: 90, loop: true },
    waving: { row: 3, frames: 4, frameDurationMs: 170, loop: true },
    jumping: { row: 4, frames: 5, frameDurationMs: 130, loop: false },
    failed: { row: 5, frames: 8, frameDurationMs: 180, loop: true },
    waiting: { row: 6, frames: 6, frameDurationMs: 230, loop: true },
    running: { row: 7, frames: 6, frameDurationMs: 130, loop: true },
    review: { row: 8, frames: 6, frameDurationMs: 180, loop: true },
  },
};

export interface ThemePalette {
  app: string;
  panel: string;
  panelStrong: string;
  panelSoft: string;
  hover: string;
  active: string;
  border: string;
  borderStrong: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  accentText: string;
  sidebar: string;
}

export interface AppearanceThemeDefinition {
  id: string;
  label: string;
  mode: "system" | "light" | "dark";
  scope: AppearanceScope;
  sourcePath?: string;
  palette?: ThemePalette;
}

export interface AppearancePetDefinition {
  id: string;
  label: string;
  scope: AppearanceScope;
  sourcePath?: string;
  builtinCharacter?: BuiltinPetCharacter;
  assetDataUrl?: string;
  spritesheet?: PetSpritesheetDefinition;
  behavior?: PetBehaviorDefinition;
}

export interface AppearanceCatalogError {
  kind: "theme" | "pet";
  name: string;
  message: string;
}

export interface AppearanceCatalog {
  themes: AppearanceThemeDefinition[];
  pets: AppearancePetDefinition[];
  errors: AppearanceCatalogError[];
}

const LIGHT_PALETTE: ThemePalette = {
  app: "#ffffff",
  panel: "#f4f4f5",
  panelStrong: "#ececee",
  panelSoft: "#f7f7f8",
  hover: "#ebebed",
  active: "#e4e4e7",
  border: "#e4e4e7",
  borderStrong: "#d4d4d8",
  text: "#1a1a1a",
  text2: "#52525b",
  text3: "#a1a1aa",
  accent: "#18181b",
  accentText: "#ffffff",
  sidebar: "#f3f3f4",
};

const DARK_PALETTE: ThemePalette = {
  app: "#0a0a0b",
  panel: "#121214",
  panelStrong: "#1a1a1e",
  panelSoft: "#18181b",
  hover: "#27272a",
  active: "#2e2e33",
  border: "#27272a",
  borderStrong: "#3f3f46",
  text: "#f4f4f5",
  text2: "#a1a1aa",
  text3: "#71717a",
  accent: "#fafafa",
  accentText: "#09090b",
  sidebar: "#0e0e10",
};

export const BUILTIN_APPEARANCE_CATALOG: AppearanceCatalog = {
  themes: [
    { id: "system", label: "跟随系统", mode: "system", scope: "builtin" },
    { id: "light", label: "白色", mode: "light", scope: "builtin", palette: LIGHT_PALETTE },
    { id: "dark", label: "黑色", mode: "dark", scope: "builtin", palette: DARK_PALETTE },
    { id: "custom", label: "自定义", mode: "light", scope: "builtin", palette: LIGHT_PALETTE },
  ],
  pets: [
    { id: "cat", label: "代码猫", scope: "builtin", builtinCharacter: "cat" },
    { id: "robot", label: "小派", scope: "builtin", builtinCharacter: "robot" },
    { id: "fox", label: "灵狐", scope: "builtin", builtinCharacter: "fox" },
  ],
  errors: [],
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return numeric;
}

function parsePetSpritesheet(value: unknown): PetSpritesheetDefinition {
  const manifest = asRecord(value);
  const columns = boundedInteger(manifest.columns, DEFAULT_PET_SPRITESHEET.columns, 1, 64, "spritesheet.columns");
  const rows = boundedInteger(manifest.rows, DEFAULT_PET_SPRITESHEET.rows, 1, 64, "spritesheet.rows");
  const cellWidth = boundedInteger(manifest.cellWidth, DEFAULT_PET_SPRITESHEET.cellWidth, 1, 4096, "spritesheet.cellWidth");
  const cellHeight = boundedInteger(manifest.cellHeight, DEFAULT_PET_SPRITESHEET.cellHeight, 1, 4096, "spritesheet.cellHeight");
  const stateManifest = asRecord(manifest.states);
  const states = Object.fromEntries(
    (Object.entries(DEFAULT_PET_SPRITESHEET.states) as [PetAnimationState, PetAnimationSequence][]).map(([state, defaults]) => {
      const sequence = asRecord(stateManifest[state]);
      return [state, {
        row: boundedInteger(sequence.row, Math.min(defaults.row, rows - 1), 0, rows - 1, `spritesheet.states.${state}.row`),
        frames: boundedInteger(sequence.frames, Math.min(defaults.frames, columns), 1, columns, `spritesheet.states.${state}.frames`),
        frameDurationMs: boundedInteger(sequence.frameDurationMs, defaults.frameDurationMs, 40, 5000, `spritesheet.states.${state}.frameDurationMs`),
        loop: typeof sequence.loop === "boolean" ? sequence.loop : defaults.loop,
      }];
    }),
  ) as Record<PetAnimationState, PetAnimationSequence>;
  return { columns, rows, cellWidth, cellHeight, states };
}

const PET_BEHAVIOR_MESSAGE_STATES: PetAnimationState[] = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
];

function parsePetBehavior(value: unknown): PetBehaviorDefinition | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("behavior 必须是对象");
  const manifest = asRecord(value);
  const behavior: PetBehaviorDefinition = {};

  if (manifest.idleAnimations !== undefined) {
    if (!Array.isArray(manifest.idleAnimations) || manifest.idleAnimations.length > 4) {
      throw new Error("behavior.idleAnimations 必须是最多 4 项的数组");
    }
    const allowed = new Set(["waving", "jumping"]);
    const animations = manifest.idleAnimations.map((entry) => asString(entry));
    if (animations.some((entry) => !allowed.has(entry))) {
      throw new Error("behavior.idleAnimations 仅支持 waving 和 jumping");
    }
    behavior.idleAnimations = [...new Set(animations)] as PetBehaviorDefinition["idleAnimations"];
  }

  if (manifest.idleMinMs !== undefined) {
    behavior.idleMinMs = boundedInteger(manifest.idleMinMs, 18_000, 5_000, 300_000, "behavior.idleMinMs");
  }
  if (manifest.idleMaxMs !== undefined) {
    behavior.idleMaxMs = boundedInteger(manifest.idleMaxMs, 42_000, 5_000, 300_000, "behavior.idleMaxMs");
  }
  if ((behavior.idleMaxMs ?? 42_000) < (behavior.idleMinMs ?? 18_000)) {
    throw new Error("behavior.idleMaxMs 不能小于 behavior.idleMinMs");
  }

  if (manifest.messages !== undefined) {
    if (typeof manifest.messages !== "object" || manifest.messages === null || Array.isArray(manifest.messages)) {
      throw new Error("behavior.messages 必须是对象");
    }
    const messageManifest = asRecord(manifest.messages);
    const messages: Partial<Record<PetAnimationState, string[]>> = {};
    for (const state of PET_BEHAVIOR_MESSAGE_STATES) {
      const raw = messageManifest[state];
      if (raw === undefined) continue;
      const entries = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
      if (entries.length === 0 || entries.length > 8 || entries.some((entry) => typeof entry !== "string")) {
        throw new Error(`behavior.messages.${state} 必须包含 1 到 8 条文本`);
      }
      const normalized = entries.map((entry) => entry.trim());
      if (normalized.some((entry) => !entry || entry.length > 80)) {
        throw new Error(`behavior.messages.${state} 每条必须是 1 到 80 个字符`);
      }
      messages[state] = normalized;
    }
    behavior.messages = messages;
  }

  return behavior;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseJson(text: string, label: string): JsonRecord {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    throw new Error(`${label} 不是有效的 JSON`);
  }
}

function colorFrom(value: unknown, vars: JsonRecord, fallback: string): string {
  const token = asString(value);
  if (!token) return fallback;
  const resolved = asString(vars[token]) || token;
  return /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)$/i.test(resolved)
    ? resolved
    : fallback;
}

function hexLuminance(value: string): number | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const expanded = match[1].length === 3
    ? match[1].split("").map((part) => `${part}${part}`).join("")
    : match[1];
  const channels = [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function normalizedHex(value: string, fallback: string): string {
  const candidate = value.trim();
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : fallback;
}

export function createCustomAppearanceTheme(
  backgroundColor: string,
  foregroundColor: string,
  accentColor: string,
): AppearanceThemeDefinition {
  const app = normalizedHex(backgroundColor, LIGHT_PALETTE.app);
  const text = normalizedHex(foregroundColor, LIGHT_PALETTE.text);
  const accent = normalizedHex(accentColor, LIGHT_PALETTE.accent);
  const mode = (hexLuminance(app) ?? 1) > 0.45 ? "light" : "dark";
  const accentText = (hexLuminance(accent) ?? 0) > 0.45 ? "#101114" : "#ffffff";
  return {
    id: "custom",
    label: "自定义",
    mode,
    scope: "builtin",
    palette: {
      app,
      panel: `color-mix(in srgb, ${text} 6%, ${app})`,
      panelStrong: `color-mix(in srgb, ${text} 10%, ${app})`,
      panelSoft: `color-mix(in srgb, ${text} 4%, ${app})`,
      hover: `color-mix(in srgb, ${text} 9%, ${app})`,
      active: `color-mix(in srgb, ${accent} 14%, ${app})`,
      border: `color-mix(in srgb, ${text} 12%, ${app})`,
      borderStrong: `color-mix(in srgb, ${text} 20%, ${app})`,
      text,
      text2: `color-mix(in srgb, ${text} 72%, ${app})`,
      text3: `color-mix(in srgb, ${text} 48%, ${app})`,
      accent,
      accentText,
      sidebar: `color-mix(in srgb, ${accent} 5%, ${app})`,
    },
  };
}

export function parseAppearanceTheme(text: string, resource: ResourceItem): AppearanceThemeDefinition {
  const manifest = parseJson(text, resource.name);
  const vars = asRecord(manifest.vars);
  const colors = asRecord(manifest.colors);
  const exported = asRecord(manifest.export);
  const name = asString(manifest.name) || resource.name;
  const appCandidate = colorFrom(exported.pageBg, vars, "");
  const mode = (hexLuminance(appCandidate) ?? 0) > 0.45 ? "light" : "dark";
  const defaults = mode === "light" ? LIGHT_PALETTE : DARK_PALETTE;
  const app = appCandidate || defaults.app;
  const panel = colorFrom(exported.cardBg, vars, colorFrom(colors.userMessageBg, vars, defaults.panel));
  const idPart = slug(name) || slug(resource.name);
  if (!idPart) throw new Error("主题缺少可用的 name");
  return {
    id: `theme:${idPart}`,
    label: asString(manifest.label) || name,
    mode,
    scope: resource.scope,
    sourcePath: resource.path,
    palette: {
      ...defaults,
      app,
      panel,
      panelStrong: colorFrom(colors.userMessageBg, vars, panel),
      panelSoft: colorFrom(colors.customMessageBg, vars, defaults.panelSoft),
      hover: colorFrom(colors.selectedBg, vars, defaults.hover),
      active: colorFrom(colors.selectedBg, vars, defaults.active),
      border: colorFrom(colors.borderMuted, vars, defaults.border),
      borderStrong: colorFrom(colors.border, vars, defaults.borderStrong),
      text: colorFrom(colors.text, vars, defaults.text),
      text2: colorFrom(colors.muted, vars, defaults.text2),
      text3: colorFrom(colors.dim, vars, defaults.text3),
      accent: colorFrom(colors.accent, vars, defaults.accent),
      accentText: mode === "light" ? "#ffffff" : "#09090b",
      sidebar: app,
    },
  };
}

function separatorFor(path: string): "/" | "\\" {
  return path.includes("\\") ? "\\" : "/";
}

function manifestPathFor(resource: ResourceItem): string {
  if (/\.json$/i.test(resource.path)) return resource.path;
  return `${resource.path}${separatorFor(resource.path)}pet.json`;
}

function assetPathFor(manifestPath: string, asset: string): string {
  if (!asset || /(^|[\\/])\.\.([\\/]|$)/.test(asset) || /^[a-z]+:/i.test(asset) || /^[\\/]/.test(asset)) {
    throw new Error("asset 必须是 pet.json 同目录下的相对图片路径");
  }
  const separator = separatorFor(manifestPath);
  const parent = manifestPath.replace(/[\\/][^\\/]*$/, "");
  return `${parent}${separator}${asset.replace(/[\\/]+/g, separator)}`;
}

export async function parseAppearancePet(
  text: string,
  resource: ResourceItem,
  readAttachment: (file: string) => Promise<AttachmentPayload>,
  manifestPath = manifestPathFor(resource),
): Promise<AppearancePetDefinition> {
  const manifest = parseJson(text, resource.name);
  const name = asString(manifest.name) || asString(manifest.displayName) || asString(manifest.label) || resource.name;
  const idPart = slug(asString(manifest.id) || name) || slug(resource.name);
  const spritesheetManifest = asRecord(manifest.spritesheet);
  const spritesheetPath = asString(manifest.spritesheetPath)
    || asString(manifest.spritesheet)
    || asString(spritesheetManifest.asset);
  const asset = asString(manifest.asset) || spritesheetPath;
  if (!idPart) throw new Error("宠物缺少可用的 id 或 name");
  if (!asset) throw new Error("宠物清单缺少 asset 或 spritesheetPath");
  const payload = await readAttachment(assetPathFor(manifestPath, asset));
  if (payload.kind !== "image" || !payload.data || !payload.mimeType.startsWith("image/")) {
    throw new Error("asset 不是可读取的图片");
  }
  return {
    id: `pet:${idPart}`,
    label: asString(manifest.label) || asString(manifest.displayName) || name,
    scope: resource.scope,
    sourcePath: manifestPath,
    assetDataUrl: `data:${payload.mimeType};base64,${payload.data}`,
    spritesheet: spritesheetPath || Object.keys(spritesheetManifest).length > 0
      ? parsePetSpritesheet(spritesheetManifest)
      : undefined,
    behavior: parsePetBehavior(manifest.behavior),
  };
}

function mergeDefinitions<T extends { id: string; scope: AppearanceScope }>(builtins: T[], additions: T[]): T[] {
  const byId = new Map(builtins.map((item) => [item.id, item]));
  const ordered = [...additions].sort((left, right) => {
    const rank = (scope: AppearanceScope) => scope === "project" ? 2 : scope === "user" ? 1 : 0;
    return rank(left.scope) - rank(right.scope);
  });
  for (const item of ordered) byId.set(item.id, item);
  return [...byId.values()];
}

export function mergeAppearanceCatalog(
  themes: AppearanceThemeDefinition[],
  pets: AppearancePetDefinition[],
  errors: AppearanceCatalogError[] = [],
): AppearanceCatalog {
  return {
    themes: mergeDefinitions(BUILTIN_APPEARANCE_CATALOG.themes, themes),
    pets: mergeDefinitions(BUILTIN_APPEARANCE_CATALOG.pets, pets),
    errors,
  };
}

export function resolveAppearanceTheme(
  catalog: AppearanceCatalog,
  id: string,
  systemDark: boolean,
): AppearanceThemeDefinition {
  const selected = catalog.themes.find((theme) => theme.id === id)
    ?? catalog.themes.find((theme) => theme.id === "system")
    ?? BUILTIN_APPEARANCE_CATALOG.themes[0];
  if (selected.mode !== "system") return selected;
  const resolvedId = systemDark ? "dark" : "light";
  return catalog.themes.find((theme) => theme.id === resolvedId)
    ?? BUILTIN_APPEARANCE_CATALOG.themes.find((theme) => theme.id === resolvedId)!;
}

export function resolveAppearancePet(catalog: AppearanceCatalog, id: string): AppearancePetDefinition {
  return catalog.pets.find((pet) => pet.id === id)
    ?? catalog.pets.find((pet) => pet.id === "cat")
    ?? BUILTIN_APPEARANCE_CATALOG.pets[0];
}

export async function loadAppearanceCatalog(cwd: string): Promise<AppearanceCatalog> {
  const { pi } = await import("./pi");
  const resources = await pi.listResources(cwd);
  const themes: AppearanceThemeDefinition[] = [];
  const pets: AppearancePetDefinition[] = [];
  const errors: AppearanceCatalogError[] = [];
  await Promise.all(resources.filter((resource) => resource.kind === "theme").map(async (resource) => {
    try {
      const payload = await pi.readAttachment(resource.path);
      if (!payload.text) throw new Error("主题文件不可读取");
      themes.push(parseAppearanceTheme(payload.text, resource));
    } catch (error) {
      errors.push({ kind: "theme", name: resource.name, message: String(error) });
    }
  }));
  await Promise.all(resources.filter((resource) => resource.kind === "pet").map(async (resource) => {
    try {
      const manifestPath = manifestPathFor(resource);
      const payload = await pi.readAttachment(manifestPath);
      if (!payload.text) throw new Error("pet.json 不可读取");
      pets.push(await parseAppearancePet(payload.text, resource, pi.readAttachment, manifestPath));
    } catch (error) {
      errors.push({ kind: "pet", name: resource.name, message: String(error) });
    }
  }));
  return mergeAppearanceCatalog(themes, pets, errors);
}
