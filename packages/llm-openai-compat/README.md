# @pid/llm-openai-compat

适用于 OpenAI 兼容 Chat Completions 接口的适配器插件，见 [ADR 0007](../../docs/adr/0007-llm-layer.md)。一个插件可以服务多个 provider，例如 OpenAI、DeepSeek、OpenRouter、Ollama、vLLM。

```ts
ctx.plugin(openaiCompat, {
  providers: [
    { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: { env: "DEEPSEEK_API_KEY" } },
    { id: "ollama", baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "qwen3:8b" }] },
  ],
});
```

| 字段 | 说明 |
|---|---|
| `baseUrl` | 包含版本路径，请求发往 `{baseUrl}/chat/completions`，模型列表从 `{baseUrl}/models` 获取 |
| `apiKey` | `SecretRef`，以 `Authorization: Bearer` 发送；不填就不带这个头 |
| `headers` | 额外的请求头，例如 OpenRouter 的 `HTTP-Referer` |
| `reasoningEffort` | 为 `true` 时把 effort 作为 `reasoning_effort` 发送 |
| `models` | 配置的模型，元数据优先于接口返回的 |

测试夹具（`test/fixtures`）是按 OpenAI 和 DeepSeek 的公开流式格式手工编写的。
