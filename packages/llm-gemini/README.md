# `@pid/llm-gemini`

Native Google Gemini adapter (`POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse` and `GET {baseUrl}/models`), translating between Gemini's `Content` / `Part` wire format (`thinkingConfig`, `thoughtSignature`, `inlineData`, `functionCall` / `functionResponse`, and `usageMetadata`) and `@pid/llm`'s canonical `StreamChunk` vocabulary.
