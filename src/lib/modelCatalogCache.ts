import type { ModelInfo } from "../types";

const MODEL_CATALOG_STORAGE_KEY = "pid-desktop:model-catalog:v1";
const MAX_CACHED_MODELS = 1_000;

export interface CachedModelCatalog {
  models: ModelInfo[];
  selected: ModelInfo | null;
}

function isModelInfo(value: unknown): value is ModelInfo {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<ModelInfo>;
  return typeof model.id === "string"
    && model.id.length > 0
    && typeof model.name === "string"
    && typeof model.provider === "string"
    && model.provider.length > 0;
}

export function parseModelCatalogCache(value: unknown): CachedModelCatalog {
  if (!value || typeof value !== "object") return { models: [], selected: null };
  const cache = value as Partial<CachedModelCatalog>;
  return {
    models: Array.isArray(cache.models) ? cache.models.filter(isModelInfo).slice(0, MAX_CACHED_MODELS) : [],
    selected: isModelInfo(cache.selected) ? cache.selected : null,
  };
}

export function readStoredModelCatalog(): CachedModelCatalog {
  if (typeof window === "undefined") return { models: [], selected: null };
  try {
    return parseModelCatalogCache(JSON.parse(window.localStorage.getItem(MODEL_CATALOG_STORAGE_KEY) || "{}"));
  } catch {
    return { models: [], selected: null };
  }
}

export function persistModelCatalog(cache: CachedModelCatalog): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_CATALOG_STORAGE_KEY, JSON.stringify(parseModelCatalogCache(cache)));
  } catch {
    // Model discovery must keep working when local storage is unavailable.
  }
}
