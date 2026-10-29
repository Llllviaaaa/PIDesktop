/**
 * The one-time import of Pi's `models.json` into providers.json (ADR 0013).
 *
 * Pi's providers map onto the two harness adapters by their `api`:
 * `openai-completions` → `openai-compat`, `anthropic-messages` → `anthropic`.
 * A key written out moves to secrets.dat as `{ secret: "provider/<id>" }`; a
 * pure `$VAR` / `${VAR}` reference becomes `{ env }`. What cannot be carried
 * over (other APIs, `!command` keys) is reported, not guessed at.
 *
 * Keys of Pi's built-in providers live in `auth.json` instead; those move
 * once too, for the built-ins the harness can reach (pi-builtins.ts).
 */
import { PI_BUILTINS } from "./pi-builtins.ts";
import type { ProviderEntry } from "./providers.ts";

export interface PiImport {
  providers: ProviderEntry[];
  /** Keys to add to secrets.dat, by secret id. */
  secrets: Record<string, string>;
  problems: string[];
}

const API_MAP: Record<string, ProviderEntry["api"]> = {
  "openai-completions": "openai-compat",
  "anthropic-messages": "anthropic",
};

const ID = /^[a-z0-9][a-z0-9._-]*$/i;

function models(value: unknown): NonNullable<ProviderEntry["models"]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const model = item as Record<string, unknown>;
    if (typeof model?.id !== "string" || model.id.trim() === "") return [];
    const input = Array.isArray(model.input) ? model.input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image") : undefined;
    return [{
      id: model.id.trim(),
      ...(typeof model.name === "string" ? { name: model.name } : {}),
      ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
      ...(typeof model.maxTokens === "number" ? { maxOutputTokens: model.maxTokens } : {}),
      ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
      ...(input !== undefined && input.length > 0 ? { input } : {}),
    }];
  });
}

/** Set `entry.apiKey` from a Pi key: `$VAR` stays a reference, a written key moves to the secrets. */
function takeKey(entry: ProviderEntry, raw: string, result: PiImport): void {
  const key = raw.trim();
  const env = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(key);
  if (env?.[1] !== undefined) {
    entry.apiKey = { env: env[1] };
  } else if (key.startsWith("!")) {
    result.problems.push(`${entry.id}: the key comes from a command, which the harness does not run; enter the key again`);
  } else if (key !== "") {
    const secretId = `provider/${entry.id}`;
    result.secrets[secretId] = key;
    entry.apiKey = { secret: secretId };
  }
}

/**
 * The built-in providers Pi has an API key for in `auth.json`, as providers.json
 * entries. `existing` providers are left alone: what providers.json already
 * says wins. OAuth logins do not carry over and are reported.
 */
export function importPiAuth(authJson: unknown, existing: ReadonlySet<string>): PiImport {
  const result: PiImport = { providers: [], secrets: {}, problems: [] };
  if (typeof authJson !== "object" || authJson === null || Array.isArray(authJson)) return result;
  for (const [id, raw] of Object.entries(authJson as Record<string, unknown>)) {
    if (existing.has(id)) continue;
    const credential = raw as { type?: unknown; key?: unknown } | null;
    if (credential?.type === "oauth") {
      result.problems.push(`${id}: signed in with OAuth, which the harness does not support; add an API key instead`);
      continue;
    }
    if (credential?.type !== "api_key" || typeof credential.key !== "string" || credential.key.trim() === "") continue;
    const builtin = PI_BUILTINS[id];
    if (builtin === undefined) {
      result.problems.push(`${id}: not a built-in provider the harness can reach`);
      continue;
    }
    const entry: ProviderEntry = { api: builtin.api, id, name: builtin.name, baseUrl: builtin.baseUrl };
    takeKey(entry, credential.key, result);
    if (entry.apiKey !== undefined) result.providers.push(entry);
  }
  return result;
}

export function importPiModels(modelsJson: unknown): PiImport {
  const result: PiImport = { providers: [], secrets: {}, problems: [] };
  const entries = (modelsJson as { providers?: unknown } | null)?.providers;
  if (typeof entries !== "object" || entries === null) return result;
  for (const [id, raw] of Object.entries(entries as Record<string, unknown>)) {
    const source = raw as Record<string, unknown>;
    const api = API_MAP[typeof source?.api === "string" ? source.api : "openai-completions"];
    if (!ID.test(id)) {
      result.problems.push(`${id}: the id has characters providers.json does not allow`);
      continue;
    }
    if (api === undefined) {
      result.problems.push(`${id}: the ${String(source.api)} API is not supported by the harness yet`);
      continue;
    }
    const baseUrl = typeof source.baseUrl === "string" ? source.baseUrl.trim() : "";
    if (api === "openai-compat" && !/^https?:\/\//.test(baseUrl)) {
      result.problems.push(`${id}: no http(s) baseUrl`);
      continue;
    }
    const entry: ProviderEntry = { api, id, ...(typeof source.name === "string" ? { name: source.name } : {}) };
    if (/^https?:\/\//.test(baseUrl)) entry.baseUrl = baseUrl;
    takeKey(entry, typeof source.apiKey === "string" ? source.apiKey : "", result);
    if (typeof source.headers === "object" && source.headers !== null && Object.values(source.headers).every((value) => typeof value === "string")) {
      entry.headers = source.headers as Record<string, string>;
    }
    const list = models(source.models);
    if (list.length > 0) entry.models = list;
    result.providers.push(entry);
  }
  return result;
}
