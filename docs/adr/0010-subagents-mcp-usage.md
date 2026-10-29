# 0010 能力迁移（二）：子 agent、MCP、标题与用量

- 状态：已接受
- 日期：2026-10-29

## 背景

P4 的第二批。第一批（0009）已经迁了交互、权限、checkpoint、计划、记忆和 hooks。这一批迁的是：

- `pidesktop-subagents`；
- `pidesktop-mcp`；
- 会话列表所需的标题和用量数据。

浏览器、computer use 和定时任务（目前在 Rust 里）放到第三批。

## 决策

### 子 agent 是进程内的子会话

- Pi 的 `delegate_task` 会为每个任务起一个 `pi --mode json --print` 子进程。现在改为在同一个 Host 里新建一个**子会话**，由同一个 loop 运行。
- 子会话的头部写 `parent: { sessionId, callId }`（0004），日志单独成文件。父会话只记录工具结果，也就是各子 agent 的最终回答。
- 运行进度以 `{ type: "subagents" }` 实时增量发给父会话。
- 中止父会话的运行，会连带中止它的子 agent。
- 子会话默认使用父会话的模型，`harness.json` 的 `subagents.model` 可以覆盖。
- 子会话的权限模式用 permissions 插件设置为 `read-only` 或 `workspace-write`。
- 工具集与 Pi 版一致：只读时是 `read`、`grep`、`find`、`ls`，`workspace-write` 时再加 `edit`、`write`。始终没有 `bash`，也没有 `delegate_task`，所以不会递归委派。

为此 `@pid/tools` 增加了两项：

- **按会话限制工具**：`tools.restrict(sessionId, names)`。不在名单里的工具，在这个会话里既不出现在给模型的列表中，调用时也返回“Unknown tool”。loop 改为调用 `tools.schemas(session.id)`。
- **`ToolEnv.callId`**：工具执行时能拿到当前调用的 id，子会话据此记录 `parent.callId`。

### MCP

- 客户端部分（stdio 与 Streamable HTTP 两种传输、结果格式化）从 `pidesktop-mcp.ts` 原样复制为 `client.ts`，只补了 `export`。P6 前两份要保持一致。
- `mcp` 服务在 Host 启动时**在后台**连接各服务器：慢的服务器不会拖慢启动，连上一个就注册它的工具。`mcp.ready` 在所有服务器连接成功或失败后完成。
- 规则与 Pi 版一致：
  - 只读会话只能访问标记为 `trustedReadOnly` 的服务器；
  - `mcp__` 工具在只读模式下本来就会被权限插件拦下；
  - 其余调用先通过 `ui.confirm` 询问，除非会话是完全访问，或配置关闭了 `confirmTools`。
- 服务器推送的资源更新和列表变化通过 `ui.notify` 告知用户。Pi 版会把更新后的资源内容作为消息插进会话；现在服务器连接属于 Host 而不属于某个会话，所以只通知，不写入会话日志。
- `/mcp-*` 命令要等 commands 服务出现后再加。在那之前，诊断信息由 RPC `mcp.status` 提供。

### 标题与用量

- 会话摘要（`SessionSummary`，RPC 中的 `SessionInfo`）新增三个字段：
  - `firstMessage`：第一条 user 消息的文本，截取 200 字；
  - `messageCount`；
  - `usage`：整个日志中所有模型调用的 token 合计，包括已被回退的部分，因为那些调用同样产生了费用。
- 前端现有的 `sessionTitle` 就是用名称或首条消息来生成标题的，P5 可以直接使用这些字段。
- 新增 RPC `usage.summary`，汇总所有会话的数据。目前不计算费用：价格表仍按 0007 的计划，留给订阅 `llm/response` 的插件实现。

### 配置

`harness.json` 新增两段：

- `mcp`：`{ servers, confirmTools }`，服务器配置的格式与现在桌面端设置里的相同；
- `subagents`：`{ enabled, model, effort, concurrency }`。

## 后果

- 子 agent 不再需要另起进程、重新加载扩展，启动更快，用的是同一份配置和密钥。代价是它与父会话共享同一个 Host 进程，一个失控的子 agent 会影响整个 Host。工具执行本来就在子进程里，这一点影响不大。
- 子会话会出现在 `session.list` 里，带有 `parent` 字段，前端可以据此过滤或分组显示。
- 工具限制只在 `Tools` 服务这一处生效，权限插件和 hooks 都不需要知道子 agent 的存在。

## 备选方案

- **继续用子进程运行子 agent**：需要一个可以独立运行的 Harness CLI，还要重新传递全部配置。DSH 的做法也是带 owner 的子作用域。否决。
- **把服务器推送的资源更新写进所有打开的会话**：会话会被它没有订阅的内容污染。否决，改为只通知。
