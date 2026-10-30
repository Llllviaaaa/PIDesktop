/**
 * `llm.complete`: one model call without tools or a session, for the
 * desktop's small text jobs such as drafting a commit message (P6a). It
 * replaces the `pi --print` the desktop used to run for them.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { LlmRequest } from "@pid/llm";
import { ErrorCode, type LlmCompleteResult, type ModelChoice } from "@pid/protocol";
import { RpcError } from "./rpc.ts";

export const name = "pid-llm-rpc";
export const inject = ["rpc", "llm"];

export interface Config {
  /** The model when the call names none. */
  defaultModel?: ModelChoice | (() => ModelChoice | undefined);
}

function optionalString(p: Record<string, unknown>, key: string): string | undefined {
  const value = p[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new RpcError(ErrorCode.InvalidParams, `${key} must be a string`);
  return value;
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(() => ctx.rpc.method("llm.complete", async (params, call): Promise<LlmCompleteResult> => {
    const p = (params ?? {}) as Record<string, unknown>;
    const prompt = optionalString(p, "prompt");
    if (prompt === undefined) throw new RpcError(ErrorCode.InvalidParams, "llm.complete needs a prompt");
    const provider = optionalString(p, "provider");
    const modelId = optionalString(p, "model");
    const fallback = typeof config.defaultModel === "function" ? config.defaultModel() : config.defaultModel;
    const model = provider !== undefined && modelId !== undefined ? { provider, model: modelId } : fallback;
    if (model === undefined) throw new RpcError(ErrorCode.InvalidParams, "No model given and no default model is set");
    const system = optionalString(p, "system");

    const request: LlmRequest = {
      provider: model.provider,
      model: model.model,
      ...(system === undefined ? {} : { system }),
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    };
    let text = "";
    for await (const chunk of ctx.llm.stream(request, call.signal)) {
      if (chunk.type === "text-delta") text += chunk.text;
      else if (chunk.type === "finish" && chunk.reason === "error") {
        throw new RpcError(ErrorCode.ProviderError, chunk.error?.message ?? "The model call failed", chunk.error);
      }
    }
    return { text, model };
  }), "llm.complete");
}
