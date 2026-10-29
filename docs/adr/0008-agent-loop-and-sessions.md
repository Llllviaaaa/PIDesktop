# 0008 Agent loop、会话与工具管线

- 状态：已接受
- 日期：2026-10-29

## 背景

P3 要把 0003 的扩展点词汇和 0004 的会话格式落成代码：自己的 agent loop、会话存储、工具管线、系统提示词，以及前端将来使用的 `session.*` 方法。落地过程中有几处需要比 0003、0004 写得更具体，或者与之略有出入，在这里统一记录。

## 决策

### 包

| 包 | 类型 | 内容 |
|---|---|---|
| `@pid/session` | 接口 | 事件类型、派生规则（分支、compaction、fork）、`sessions` 服务、`SessionStorage` 接口和内存实现 |
| `@pid/session-jsonl` | 实现 | `~/.pid/sessions/<YYYY-MM>/<id>.jsonl` |
| `@pid/tools` | 接口 | `tools` 服务和三段式管线 |
| `@pid/tool-fs` | 实现 | `read` `write` `edit` `ls` `find` `grep` |
| `@pid/tool-bash` | 实现 | `bash`，Windows 上用 Git Bash |
| `@pid/system-prompt` | 接口 | `systemPrompt` 服务，按 order 拼接片段 |
| `@pid/prompt-context` | 实现 | 身份、行为准则、AGENTS.md / CLAUDE.md、skills、环境信息 |
| `@pid/agent` | 接口 | `agents` 服务的契约、`agent/*` 事件、实时增量类型 |
| `@pid/agent-loop` | 实现 | 唯一的 loop |
| `@pid/testkit` | 测试 | 脚本化 LLM provider、黄金日志工具 |

### 会话存储

- 持久化**不是**订阅 `session/event` 的插件，而是注册给 `sessions` 服务的存储后端（`registerStorage`）。`append` 在事件提交时**同步**调用，先写存储，再广播 `session/event`。这样，任何人听到的事件都已经交给了存储，Host 崩溃也不会出现“前端看到了、磁盘上没有”的事件。列出和加载会话本来就需要一个后端，两者合在一起更简单。
- 没有注册存储时使用内存存储，测试和子 agent 可以直接用。
- `session/flush` 会先 fsync，再并行通知插件。loop 在每次运行结束时调用一次。
- 读取时跳过无法使用的行：未知事件类型、序号不连续、崩溃时写了一半的最后一行。遇到更高的主版本直接拒绝。
- 0004 里的 SQLite 索引**推迟**。目前 `session.list` 扫描文件头和事件，会话多了再补索引。

### 事件语义的补充

- `assistant` 事件的 `content` 本身就包含 `tool-call` 块，派生 LLM 上下文只用它。单独的 `tool-call` 事件表示“这个调用开始执行了”，派生时忽略，供前端从日志中还原执行状态。
- 同一轮的多个工具**并行执行**，但 `tool-result` 按**调用顺序**追加，日志因此是确定的，黄金测试才能逐字比较。
- 派生时，没有结果的工具调用（例如 Host 在执行中途退出）会补一个错误结果，空的 assistant 消息（出错时没有任何输出）会被跳过，否则各家接口都会拒绝下一次请求。

### compaction

- 运行中触发（模型报 `context-length` 且没有任何输出，或者设置了 `compactAboveTokens` 并且超过阈值）时，**整个分支**都会被总结。运行中涨得最快的正是最新这一轮的工具结果。总结后同一轮只重试一次。
- 手动 `session.compact` 时**保留最新一轮**原文，只总结之前的内容。
- 总结请求不带工具，系统提示词换成专门的总结提示，要求保留用户当前的请求。

### 工具管线

- `tools/pre-execute` 用 cordis 的 `serial` 分发，而不是 0003 写的 `bail`。cordis 的 `bail` 是同步的，权限询问要等前端回答，必须是异步的。语义不变：第一个返回非 `undefined` 的监听器决定结果，没有监听器就放行。监听器可以原地改写 `call.args`。
- 参数校验只检查 `required` 和顶层类型。不合格、被拒绝、不存在的工具，以及抛出异常的工具，都会变成错误结果交给模型，`execute` 本身不抛异常。
- **P3 没有权限插件**，headless 运行时所有工具都直接执行。权限、规则、确认对话框在 P4 挂到 `tools/pre-execute` 上。在那之前，桌面端仍然使用 Pi 引擎。

### loop

- 一次运行：`agent/before-start` → 若干轮 `agent/turn-start` → 模型调用 → 工具 → `agent/turn-end` → `agent/settled`。
- steer 消息在当前这批工具结束后送达，follow-up 在模型本来要停下时送达。空闲时调用这两个方法，效果等同于 `prompt`。运行中再次 `prompt` 会得到 `SessionBusy`。
- abort 会保留已经流出的部分回复（`stop: "aborted"`），并给尚未执行的工具调用补上“已中止”的结果。
- 默认最多 100 轮，超过后以 `max-turns` 结束。
- 新增的扩展点：

| 事件 | 方式 | 说明 |
|---|---|---|
| `session/delta` | emit | `(session, liveSeq, delta)`：不落盘的实时进度 |
| `agent/before-start` | serial | 一次运行开始 |
| `agent/turn-start` / `agent/turn-end` | serial | 每一轮的开始和结束，参数带轮次 |
| `agent/settled` | parallel | 运行结束，参数带结果：`done`、`aborted`、`error`、`max-turns` |

- 实时增量（`AgentDelta`）的种类：`agent-start`、`agent-end`、`turn-start`、`llm-start`、`llm-chunk`、`tool-start`、`tool-end`、`queue`、`compaction-start`、`compaction-end`。

### 协议

- 新增方法 `session.create`、`list`、`get`、`subscribe`、`unsubscribe`、`prompt`、`steer`、`followUp`、`abort`、`fork`、`rewind`、`compact`、`rename`、`archive`，以及 `model.set`、`model.setEffort`。`session.delete`、`session.export`、`ui.*` 留到 P4、P5。
- 订阅是**按连接**的：`session.subscribe` 之后，这条连接会收到该会话的 `session/event` 和 `session/delta` 通知，连接关闭时自动退订。为此 `RpcCall` 新增了 `notify`，用于向发起请求的连接发通知。
- 通知可能比 `session.subscribe` 的响应先到，客户端按 `seq` 和 `liveSeq` 去重即可。
- `session.create` 不带模型时，使用 `providers.json` 里的 `defaultModel`。

### headless

`pid-harness run [--cwd] [--model provider/model] [--effort] [--session id] [--json] <prompt>`：回复流式输出到 stdout，工具活动输出到 stderr，`--json` 时 stdout 每行输出一条持久化事件。会话照常落盘，所以可以用 `--session` 接着跑。

### better-sidebar

better-sidebar 是按 DSH 的 `sessions` 和 `tools` 服务写的，形状和我们的不同。它的桩服务改为在一个隔离作用域（`isolate('sessions').isolate('tools')`）里提供，Host 自己的服务不受影响。隔离必须发生在**加载插件的地方**：在一个已经运行的插件里对自身上下文做隔离再提供服务，子插件看不到这些服务（cordis 4.0.5 的行为）。

## 后果

- 新的能力（权限、checkpoint、hooks、计划、记忆、子 agent）都可以作为插件挂在上述事件上，不需要改 loop（P4）。
- loop 的行为由 `packages/agent-loop/test/golden/*.jsonl` 固定下来，改动会直接体现在黄金文件的 diff 里。
- headless 的端到端测试走真实的 OpenAI 兼容适配器，但对面是假服务器。还没有用真实模型跑过一个完整的编码任务，需要拿到 key 后补上。

## 备选方案

- **持久化完全靠订阅 `session/event`**：加载和列出仍然需要后端；而且 `emit` 不等待，写盘失败时调用方无从得知。否决。
- **工具结果按完成顺序追加**：前端能早一点看到快的结果，但日志不确定，黄金测试会时好时坏。否决，前端改用 `tool-end` 增量感知完成。
- **运行中 compaction 也保留最新一轮**：上下文超长往往就是这一轮的工具结果造成的，保留下来等于没有压缩。否决。
