# @pid/llm

与厂商无关的 LLM 词汇和 `llm` 服务，见 [ADR 0007](../../docs/adr/0007-llm-layer.md)。只包含接口和通用机制，具体厂商由适配器包实现（`@pid/llm-openai-compat`、`@pid/llm-anthropic`）。

## 服务

| 键 | 类 | 说明 |
|---|---|---|
| `llm` | `LlmService` | `registerAdapter`、`listProviders`、`listModels`、`stream`。`stream` 不会抛异常，在还没有产出内容前自动重试 |
| `credentials` | `Credentials` | 解析 `SecretRef`（`{ env }` / `{ secret }` / `{ value }`）；`registerStore` 用于接入密钥存储 |

## 事件

| 事件 | 方式 | 说明 |
|---|---|---|
| `llm/request` | waterfall | `(request, next)`：调用 `next()` 前可以改写请求，也可以包装返回的流 |
| `llm/response` | emit | 一次调用结束（包括重试），带用量、结束原因、尝试次数和耗时 |

## 工具

- `parseSse`、`postSse`、`getJson`、`joinUrl`：适配器共用的 SSE 和 HTTP 辅助函数。
- `errorFromResponse`、`toLlmError`：把 HTTP 状态码和抛出的异常归类为 `LlmError`。
- `BlockAssembler`、`assemble`：把流组装成最终的 `AssistantMessage`，同时汇总用量。

`test/fake-server.ts` 是适配器测试共用的假 provider 服务器。
