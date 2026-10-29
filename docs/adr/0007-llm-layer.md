# 0007 LLM 层：统一词汇、适配器与密钥引用

- 状态：已接受
- 日期：2026-10-28

## 背景

决策 D1 要求模型接入完全自研，不再借用 Pi 的 `pi-ai`。agent loop（P3）、会话日志（ADR 0004）和各类插件都需要一套与厂商无关的消息格式和流式事件。另外，现在的 API key 以明文写在 Pi 的 `models.json` 里，需要换一种管理方式。

## 决策

### 统一词汇（`@pid/llm`）

- **消息**分三种：`user`、`assistant`、`tool-result`。
  - 内容块有 `text`、`image`、`thinking`、`tool-call` 四种。
  - `thinking` 可以带 `signature`。Anthropic 要求把签名原样回传，其他厂商产生的 thinking 没有签名，所以不会被发给 Anthropic。
- **流式事件** `StreamChunk` 包括：
  - `text-delta`、`thinking-delta`、`thinking-signature`、`thinking-redacted`、`tool-call-start`、`tool-call-delta`、`usage`、`finish`。
  - 每个块按出现顺序编号，增量事件用编号指明属于哪个块。
  - 每个流都以**恰好一个** `finish` 结束，`reason` 取值为 `stop`、`length`、`tool-use`、`refusal`、`error`、`aborted`。
- **用量**：`inputTokens` 统一为**不含缓存命中**的输入 token。OpenAI 的 `prompt_tokens` 包含缓存部分，适配器负责换算。
- **错误**统一归为 `LlmError`，类型有 `auth`、`rate-limit`、`overloaded`、`invalid-request`、`context-length`、`network`、`server`、`aborted`、`unknown`，每个错误都标明能否重试，并带上 `Retry-After`。

### `llm` 服务

- `registerAdapter(info, adapter)` 注册一个 provider，返回的 disposer 交给插件的 effect 管理。
- `stream(request, signal)`：
  - **不会抛出异常**，所有失败都转成 `finish { reason: "error" }`。
  - **只在还没产出任何内容时重试**，并且只重试可重试的错误。默认最多尝试 3 次，退避时间为 1 s、2 s，厂商给了 `Retry-After` 时以它为准，上限 60 s。已经输出了一部分内容的流不重试，因为重试会让前端看到重复的文字。
- **中间件 `llm/request`**（cordis 的 `waterfall`）：监听器签名为 `(request, next)`。
  - 可以在调用 `next()` 之前原地修改请求，例如注入缓存标记、裁剪上下文。
  - 也可以包装 `next()` 返回的流。
  - 每次尝试拿到的都是请求的浅拷贝，修改不会影响调用方。
- **事件 `llm/response`**（`emit`）：每次调用最终结束后触发一次，带上用量、结束原因、尝试次数和耗时。

### 适配器

- **`@pid/llm-openai-compat`**：
  - 接口为 Chat Completions（`{baseUrl}/chat/completions`）。OpenAI、DeepSeek、OpenRouter、Ollama、vLLM 等之间只有地址、key 和模型不同。
  - 兼容 DeepSeek 的 `reasoning_content` 和 OpenRouter 的 `reasoning`。
  - 历史消息中的 thinking 不回传，因为 DeepSeek 会拒绝包含它的请求。
  - 只有显式设置 `reasoningEffort: true` 的 provider 才会发送 `reasoning_effort` 参数，否则不支持这个参数的模型会报 400。
- **`@pid/llm-anthropic`**：
  - 接口为 Messages API（`{baseUrl}/v1/messages`）。
  - 连续的同角色消息合并成一条，工具结果放在 user 消息里。
  - effort 对应的 thinking 预算为 2k、8k、24k token，并保证 `max_tokens` 大于预算。
  - 流里出现 `error` 事件时按错误类型分类。
  - 没收到 `message_stop` 流就断了，按可重试的网络错误处理。
- 两个适配器的模型列表都是“接口发现的模型 + 配置里写的模型”，同一个模型以配置里的元数据为准。

### 密钥引用（`credentials` 服务）

- 配置文件里不直接写 key，而是写 `SecretRef`：
  - `{ env }`：从 Host 进程的环境变量读取；
  - `{ secret }`：由注册进来的密钥存储解析。P5 会接入桌面端现有的 DPAPI 加密存储，在那之前没有存储，解析会报错。
  - `{ value }`：用户明确选择把 key 写在配置里。
- 不支持旧的 `!命令`写法。它会在 Host 里执行任意 shell 命令，等 P5 迁移 provider 设置时再决定是否保留。
- 返回给 UI 的只有 `describe(ref)` 生成的来源描述，例如“environment variable X”，不包含 key 本身。

### 配置与 RPC

- Host 从 `<dataDir>/providers.json` 读取 provider 列表，每一项写明 `api`（`openai-compat` 或 `anthropic`）。格式有误的条目跳过并记录警告，不影响其他 provider 加载。
- 新增的 RPC 方法：
  - `provider.list`：不含 key，只用 `keySource` 字段说明 key 的来源；
  - `model.list { provider }`：厂商返回的错误映射为 `ProviderError`，`data` 里带上错误类型。
- 迁移现有 `models.json` 和 provider 设置界面属于 P5。

## 后果

- P3 的 loop 只依赖 `@pid/llm`，接入新厂商只需要新增一个适配器包。
- 测试夹具是**按各家公开文档手工编写**的 SSE 流，不是录制的真实响应。拿到测试 key 之后，要用真实录制的响应补充契约测试。
- 费用计算（价格表）没有放在这一层，以后由订阅 `llm/response` 的插件负责。

## 备选方案

- **先用 pi-ai 包一层过渡**：被决策 D1 否决。
- **出错就重试，不管是否已有输出**：前端会看到重复的内容，loop 也得处理去重，否决。
- **key 继续以明文写在配置里**：只作为用户明确选择的 `{ value }` 保留，不再是默认做法。
