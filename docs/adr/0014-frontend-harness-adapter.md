# 0014 前端接入 Harness：在传输层模拟 Pi runtime

- 状态：已接受
- 日期：2026-10-29

## 背景

P5b 要让前端在 `engine=harness` 时用 Harness Host 完成对话，同时保持 Pi 路径的行为完全不变（P5-3）。

前端围绕 Pi 构建：

- `store.ts`（1600 行）通过 `sendCommand(runtimeId, …)` 发送 Pi 的 RPC 命令（`prompt`、`get_state`、`set_model` 等约 20 个）；
- `handleEvent` 处理约 20 种 Pi 事件；
- 对话界面的数据结构（`AgentMessage`、`UiMessage`）也是 Pi 的形状。

P5 方案原计划在 store 里抽出一层 `RuntimeAdapter`，并顺带把 store 拆成几个 slice。

## 决策

### 在传输层模拟，store 不动

- 前端新增 `harnessRuntime.ts`，让 Host 的会话看起来就是一个 Pi runtime：
  - **`pi.start`**：在 `engine=harness` 时，或打开 `harness:` 开头的会话文件时，返回 `harness:` 开头的 runtime id；
  - **命令**：发给这类 runtime 的 Pi 命令，由适配器换成 Host 的 RPC 来回答；
  - **事件**：Host 的通知（`session/event`、`session/delta`、`ui/request`）被翻译成 store 已经在处理的 Pi 事件。
- 因此 `store.ts` 只改了一处：设置变化时通知适配器当前用哪个引擎。对话界面和组件都没有改动，Pi 路径的代码一行未动。
- 这样做与原计划不同：store 的拆分推迟到 P6。P6 删除 Pi 之后，再把 store 改成 Harness 原生的形状，到那时也就不需要这层模拟了。现在拆，等于在两套引擎并存时重写最复杂的模块，风险更大，收益要到 P6 才能兑现。

### 映射

**会话**
- 一个 runtime 在**第一次发送消息时**才创建 Host 会话。所以 store 预热工作区时启动的 runtime 不会留下空会话。
- 在此之前设置的模型和推理强度先暂存，创建会话时一并带上。
- runtime 对外报告的 `sessionFile` 为 `harness:<sessionId>`，用它可以重新打开这个会话。

**命令**

| Pi 命令 | Host |
|---|---|
| `prompt` / `steer` / `follow_up` / `abort` | `session.prompt` / `session.steer` / `session.followUp` / `session.abort` |
| `get_state` / `get_session_stats` | `session.get` |
| `get_messages` | `session.subscribe { afterSeq: 0 }`：重放事件后转换为 `AgentMessage` |
| `get_available_models` | `provider.list` 加上每个 provider 的 `model.list`，结果缓存 60 秒，连不上的 provider 跳过 |
| `set_model` / `set_thinking_level` | `model.set` / `model.setEffort`：thinking 等级的 minimal 映射为 low，xhigh 映射为 high |
| `set_session_name` / `compact` | `session.rename` / `session.compact` |
| `/pidesktop-mode`、`/pidesktop-permission` | `permission.set` |

- 其余命令（导出、bash、fork、切换会话等）返回明确的“暂不支持”，由 P5c 补齐。

**事件**

| Host | Pi 事件 |
|---|---|
| `agent-start` / `agent-end` | `agent_start` / `agent_end` + `agent_settled` |
| `llm-start` | 一条空的 assistant `message_start` |
| 文本、thinking 增量 | `message_update` |
| 工具调用 | 参数接收完整后，发一个 `toolcall_end` |
| `tool-call` / `tool-result` 事件 | `tool_execution_start` / `tool_execution_end` 以及 toolResult 的 `message_end` |
| `assistant` 事件 | `message_end` |
| 计划 | Pi 计划插件的 widget |
| 队列和 compaction | 对应的 Pi 事件 |

**交互请求**
- Host 的 `ui/request`（confirm、select、input、notify）转为 `extension_ui_request`，所以复用现有的对话框和通知。回答通过 `ui.respond` 送回。
- 子 agent 会话的提问没有对应的 runtime，交给最近使用的那个任务显示。

**会话记录**
- `harnessTranscript.ts` 是纯函数：按回退规则取当前分支，再把 user、assistant（含工具调用）、工具结果、compaction 转换为 `AgentMessage`。
- 测试直接用 agent loop 的黄金日志做夹具。

### `engine` 设置

- Rust 的 `AppSettings` 新增 `engine` 字段，取值 `"pi"` 或 `"harness"`，默认 `"pi"`，并在保存时校验。
- 设置页的“Agent 与安全”下新增“实验”分组，用来切换引擎。

## 后果

- **`engine=harness` 下目前能做的**：完成一次完整的对话，包括工具调用、权限确认、计划显示、切换模型和推理强度，以及切换权限和 agent 模式。端到端测试用真实的 WebSocket 客户端连接进程内的真实 Host 验证了这些。
- **P5b 还缺的**：
  - Harness 会话**不会出现在侧边栏的会话列表里**，因为列表仍由 Rust 读取 Pi 的会话文件；
  - 没有 fork、回退、导出；
  - side chat 仍然走 Pi。

  这些属于 P5c。在此之前，`engine=harness` 只是一个实验开关，默认仍然是 Pi。
- 这层模拟让 Harness 迁就 Pi 的数据形状，有少量信息损失：
  - Host 的 `messageCount` 不计工具结果；
  - 不计算费用。

  P6 删除 Pi 后，前端会改为直接使用 Host 的形状。

## 备选方案

- **按原计划在 store 里加 `RuntimeAdapter` 并拆分 store**：要改动 store 的大部分 action，Pi 路径也得一起重写，而两套引擎并存期间回归风险最高。否决，store 的拆分推迟到 P6。
- **新写一个 Harness 专用的 store 和界面**：会和现有界面重复，两边的功能也会逐渐不一致。否决。

## P5c 补充：会话列表与管理

- 侧边栏的会话列表和归档列表现在合并两个来源：Rust 读取的 Pi 会话，以及 Host 的 `session.list`。Host 连不上时只显示 Pi 的会话。
- Host 的会话在列表里以 `harness:<id>` 作为文件标识；子 agent 的会话不显示，它们属于父会话的工具调用。
- `sessionClient` 遇到 `harness:` 开头的文件，就改用 Host 处理：
  - 读取历史：`session.subscribe` 重放日志，如果没有 runtime 正在观察这个会话，读完就退订；
  - 归档和恢复：`session.archive`；
  - 删除：新增的 `session.delete`，运行中拒绝；
  - 导出 Markdown：新增的 `session.export`，格式与桌面端一直以来的导出相同。
- 打开 Harness 会话时，首屏历史也通过 Host 读取，不必等 runtime 连上。

## P5c 补充：fork 与回退

- **分叉点**：当前分支上的 user 消息，`entryId` 就是事件的 seq。
- **回退**：store 仍然发送 Pi guard 的 `/pidesktop-rewind <entryId>`，由适配器按同样的流程处理：
  1. 查看这条消息之前拍的 checkpoint；
  2. 如果文件有变化，弹出与原来相同的“回退消息和工作区？”确认，用的是同一个对话框（适配器自己发出的提问，回答在本地处理，不经过 Host）；
  3. 用户确认后执行 `checkpoint.restore`；
  4. 最后 `session.rewind` 到这条消息之前。

  用户拒绝时什么都不改。“编辑后重发”复用这个流程。
- **`fork`**：调用 `session.fork`。从 user 消息分叉时，新会话截止到这条消息之前，与 Pi 一致；从回复分叉时，保留这条回复。分叉后 runtime 切换到新会话，Pi 也是这样做的。
- **`clone`**：完整复制当前会话。
- **`new_session`**：清空 runtime，等下一条消息发送时再创建会话。
- **会话树**：由整个日志构建（`get_tree`）。每条消息挂在它所在分支的上一条消息下面；`rewind` 从 `toSeq` 处开出新的分支，被回退掉的那几轮作为旁支保留在树里。

## P5c 补充：定时任务与用量

- **同一时间只有一个调度器在跑**：
  - Host 的调度器只在桌面端 `engine=harness` 时启用：`harness.json` 的 `schedule.enabled` 由设置消息里的 engine 决定；
  - 此时 Rust 的 `run_due_scheduled_tasks` 直接跳过；
  - 切回 Pi 后，两者对调。
- **任务迁移**：第一次以 Harness 引擎启动时，Host 把桌面端的 `scheduled-tasks.json` 一次性导入为自己的 `schedules.json`。
  - 字段一一对应，下次运行时间不导入，由 Host 重新计算；
  - 导入时仍处于运行中的任务记为 `interrupted`；
  - `schedules.json` 已经存在就不再导入。
- **前端 `scheduleClient` 按当前引擎选择后端**：
  - Harness 下调用 Host 的 `schedule.*`；
  - 运行记录里缺少的工作目录、提示词和权限，从任务里补上；
  - 运行对应的会话显示为 `harness:<id>`。
  - 更新事件由 `onTaskUpdated` 和 `onRunUpdated` 同时监听两个来源：Rust 的 Tauri 事件和 Host 的 `schedule/*` 通知。App 的完成提醒和定时任务页面都改为通过这两个方法监听。
- **用量页**：Pi 会话的统计加上 Host 的 `usage.summary`。Host 连不上时只显示 Pi 的统计。Host 不计算费用。

## P5c 补充：模型 provider 设置

- 引擎为 harness 时，设置页的 provider 列表、新增、编辑、删除、发现模型和连接检查都改由 Host 处理（`src/lib/harnessProviders.ts`），对应 Host 新增的 `provider.configs`、`provider.save`、`provider.delete`、`provider.discover`（`packages/host/src/provider-admin.ts`）。
- 页面上的形状不变：Pi 的 `openai-completions` 对应 Host 的 `openai-compat`，`anthropic-messages` 对应 `anthropic`。其他协议在 harness 上直接报错，提示改用这两种。
- 密钥不写进 `providers.json`：
  - 在表单里输入的密钥存入 `secrets.dat`（DPAPI，ADR 0013），文件里只引用 `{ secret: "provider/<id>" }`；
  - `$VAR` 写成 `{ env }`；
  - `!命令` 形式的密钥被拒绝，Host 不执行命令取密钥。
- 改名时一并迁移已存的密钥和默认模型；删除 provider 时也删掉它的密钥。保存或删除之后 Host 立即重新加载，适配器不必重启。
- “发现模型”只用输入的密钥或已存的密钥临时连接一次，不写任何文件。
- Host 没有内置 provider 和 OAuth 登录，这些仍然是 Pi 的功能；在 harness 上，所有 provider 都按自定义 provider 显示。
