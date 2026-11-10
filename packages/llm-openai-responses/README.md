# `@qianji/llm-openai-responses`

Native OpenAI Responses API adapter (`POST {baseUrl}/responses` with `stream: true`), supporting o-series / GPT-5 reasoning summaries (`reasoning: { effort, summary: "auto" }`), exact `reasoningTokens`, server-side prompt cache hits (`cached_tokens`), multimodal inputs, and function tool calling.
