import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  collectProviderIds,
  encodeProviderMessage,
  parseProviderRequest,
  PROVIDER_SERVICE_COMMAND,
  shouldAutoAnswerSecret,
  summarizeAuthEvent,
  summarizeProvider,
  type ModelLike,
  type ProviderLike,
  type ProviderRequest,
  type ProviderServiceMessage,
} from "./pidesktop-providers-core.ts";

// Pi's ModelRuntime owns provider auth, catalogs, and credential storage. Extensions only
// receive the ModelRegistry facade, so reach the runtime it wraps for login/logout.
interface AuthPromptLike {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string }[];
  signal?: AbortSignal;
}

interface ModelRuntimeLike {
  builtins?: unknown;
  getProviders(): readonly ProviderLike[];
  getModels(providerId?: string): readonly ModelLike[];
  getModel(providerId: string, modelId: string): unknown;
  getProviderAuthStatus(providerId: string): { configured?: boolean; source?: string; label?: string } | undefined;
  isUsingOAuth(providerId: string): boolean;
  login(providerId: string, method: "oauth" | "api_key", interaction: {
    signal?: AbortSignal;
    prompt(prompt: AuthPromptLike): Promise<string>;
    notify(event: Record<string, unknown>): void;
  }): Promise<unknown>;
  logout(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
  refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
  completeSimple(model: unknown, context: unknown, options?: Record<string, unknown>): Promise<{
    stopReason?: string;
    errorMessage?: string;
    content?: readonly { type: string; text?: string }[];
  }>;
}

interface DialogUi {
  select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

const activeLogins = new Map<string, AbortController>();

function modelRuntime(ctx: { modelRegistry?: unknown }): ModelRuntimeLike {
  const runtime = (ctx.modelRegistry as { runtime?: ModelRuntimeLike } | undefined)?.runtime;
  if (!runtime || typeof runtime.getProviders !== "function" || typeof runtime.login !== "function") {
    throw new Error("This Pi runtime does not expose provider management to Pi Desktop");
  }
  return runtime;
}

function listProviders(runtime: ModelRuntimeLike) {
  const builtinIds = collectProviderIds(runtime.builtins);
  return runtime.getProviders()
    .map((provider) => summarizeProvider(
      provider,
      runtime.getProviderAuthStatus(provider.id),
      runtime.isUsingOAuth(provider.id),
      runtime.getModels(provider.id),
      builtinIds,
    ))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function cancelled(): Error {
  return new Error("Login cancelled");
}

async function login(
  runtime: ModelRuntimeLike,
  request: Extract<ProviderRequest, { op: "login" }>,
  ui: DialogUi,
  reply: (message: ProviderServiceMessage) => void,
) {
  const controller = new AbortController();
  activeLogins.set(request.id, controller);
  let usedApiKey = false;
  try {
    await runtime.login(request.providerId, request.method, {
      signal: controller.signal,
      prompt: async (prompt) => {
        if (shouldAutoAnswerSecret(prompt.type, request.apiKey, usedApiKey)) {
          usedApiKey = true;
          return request.apiKey!;
        }
        const signal = prompt.signal ?? controller.signal;
        reply({ id: request.id, type: "auth", event: { type: "prompt", promptType: prompt.type, message: prompt.message } });
        if (prompt.type === "select") {
          const options = prompt.options ?? [];
          const label = await ui.select(prompt.message, options.map((option) => option.label), { signal });
          const option = options.find((item) => item.label === label);
          if (!option) throw cancelled();
          return option.id;
        }
        const value = await ui.input(prompt.message, prompt.placeholder, { signal });
        if (value === undefined) throw cancelled();
        return value;
      },
      notify: (event) => {
        const summary = summarizeAuthEvent(event);
        if (summary) reply({ id: request.id, type: "auth", event: summary });
      },
    });
  } finally {
    activeLogins.delete(request.id);
  }
}

async function check(runtime: ModelRuntimeLike, providerId: string, modelId: string) {
  const model = runtime.getModel(providerId, modelId);
  if (!model) throw new Error(`Model ${providerId}/${modelId} is not available`);
  const started = Date.now();
  const response = await runtime.completeSimple(model, {
    messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
  }, { maxTokens: 32, signal: AbortSignal.timeout(45_000) });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || "The provider did not return a response");
  }
  return { latencyMs: Date.now() - started };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand(PROVIDER_SERVICE_COMMAND, {
    description: "Pi Desktop provider service (internal)",
    handler: async (args, ctx) => {
      const reply = (message: ProviderServiceMessage) => ctx.ui.notify(encodeProviderMessage(message), "info");
      let request: ProviderRequest;
      try {
        request = parseProviderRequest(args);
      } catch (error) {
        reply({ id: "", type: "error", message: error instanceof Error ? error.message : String(error) });
        return;
      }
      try {
        const runtime = modelRuntime(ctx);
        switch (request.op) {
          case "list":
            reply({ id: request.id, type: "result", result: { providers: listProviders(runtime) } });
            return;
          case "refresh":
            // Chat runtimes call this after credential or models.json changes; keep the reply small.
            await runtime.refresh({ allowNetwork: request.network });
            reply({ id: request.id, type: "result", result: { refreshed: true } });
            return;
          case "login":
            await login(runtime, request, ctx.ui, reply);
            reply({ id: request.id, type: "result", result: { providers: listProviders(runtime) } });
            return;
          case "cancel":
            activeLogins.get(request.target)?.abort();
            reply({ id: request.id, type: "result", result: { cancelled: activeLogins.has(request.target) } });
            return;
          case "logout":
            await runtime.logout(request.providerId, { signal: AbortSignal.timeout(15_000) });
            reply({ id: request.id, type: "result", result: { providers: listProviders(runtime) } });
            return;
          case "check":
            reply({ id: request.id, type: "result", result: await check(runtime, request.providerId, request.modelId) });
            return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply({ id: request.id, type: "error", message });
      }
    },
  });
}
