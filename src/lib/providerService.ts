/**
 * The model settings page's provider service, on the Harness Host (P6c).
 *
 * It used to be a session-less Pi process that listed Pi's providers and ran
 * OAuth logins; Pi is gone, so the list is the Host's providers.json
 * (src/lib/harnessProviders.ts) and a key is set by editing the provider.
 * The page's interface stays as it was until the store moves to the Host's
 * own shapes (P6d); the Host has no OAuth, so no provider offers a login.
 */
import type { ExtensionUIRequest } from "../types";
import { harnessProviders } from "./harnessProviders";

export type AuthMethod = "oauth" | "api_key";
export type AuthSource = "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";

export interface AuthEventSummary {
  type: "info" | "auth_url" | "device_code" | "progress" | "prompt";
  promptType?: "text" | "secret" | "select" | "manual_code";
  message?: string;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
}

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

export type ProviderDialogRequest = Extract<ExtensionUIRequest, { method: "select" | "input" }>;

const noOAuth = () => Promise.reject(new Error("Harness 不支持 OAuth 登录；请在“模型与连接”里为 provider 填写 API key。"));

export const providerService = {
  list: () => harnessProviders.list(),
  /** The Host reads providers.json on every change; there is nothing to re-read. */
  refresh: (_network = false) => Promise.resolve({ refreshed: true }),
  login: (
    providerId: string,
    method: AuthMethod,
    options: { apiKey?: string; requestId?: string; onAuth?: (event: AuthEventSummary) => void } = {},
  ): Promise<ProviderSummary[]> => (method === "oauth" || !options.apiKey
    ? noOAuth()
    : harnessProviders.setKey(providerId, options.apiKey).then(() => harnessProviders.list())),
  cancel: (_target: string) => Promise.resolve({ cancelled: false }),
  logout: (providerId: string) => harnessProviders.setKey(providerId, "").then(() => harnessProviders.list()),
  check: async (providerId: string, _modelId: string) => {
    const started = Date.now();
    const result = await harnessProviders.check(providerId);
    if (!result.ok) throw new Error(result.message);
    return { latencyMs: Date.now() - started };
  },
  onDialog: (_handler: (request: ProviderDialogRequest) => void): (() => void) => () => undefined,
  respond: (_request: ExtensionUIRequest, _value: string | undefined) => Promise.resolve(),
  stop: () => Promise.resolve(),
};
