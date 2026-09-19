// Pure helpers for the Pi Desktop provider service extension. Kept free of Pi
// runtime imports so the protocol and summaries can be tested directly.

export const PROVIDER_SERVICE_COMMAND = "pidesktop-providers";
export const PROVIDER_SERVICE_PREFIX = "pidesktop-providers:";

export type AuthMethod = "oauth" | "api_key";
export type AuthSource = "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";

export type ProviderRequest =
  | { id: string; op: "list" }
  | { id: string; op: "refresh"; network: boolean }
  | { id: string; op: "login"; providerId: string; method: AuthMethod; apiKey?: string }
  | { id: string; op: "cancel"; target: string }
  | { id: string; op: "logout"; providerId: string }
  | { id: string; op: "check"; providerId: string; modelId: string };

export interface AuthEventSummary {
  type: "info" | "auth_url" | "device_code" | "progress" | "prompt";
  /** For "prompt": the Pi auth prompt type answered through the next dialog request. */
  promptType?: "text" | "secret" | "select" | "manual_code";
  message?: string;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
}

export type ProviderServiceMessage =
  | { id: string; type: "result"; result: unknown }
  | { id: string; type: "error"; message: string }
  | { id: string; type: "auth"; event: AuthEventSummary };

export interface ProviderModelSummary {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number | null;
  maxTokens: number | null;
  cost: { input: number; output: number } | null;
}

export interface ProviderSummary {
  id: string;
  name: string;
  // Named *Method so the Rust secret redactor, which masks "apiKey"/"token"-like keys, leaves these labels alone.
  oauthMethod: string | null;
  apiKeyMethod: string | null;
  configured: boolean;
  authType: AuthMethod | null;
  source: AuthSource | null;
  sourceLabel: string | null;
  builtin: boolean;
  baseUrl: string;
  models: ProviderModelSummary[];
}

export interface ProviderLike {
  id: string;
  name?: string;
  baseUrl?: string;
  auth?: { oauth?: { name?: string }; apiKey?: { name?: string } };
}

export interface AuthStatusLike {
  configured?: boolean;
  source?: string;
  label?: string;
}

export interface ModelLike {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: readonly string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number };
}

const AUTH_SOURCES = new Set<AuthSource>(["stored", "runtime", "environment", "fallback", "models_json_key", "models_json_command"]);
const OPS = new Set(["list", "refresh", "login", "cancel", "logout", "check"]);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

export function parseProviderRequest(args: string): ProviderRequest {
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    throw new Error("Provider service request must be JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider service request must be an object");
  const raw = value as Record<string, unknown>;
  const id = requiredString(raw.id, "id");
  const op = requiredString(raw.op, "op");
  if (!OPS.has(op)) throw new Error(`Unknown provider service operation: ${op}`);
  switch (op) {
    case "list":
      return { id, op };
    case "refresh":
      return { id, op, network: raw.network === true };
    case "login": {
      const method = requiredString(raw.method, "method");
      if (method !== "oauth" && method !== "api_key") throw new Error(`Unknown login method: ${method}`);
      const apiKey = typeof raw.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : undefined;
      return { id, op, providerId: requiredString(raw.providerId, "providerId"), method, apiKey };
    }
    case "cancel":
      return { id, op, target: requiredString(raw.target, "target") };
    case "logout":
      return { id, op, providerId: requiredString(raw.providerId, "providerId") };
    default:
      return { id, op: "check", providerId: requiredString(raw.providerId, "providerId"), modelId: requiredString(raw.modelId, "modelId") };
  }
}

export function encodeProviderMessage(message: ProviderServiceMessage): string {
  return PROVIDER_SERVICE_PREFIX + JSON.stringify(message);
}

export function decodeProviderMessage(text: string): ProviderServiceMessage | null {
  if (!text.startsWith(PROVIDER_SERVICE_PREFIX)) return null;
  try {
    const value = JSON.parse(text.slice(PROVIDER_SERVICE_PREFIX.length)) as ProviderServiceMessage;
    return value && typeof value.id === "string" && typeof value.type === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Collect provider IDs from the runtime's builtin registry, whatever collection shape it uses. */
export function collectProviderIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  const add = (item: unknown) => {
    if (typeof item === "string") ids.add(item);
    else if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") ids.add((item as { id: string }).id);
  };
  if (value instanceof Map) for (const [key, item] of value) { add(key); add(item); }
  else if (value instanceof Set || Array.isArray(value)) for (const item of value) add(item);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { add(key); add(item); }
  return ids;
}

export function summarizeModel(model: ModelLike): ProviderModelSummary {
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  const cost = model.cost && (typeof model.cost.input === "number" || typeof model.cost.output === "number")
    ? { input: model.cost.input ?? 0, output: model.cost.output ?? 0 }
    : null;
  return {
    id: model.id,
    name: model.name?.trim() || model.id,
    reasoning: model.reasoning === true,
    input: [...(model.input ?? ["text"])],
    contextWindow: finite(model.contextWindow),
    maxTokens: finite(model.maxTokens),
    cost,
  };
}

export function summarizeProvider(
  provider: ProviderLike,
  status: AuthStatusLike | undefined,
  usingOAuth: boolean,
  models: readonly ModelLike[],
  builtinIds: ReadonlySet<string>,
): ProviderSummary {
  const configured = status?.configured === true;
  const source = typeof status?.source === "string" && AUTH_SOURCES.has(status.source as AuthSource)
    ? status.source as AuthSource
    : null;
  return {
    id: provider.id,
    name: provider.name?.trim() || provider.id,
    oauthMethod: provider.auth?.oauth?.name ?? null,
    apiKeyMethod: provider.auth?.apiKey?.name ?? null,
    configured,
    authType: configured ? (usingOAuth ? "oauth" : "api_key") : null,
    source: configured ? source : null,
    sourceLabel: configured ? status?.label ?? null : null,
    builtin: builtinIds.has(provider.id),
    baseUrl: provider.baseUrl ?? "",
    models: models.map(summarizeModel),
  };
}

export function summarizeAuthEvent(event: Record<string, unknown>): AuthEventSummary | null {
  const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
  switch (event.type) {
    case "auth_url":
      return { type: "auth_url", url: text(event.url), instructions: text(event.instructions) };
    case "device_code":
      return { type: "device_code", userCode: text(event.userCode), verificationUri: text(event.verificationUri) };
    case "info":
    case "progress":
      return { type: event.type, message: text(event.message) };
    default:
      return null;
  }
}

/** A supplied API key answers the first secret prompt; every other prompt needs the user. */
export function shouldAutoAnswerSecret(promptType: string, apiKey: string | undefined, alreadyUsed: boolean): boolean {
  return promptType === "secret" && Boolean(apiKey) && !alreadyUsed;
}
