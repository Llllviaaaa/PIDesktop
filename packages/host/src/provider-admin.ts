/**
 * Editing providers.json from the settings page (P5c): `provider.configs`,
 * `provider.save`, `provider.delete` and `provider.discover`.
 *
 * A key typed into the form is stored in secrets.dat (DPAPI, ADR 0013) and
 * referenced as `{ secret: "provider/<id>" }`; a `$VAR` key becomes
 * `{ env }`. Nothing here writes a key into providers.json. After a change
 * the host reloads, so the adapters pick it up at once.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { LlmError, type ModelInfo, type SecretRef } from "@pid/llm";
import { AnthropicAdapter } from "@pid/llm-anthropic";
import { OpenAiCompatAdapter } from "@pid/llm-openai-compat";
import { ErrorCode } from "@pid/protocol";
import { entryProblem, type ProviderEntry } from "./providers.ts";
import { RpcError } from "./rpc.ts";
import { readSecretFile, writeSecretFile, type SecretCodec } from "./secrets.ts";

export const name = "pid-provider-admin";
export const inject = ["rpc", "credentials"];

export interface Config {
  file: string;
  secretsFile: string;
  codec?: SecretCodec;
  /** Reload the host's plugins after providers.json changed. */
  reload: () => Promise<unknown>;
}

/** A provider as the form edits it. `apiKey` is the typed key; empty keeps or clears as `keepExistingApiKey` says. */
export interface ProviderDraft {
  originalId?: string | null;
  id: string;
  name?: string;
  baseUrl?: string;
  api: "openai-compat" | "anthropic";
  apiKey?: string;
  keepExistingApiKey?: boolean;
  headers?: Record<string, string>;
  models?: ModelInfo[];
}

/** A configured provider for the form: everything but the key, and where the key comes from. */
export interface ProviderConfigInfo extends Omit<ProviderEntry, "apiKey"> {
  keySource: "none" | "stored" | "environment";
}

const secretId = (provider: string) => `provider/${provider}`;

function readFile(file: string): { providers: unknown[]; [key: string]: unknown } {
  if (!existsSync(file)) return { providers: [] };
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const value = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { ...value, providers: Array.isArray(value.providers) ? value.providers : [] };
}

function writeFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

function keySource(ref: SecretRef | undefined): ProviderConfigInfo["keySource"] {
  if (ref === undefined) return "none";
  return "env" in ref ? "environment" : "stored";
}

/** The key reference a typed key stands for, or undefined to store it as a secret. */
export function keyRef(key: string): SecretRef | "secret" {
  const env = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(key.trim());
  if (env?.[1] !== undefined) return { env: env[1] };
  if (key.trim().startsWith("!")) throw new RpcError(ErrorCode.InvalidParams, "The harness does not run key commands; paste the key or use $VARIABLE");
  return "secret";
}

function invalid(message: string): never {
  throw new RpcError(ErrorCode.InvalidParams, message);
}

export function apply(ctx: Context, config: Config): void {
  const secrets = () => (config.codec === undefined ? {} : readSecretFile<Record<string, string>>(config.secretsFile, config.codec));
  const writeSecrets = (value: Record<string, string>) => {
    if (config.codec === undefined) invalid("No secret store is available on this platform; use $VARIABLE for the key");
    writeSecretFile(config.secretsFile, value, config.codec);
  };

  /** The entry a draft describes, with its key resolved; `previous` supplies a kept key. */
  const entryOf = (draft: ProviderDraft, previous: ProviderEntry | undefined): { entry: ProviderEntry; secret?: string } => {
    const entry: ProviderEntry = {
      api: draft.api,
      id: draft.id.trim(),
      ...(draft.name?.trim() ? { name: draft.name.trim() } : {}),
      ...(draft.baseUrl?.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
      ...(draft.headers !== undefined && Object.keys(draft.headers).length > 0 ? { headers: draft.headers } : {}),
      ...(draft.models !== undefined && draft.models.length > 0 ? { models: draft.models } : {}),
    };
    const typed = draft.apiKey?.trim() ?? "";
    let secret: string | undefined;
    if (typed !== "") {
      const ref = keyRef(typed);
      if (ref === "secret") {
        entry.apiKey = { secret: secretId(entry.id) };
        secret = typed;
      } else {
        entry.apiKey = ref;
      }
    } else if (draft.keepExistingApiKey && previous?.apiKey !== undefined) {
      entry.apiKey = "secret" in previous.apiKey ? { secret: secretId(entry.id) } : previous.apiKey;
    }
    const problem = entryProblem(entry);
    if (problem !== undefined) invalid(problem);
    return { entry, ...(secret === undefined ? {} : { secret }) };
  };

  const methods: Record<string, (params: Record<string, unknown>, signal: AbortSignal) => unknown> = {
    "provider.configs": (): { providers: ProviderConfigInfo[] } => ({
      providers: readFile(config.file).providers
        .filter((value): value is ProviderEntry => entryProblem(value) === undefined)
        .map(({ apiKey, ...rest }) => ({ ...rest, keySource: keySource(apiKey) })),
    }),

    "provider.save": async (params) => {
      const draft = params.provider as ProviderDraft | undefined;
      if (typeof draft !== "object" || draft === null || typeof draft.id !== "string") invalid("provider.save needs { provider }");
      const file = readFile(config.file);
      const entries = file.providers as ProviderEntry[];
      const originalId = draft.originalId ?? draft.id;
      const previous = entries.find((entry) => entry?.id === originalId);
      if (draft.originalId == null && previous !== undefined) invalid(`A provider named ${draft.id} already exists`);
      if (draft.id !== originalId && entries.some((entry) => entry?.id === draft.id)) invalid(`A provider named ${draft.id} already exists`);
      const { entry, secret } = entryOf(draft, previous);

      const stored = secrets();
      const next = { ...stored };
      if (originalId !== entry.id) delete next[secretId(originalId)];
      if (secret !== undefined) next[secretId(entry.id)] = secret;
      else if (entry.apiKey !== undefined && "secret" in entry.apiKey && originalId !== entry.id && stored[secretId(originalId)] !== undefined) {
        next[secretId(entry.id)] = stored[secretId(originalId)] as string;
      }
      if (entry.apiKey === undefined || !("secret" in entry.apiKey)) delete next[secretId(entry.id)];
      if (JSON.stringify(next) !== JSON.stringify(stored)) writeSecrets(next);

      const index = entries.findIndex((item) => item?.id === originalId);
      const providers = index < 0 ? [...entries, entry] : entries.map((item, at) => (at === index ? entry : item));
      const defaultModel = file.defaultModel as { provider?: string } | undefined;
      writeFile(config.file, {
        ...file,
        providers,
        ...(defaultModel?.provider === originalId && originalId !== entry.id ? { defaultModel: { ...defaultModel, provider: entry.id } } : {}),
      });
      await config.reload();
      return { provider: { ...entry, apiKey: undefined, keySource: keySource(entry.apiKey) } };
    },

    "provider.delete": async (params) => {
      const id = params.id;
      if (typeof id !== "string") invalid("provider.delete needs { id }");
      const file = readFile(config.file);
      const providers = (file.providers as ProviderEntry[]).filter((entry) => entry?.id !== id);
      if (providers.length === file.providers.length) invalid(`No provider named ${id}`);
      writeFile(config.file, { ...file, providers });
      const stored = secrets();
      if (stored[secretId(id)] !== undefined) {
        const next = { ...stored };
        delete next[secretId(id)];
        writeSecrets(next);
      }
      await config.reload();
      return {};
    },

    /** The models an unsaved provider offers, with the typed key or the one already stored. */
    "provider.discover": async (params, signal): Promise<{ models: ModelInfo[] }> => {
      const draft = params.provider as ProviderDraft | undefined;
      if (typeof draft !== "object" || draft === null || typeof draft.id !== "string") invalid("provider.discover needs { provider }");
      const previous = (readFile(config.file).providers as ProviderEntry[]).find((entry) => entry?.id === (draft.originalId ?? draft.id));
      const { entry, secret } = entryOf({ ...draft, models: [] }, previous);
      // Discovery never writes: a typed key is used as it is, a kept one through its stored reference.
      const apiKey: SecretRef | undefined = secret !== undefined
        ? { value: secret }
        : entry.apiKey !== undefined && "secret" in entry.apiKey && previous?.apiKey !== undefined ? previous.apiKey : entry.apiKey;
      const adapter = entry.api === "anthropic"
        ? new AnthropicAdapter(ctx, { id: entry.id, ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }), ...(apiKey === undefined ? {} : { apiKey }), ...(entry.headers === undefined ? {} : { headers: entry.headers }) })
        : new OpenAiCompatAdapter(ctx, { id: entry.id, baseUrl: entry.baseUrl ?? "", ...(apiKey === undefined ? {} : { apiKey }), ...(entry.headers === undefined ? {} : { headers: entry.headers }) });
      try {
        return { models: await adapter.listModels(signal) };
      } catch (error) {
        if (error instanceof LlmError) throw new RpcError(ErrorCode.ProviderError, error.message, error.toInfo());
        throw error;
      }
    },
  };

  for (const [method, handler] of Object.entries(methods)) {
    ctx.effect(() => ctx.rpc.method(method, (params, call) => handler((params ?? {}) as Record<string, unknown>, call.signal)), `${name}: ${method}`);
  }
}
