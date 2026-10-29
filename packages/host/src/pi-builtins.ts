/**
 * Pi's built-in providers that the harness adapters can talk to, for the
 * one-time import of keys from Pi's `auth.json` (pi-import.ts).
 *
 * Taken from Pi's model catalog (`@earendil-works/pi-ai` models.generated):
 * each provider's OpenAI chat-completions or Anthropic Messages endpoint.
 * scripts/test-pi-builtins.test.ts checks the table against that catalog
 * while Pi is still installed (until P6). Left out: providers that sign in
 * with OAuth only, need cloud credentials (Bedrock, Vertex, Azure), have a
 * URL with account placeholders (Cloudflare), or speak only another API.
 */
import type { ProviderEntry } from "./providers.ts";

export interface PiBuiltin {
  name: string;
  api: ProviderEntry["api"];
  baseUrl: string;
}

export const PI_BUILTINS: Readonly<Record<string, PiBuiltin>> = {
  "ant-ling": { name: "Ant Ling", api: "openai-compat", baseUrl: "https://api.ant-ling.com/v1" },
  anthropic: { name: "Anthropic", api: "anthropic", baseUrl: "https://api.anthropic.com" },
  baseten: { name: "Baseten", api: "openai-compat", baseUrl: "https://inference.baseten.co/v1" },
  cerebras: { name: "Cerebras", api: "openai-compat", baseUrl: "https://api.cerebras.ai/v1" },
  deepseek: { name: "DeepSeek", api: "openai-compat", baseUrl: "https://api.deepseek.com" },
  fireworks: { name: "Fireworks", api: "openai-compat", baseUrl: "https://api.fireworks.ai/inference/v1" },
  groq: { name: "Groq", api: "openai-compat", baseUrl: "https://api.groq.com/openai/v1" },
  huggingface: { name: "Hugging Face", api: "openai-compat", baseUrl: "https://router.huggingface.co/v1" },
  "kimi-coding": { name: "Kimi Coding", api: "openai-compat", baseUrl: "https://api.kimi.com/coding/v1" },
  minimax: { name: "MiniMax", api: "anthropic", baseUrl: "https://api.minimax.io/anthropic" },
  "minimax-cn": { name: "MiniMax (China)", api: "anthropic", baseUrl: "https://api.minimaxi.com/anthropic" },
  moonshotai: { name: "Moonshot AI", api: "openai-compat", baseUrl: "https://api.moonshot.ai/v1" },
  "moonshotai-cn": { name: "Moonshot AI (China)", api: "openai-compat", baseUrl: "https://api.moonshot.cn/v1" },
  nvidia: { name: "NVIDIA", api: "openai-compat", baseUrl: "https://integrate.api.nvidia.com/v1" },
  opencode: { name: "OpenCode", api: "openai-compat", baseUrl: "https://opencode.ai/inference/v1" },
  "opencode-go": { name: "OpenCode Go", api: "openai-compat", baseUrl: "https://opencode.ai/inference/go/v1" },
  openrouter: { name: "OpenRouter", api: "openai-compat", baseUrl: "https://openrouter.ai/api/v1" },
  "qwen-token-plan": { name: "Qwen Token Plan", api: "openai-compat", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" },
  "qwen-token-plan-cn": { name: "Qwen Token Plan (China)", api: "openai-compat", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" },
  "qwen-token-plan-individual": { name: "Qwen Token Plan (Individual)", api: "openai-compat", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" },
  together: { name: "Together AI", api: "openai-compat", baseUrl: "https://api.together.ai/v1" },
  "vercel-ai-gateway": { name: "Vercel AI Gateway", api: "anthropic", baseUrl: "https://ai-gateway.vercel.sh" },
  xiaomi: { name: "Xiaomi MiMo", api: "openai-compat", baseUrl: "https://api.xiaomimimo.com/v1" },
  "xiaomi-token-plan-ams": { name: "Xiaomi MiMo Token Plan (Amsterdam)", api: "openai-compat", baseUrl: "https://token-plan-ams.xiaomimimo.com/v1" },
  "xiaomi-token-plan-cn": { name: "Xiaomi MiMo Token Plan (China)", api: "openai-compat", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" },
  "xiaomi-token-plan-sgp": { name: "Xiaomi MiMo Token Plan (Singapore)", api: "openai-compat", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
  zai: { name: "Z.ai", api: "openai-compat", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
  "zai-coding-cn": { name: "Zhipu (China)", api: "openai-compat", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
  // Pi reaches these through another API; each also serves OpenAI chat completions here.
  openai: { name: "OpenAI", api: "openai-compat", baseUrl: "https://api.openai.com/v1" },
  xai: { name: "xAI", api: "openai-compat", baseUrl: "https://api.x.ai/v1" },
  google: { name: "Google Gemini", api: "openai-compat", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  mistral: { name: "Mistral", api: "openai-compat", baseUrl: "https://api.mistral.ai/v1" },
};

/** The providers taken from Pi's catalog as it is, as opposed to the endpoints chosen above. */
export const PI_BUILTIN_OVERRIDES: ReadonlySet<string> = new Set(["openai", "xai", "google", "mistral"]);
