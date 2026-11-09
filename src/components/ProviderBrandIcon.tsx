import type { ModelProviderInput, ModelProviderModel } from "../types";

export type BrandKey =
  | "openai"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "openrouter"
  | "siliconflow"
  | "qwen"
  | "moonshot"
  | "zhipu"
  | "ollama"
  | "custom";

export interface BuiltinProviderPreset {
  id: string;
  name: string;
  brand: BrandKey;
  subtitle: string;
  api: ModelProviderInput["api"];
  baseUrl: string;
  keyless?: boolean;
  models: ModelProviderModel[];
}

export const BUILTIN_PROVIDER_PRESETS: readonly BuiltinProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    brand: "openai",
    subtitle: "GPT-5 · GPT-4.1 · o4-mini",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-5", name: "GPT-5", reasoning: true, thinkingLevel: "medium", input: ["text", "image"], contextWindow: 400_000, maxTokens: 32_768, cost: { input: 1.25, output: 10 } },
      { id: "gpt-4.1", name: "GPT-4.1", reasoning: false, thinkingLevel: "off", input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 32_768, cost: { input: 2, output: 8 } },
      { id: "o4-mini", name: "o4-mini", reasoning: true, thinkingLevel: "high", input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_768, cost: { input: 1.1, output: 4.4 } },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    brand: "anthropic",
    subtitle: "Claude Sonnet 4.5 · Opus 4.1",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    models: [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, thinkingLevel: "medium", input: ["text", "image"], contextWindow: 200_000, maxTokens: 16_384, cost: { input: 3, output: 15 } },
      { id: "claude-opus-4-1", name: "Claude Opus 4.1", reasoning: true, thinkingLevel: "high", input: ["text", "image"], contextWindow: 200_000, maxTokens: 16_384, cost: { input: 15, output: 75 } },
      { id: "claude-3-5-haiku-latest", name: "Claude Haiku 3.5", reasoning: false, thinkingLevel: "off", input: ["text", "image"], contextWindow: 200_000, maxTokens: 8_192, cost: { input: 0.8, output: 4 } },
    ],
  },
  {
    id: "google-gemini",
    name: "Google Gemini",
    brand: "gemini",
    subtitle: "Gemini 2.5 Pro · 2.5 Flash",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, thinkingLevel: "high", input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 65_536, cost: { input: 1.25, output: 10 } },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", reasoning: true, thinkingLevel: "medium", input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 65_536, cost: { input: 0.3, output: 2.5 } },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    brand: "deepseek",
    subtitle: "DeepSeek V3 · DeepSeek R1",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    models: [
      { id: "deepseek-chat", name: "DeepSeek V3", reasoning: false, thinkingLevel: "off", input: ["text"], contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0.27, output: 1.1 } },
      { id: "deepseek-reasoner", name: "DeepSeek R1", reasoning: true, thinkingLevel: "high", input: ["text"], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0.55, output: 2.19 } },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    brand: "openrouter",
    subtitle: "聚合全球主流大模型网关",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5 (OR)", reasoning: true, thinkingLevel: "medium", input: ["text", "image"], contextWindow: 200_000, maxTokens: 16_384 },
      { id: "openai/gpt-5", name: "GPT-5 (OR)", reasoning: true, thinkingLevel: "medium", input: ["text", "image"], contextWindow: 400_000, maxTokens: 32_768 },
      { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro (OR)", reasoning: true, thinkingLevel: "high", input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 65_536 },
    ],
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    brand: "siliconflow",
    subtitle: "高速推理云 · DeepSeek / Qwen",
    api: "openai-completions",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: [
      { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek-V3", reasoning: false, thinkingLevel: "off", input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
      { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek-R1", reasoning: true, thinkingLevel: "high", input: ["text"], contextWindow: 128_000, maxTokens: 16_384 },
      { id: "Qwen/Qwen3-235B-A22B", name: "Qwen3-235B-A22B", reasoning: true, thinkingLevel: "medium", input: ["text"], contextWindow: 128_000, maxTokens: 16_384 },
    ],
  },
  {
    id: "dashscope",
    name: "阿里云百炼 (Qwen)",
    brand: "qwen",
    subtitle: "通义千问 Qwen-Max · QwQ",
    api: "openai-completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [
      { id: "qwen-max-latest", name: "Qwen Max", reasoning: false, thinkingLevel: "off", input: ["text"], contextWindow: 131_072, maxTokens: 8_192 },
      { id: "qwq-plus", name: "QwQ Plus", reasoning: true, thinkingLevel: "medium", input: ["text"], contextWindow: 131_072, maxTokens: 16_384 },
      { id: "qwen-coder-plus-latest", name: "Qwen Coder Plus", reasoning: false, thinkingLevel: "off", input: ["text"], contextWindow: 131_072, maxTokens: 8_192 },
    ],
  },
  {
    id: "moonshot",
    name: "月之暗面 (Kimi)",
    brand: "moonshot",
    subtitle: "Kimi K2 · 长文本推理",
    api: "openai-completions",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [
      { id: "kimi-k2-0711-preview", name: "Kimi K2", reasoning: false, thinkingLevel: "off", input: ["text"], contextWindow: 256_000, maxTokens: 16_384 },
      { id: "kimi-thinking-preview", name: "Kimi Thinking", reasoning: true, thinkingLevel: "high", input: ["text", "image"], contextWindow: 256_000, maxTokens: 32_768 },
    ],
  },
  {
    id: "zhipu",
    name: "智谱清言 (GLM)",
    brand: "zhipu",
    subtitle: "GLM-4.5 · 编码与多模态",
    api: "openai-completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: [
      { id: "glm-4.5", name: "GLM-4.5", reasoning: true, thinkingLevel: "medium", input: ["text"], contextWindow: 128_000, maxTokens: 16_384 },
      { id: "glm-4.5-air", name: "GLM-4.5 Air", reasoning: true, thinkingLevel: "medium", input: ["text"], contextWindow: 128_000, maxTokens: 16_384 },
    ],
  },
  {
    id: "ollama",
    name: "Ollama 本地模型",
    brand: "ollama",
    subtitle: "本机离线推理 127.0.0.1:11434",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyless: true,
    models: [
      { id: "qwen3:8b", name: "Qwen3 8B (Local)", reasoning: true, thinkingLevel: "medium", input: ["text"], contextWindow: 32_768, maxTokens: 8_192 },
      { id: "deepseek-r1:8b", name: "DeepSeek R1 8B (Local)", reasoning: true, thinkingLevel: "high", input: ["text"], contextWindow: 32_768, maxTokens: 8_192 },
    ],
  },
];

export function resolveBrandKey(id: string, name = ""): BrandKey {
  const hay = `${id} ${name}`.toLowerCase();
  if (hay.includes("openai") || hay.includes("codex") || hay.includes("gpt")) return "openai";
  if (hay.includes("anthropic") || hay.includes("claude")) return "anthropic";
  if (hay.includes("gemini") || hay.includes("google")) return "gemini";
  if (hay.includes("deepseek")) return "deepseek";
  if (hay.includes("openrouter")) return "openrouter";
  if (hay.includes("silicon") || hay.includes("硅基")) return "siliconflow";
  if (hay.includes("qwen") || hay.includes("dashscope") || hay.includes("百炼") || hay.includes("通义")) return "qwen";
  if (hay.includes("moonshot") || hay.includes("kimi") || hay.includes("月之暗面")) return "moonshot";
  if (hay.includes("zhipu") || hay.includes("glm") || hay.includes("bigmodel") || hay.includes("智谱")) return "zhipu";
  if (hay.includes("ollama")) return "ollama";
  return "custom";
}

export function ProviderBrandIcon({
  id,
  name = "",
  size = "md",
}: {
  id: string;
  name?: string;
  size?: "sm" | "md" | "lg";
}) {
  const brand = resolveBrandKey(id, name);
  return (
    <span className={`provider-brand-tile is-${size} brand-${brand}`} aria-hidden="true">
      {brand === "openai" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3.2c-1.9 0-3.5 1.1-4.2 2.8-1.7.3-3.1 1.5-3.6 3.1-.5 1.8.1 3.7 1.6 4.8-.3 1.7.4 3.4 1.8 4.4 1.5 1 3.5.9 4.9-.2 1.5 1.1 3.4 1.2 4.9.2 1.5-1 2.1-2.7 1.8-4.4 1.5-1.1 2.1-3 1.6-4.8-.5-1.6-1.9-2.8-3.6-3.1-.7-1.7-2.3-2.8-4.2-2.8Z" />
          <polygon points="12 8.2 15.3 10.1 15.3 13.9 12 15.8 8.7 13.9 8.7 10.1" />
        </svg>
      )}
      {brand === "anthropic" && (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M14.3 5h2.4L21 19h-2.5l-3.1-10.4L12.3 19H9.9L14.3 5ZM7.3 5h2.5l4.3 14h-2.5l-.9-3.1H6.3L5.4 19H3L7.3 5Zm.5 8.8h2.3L8.9 9.7l-1.1 4.1Z" />
        </svg>
      )}
      {brand === "gemini" && (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2.5c.4 4.8 4.7 9.1 9.5 9.5-4.8.4-9.1 4.7-9.5 9.5-.4-4.8-4.7-9.1-9.5-9.5 4.8-.4 9.1-4.7 9.5-9.5Z" />
        </svg>
      )}
      {brand === "deepseek" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.8 13.2c.8-4.4 4.5-7.4 9.2-7.2 3.3.1 5.9 2.1 7.2 5-1.8-.3-3.4.3-4.5 1.6-1.3 1.5-2.9 2.6-5.2 2.8-2.6.2-5-.6-6.7-2.2Z" />
          <path d="M9.5 15.4c1.2 2.1 3.7 3.2 6.5 2.7 1.6-.3 3-1.1 4-2.3" />
          <circle cx="14.2" cy="9.8" r="1" fill="currentColor" stroke="none" />
        </svg>
      )}
      {brand === "openrouter" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 12h5l3.5-5H19" />
          <path d="m16.5 4.5 2.5 2.5-2.5 2.5" />
          <path d="M9 12l3.5 5H19" />
          <path d="m16.5 14.5 2.5 2.5-2.5 2.5" />
        </svg>
      )}
      {brand === "siliconflow" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16.8 6.2H9.6a3.2 3.2 0 0 0 0 6.4h4.8a3.2 3.2 0 0 1 0 6.4H7.2" />
          <circle cx="17" cy="6.2" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="7" cy="19" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      )}
      {brand === "qwen" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 3.4 19.4 7.7 19.4 16.3 12 20.6 4.6 16.3 4.6 7.7" />
          <circle cx="12" cy="12" r="3.2" />
          <path d="m14.5 14.5 3.3 3.3" />
        </svg>
      )}
      {brand === "moonshot" && (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M15.6 4.2a8 8 0 1 0 4.2 13.8A7.2 7.2 0 0 1 15.6 4.2Z" />
        </svg>
      )}
      {brand === "zhipu" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5.5 6.5h13l-9 11h9" />
          <circle cx="17.5" cy="11.5" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      )}
      {brand === "ollama" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8.5 8.5V5.2c0-1 .8-1.7 1.7-1.7.8 0 1.4.5 1.6 1.3h.4c.2-.8.8-1.3 1.6-1.3.9 0 1.7.7 1.7 1.7v3.3a5.5 5.5 0 0 1 2 4.3v4.2a2.5 2.5 0 0 1-2.5 2.5H9a2.5 2.5 0 0 1-2.5-2.5v-4.2a5.5 5.5 0 0 1 2-4.3Z" />
          <circle cx="10.2" cy="12.2" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="13.8" cy="12.2" r="0.9" fill="currentColor" stroke="none" />
          <path d="M10.6 15.2c.8.6 2 .6 2.8 0" />
        </svg>
      )}
      {brand === "custom" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4.5" width="16" height="6" rx="1.8" />
          <rect x="4" y="13.5" width="16" height="6" rx="1.8" />
          <circle cx="8" cy="7.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="8" cy="16.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      )}
    </span>
  );
}
