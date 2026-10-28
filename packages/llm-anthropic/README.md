# @pid/llm-anthropic

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

- effort 对应的 thinking 预算：`low` 2048、`medium` 8192、`high` 24576 token，并保证 `max_tokens` 大于预算。
- 开启 thinking 时不发送 `temperature`。
- 测试夹具（`test/fixtures`）是按 Anthropic 的公开流式格式手工编写的。
