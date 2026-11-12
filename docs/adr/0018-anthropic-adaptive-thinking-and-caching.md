# 0018 Anthropic 适配器：自适应 thinking 与提示词缓存

- 状态：已接受（修订 [0007](0007-llm-layer.md) 中 `llm-anthropic` 的 thinking 预算一条）
- 日期：2026-11-12

## 背景

- [0007](0007-llm-layer.md) 规定 effort 映射为 thinking 预算，请求里发 `thinking: {type: "enabled", budget_tokens}`。
  - Anthropic 从 Claude 4.6 起改用自适应 thinking：4.6 上 `budget_tokens` 已弃用，4.7 起直接返回 400，Claude 5 系列的 thinking 根本不能关闭。
  - 设置里默认的推理强度是 `medium`，所以在这些模型上，请求按默认设置就会失败。
- 适配器从不发送 `cache_control`。
  - Anthropic 的提示词缓存需要显式开启。agent 每一轮都会重发整段上下文，这些内容目前全部按原价计费。
  - 缓存读取约为输入价的 0.1 倍，部分新模型更低。

## 决策

### thinking 参数按模型分四档

| 模型 | effort 为具体档位时 | effort 为 `off` 或未设置时 |
|---|---|---|
| Claude 4.5 及更早；不是 Claude 的模型 id（经网关接入的其他模型） | `thinking: {type: "enabled", budget_tokens}`，预算同 0007 | 不发 thinking，可以发 `temperature` |
| Claude 4.6 | `thinking: {type: "adaptive"}` 加 `output_config.effort`；没有 `xhigh`，降为 `high` | 不发 thinking，可以发 `temperature` |
| Claude 4.7 到 4.x | 同上，另加 `display: "summarized"`；支持 `xhigh` | 不发 thinking，不发 `temperature` |
| Claude 5 及以后（含 Fable、Mythos） | 同 4.7 | thinking 关不掉，改发 `output_config.effort: "low"`；不发 `temperature` |

- 版本号从模型 id 解析，兼容日期后缀、平台前缀和点号写法（见 `claudeVersion`）。将来的新模型都按“5 及以后”处理。
- effort 的映射：
  - `minimal` 映射为 `low`；
  - `auto` 不发 effort，使用模型自己的默认值；
  - 数值预算按 0007 的预算档位折算成对应的档位。
- 4.6 及以后的模型，在请求和模型元数据都没有指定 `max_tokens` 时，默认取 64000。thinking 与回答共用这个上限；请求是流式的，上限设高并不会多花钱。

### 只给会话里的请求设缓存断点

- **带 `sessionId` 的请求**（主循环、子 agent）设两个断点，不超过 API 允许的 4 个：
  - 一个在静态前缀的末尾：system 改成文本块数组，断点放在它的末尾，覆盖工具定义和系统提示词；没有 system 时，断点放在最后一个工具定义上；
  - 一个在对话中最后一个可以缓存的块上。thinking 块不能带断点，遇到时往前找。
- **不带 `sessionId` 的一次性请求**（会话标题、压缩摘要、`llm.complete`）不设断点。这些请求不会再发一次，设了断点只会多付 1.25 倍的写入费。
- 用显式断点，不用请求顶层的自动缓存：旧版 Bedrock 集成不接受顶层的 `cache_control`，兼容网关也未必支持。
- TTL 用默认的 5 分钟。agent 每一轮之间的间隔通常远小于 5 分钟。

## 后果

- 当前的 Claude 模型可以正常使用。4.7 及以后的模型会返回 thinking 摘要，界面上能看到推理过程。
- 会话从第二次请求起，大部分输入走缓存读取，可以用 `usage` 里的 `cacheReadTokens` 验证。
- 兼容网关也会收到数组形式的 system 和 `cache_control`。这和 Claude Code 发出的请求形状相同，一般都能接受；如果有网关拒绝，需要再加一个 provider 级的开关。
- 版本判断依赖模型 id 的命名规则。Anthropic 改变命名方式时，需要更新 `claudeVersion`。

## 备选方案

- **按 Models API 返回的 capabilities 判断**：需要每个 provider 先做一次模型发现，而网关大多不提供这些字段。否决。
- **顶层自动缓存**：原因见上。否决。
- **1 小时 TTL**：写入费是基础价的 2 倍，只有用户经常长时间停顿时才划算。否决。
