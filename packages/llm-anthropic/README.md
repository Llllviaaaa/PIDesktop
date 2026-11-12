# @qianji/llm-anthropic

Anthropic Messages API 的适配器插件，见 [ADR 0007](../../docs/adr/0007-llm-layer.md)。也适用于提供同一接口的网关。

```ts
ctx.plugin(anthropic, {
  providers: [{ id: "anthropic", apiKey: { secret: "anthropic" } }],
});
```

| 字段 | 说明 |
|---|---|
| `baseUrl` | 不含版本路径，默认 `https://api.anthropic.com`；请求发往 `{baseUrl}/v1/messages` |
| `apiKey` | `SecretRef`，以 `x-api-key` 头发送 |
| `headers` | 额外的请求头，例如 `anthropic-beta` |
| `models` | 配置的模型；其中的 `maxOutputTokens` 会作为默认的 `max_tokens` |

- thinking 参数按模型 id 分档（[ADR 0018](../../docs/adr/0018-anthropic-adaptive-thinking-and-caching.md)）：
  - Claude 4.5 及更早，以及不是 Claude 的模型 id：effort 对应 thinking 预算，`low` 2048、`medium` 8192、`high` 24576 token，并保证 `max_tokens` 大于预算；
  - Claude 4.6 及以后：`thinking: {type: "adaptive"}` 加 `output_config.effort`；4.7 起另加 `display: "summarized"`；
  - Claude 5 及以后的 thinking 关不掉，effort 为 `off` 或未设置时发 `effort: "low"`。
- 开启 thinking 时不发送 `temperature`；Claude 4.7 及以后一律不发。
- 带 `sessionId` 的请求设两个提示词缓存断点：一个在系统提示词末尾（没有系统提示词时放在最后一个工具定义上），一个在对话的最后一块。一次性请求不设断点。
- 测试夹具（`test/fixtures`）是按 Anthropic 的公开流式格式手工编写的。
