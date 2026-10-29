# 0009 能力迁移（一）：交互、权限、checkpoint、计划、记忆、hooks

- 状态：已接受
- 日期：2026-10-29

## 背景

P4 要把 `src-tauri/resources/pidesktop-*` 里的 Pi 扩展逐个迁成 Harness 插件。能力较多，分两批做。这一批迁的是与 loop 关系最紧、互相依赖的几项：

- 权限：guard 与 rules；
- 工作区 checkpoint；
- 计划；
- 本地记忆；
- hooks；
- 以及它们共同需要的“向用户提问”通道。

MCP、浏览器、computer use、子 agent、定时任务、标题和用量留到第二批。

## 决策

### 复用纯逻辑，复制而不是共享

`pidesktop-rules.ts`、`pidesktop-checkpoints.ts` 以及 `*-core.ts` 里的纯逻辑原样复制进新包，文件头注明来源：

| 来源 | 复制到 |
|---|---|
| `pidesktop-rules.ts` | `@pid/permissions` 的 `rules.ts` |
| `pidesktop-checkpoints.ts` | `@pid/checkpoints` 的 `git.ts` |
| `*-core.ts` | 各包的 `core.ts` |

不改成共享，原因有两点：

- 0005 禁止 `packages/` 依赖 `src-tauri/`；
- Pi 引擎打包时只带 `resources/` 目录，反过来让扩展依赖 `packages/` 也行不通。

两份代码在 P6 删除 Pi 路径前必须保持一致。两边写的是同一个 git ref 命名空间 `refs/pidesktop/checkpoints`，清理时一起计数。

### `ui` 服务

- `@pid/ui` 提供 `confirm`、`select`、`input`、`notify`。插件不关心由谁来回答。
- 实际的投递由挂上去的 transport 负责。没有 transport 时（headless 运行），提问会立即返回“无回答”，调用方回退到安全默认值。
- Host 的 `ui-rpc` 插件是桌面端的 transport：
  - 通过 `ui/request` 通知把提问发给**所有**连接的客户端，第一个 `ui.respond` 生效；
  - 回答后广播 `ui/cancel`，让其他客户端关掉同一个对话框；
  - 断线重连的客户端用 `ui.pending` 取回仍在等待的提问。0002 中“重订阅时重新下发”的设计改由这个方法实现。
- 运行被中止时，正在等待的提问会被取消。
- 有桌面客户端在时，`ui-rpc` 还会在系统提示词里加入 rich content 说明，对应原来 guard 中按 `ctx.hasUI` 加入的那段。

### 权限

- `Permissions` 是一个服务（`permissions`），在 `tools/pre-execute` 上调用原来的 `evaluateToolPermission`：
  - `confirm` 通过 `ui.confirm` 询问，没有 UI 时直接拒绝；
  - `block` 直接拒绝。
- 会话的权限模式和 agent 模式存为命名空间 `pid-permissions` 的 `custom` 事件，因此会随分支变化，重启后仍然有效。
- agent 模式对应的说明作为系统提示词片段加入。
- 规则从 `harness.json` 的 `permissions` 段读取，默认值与 Pi guard 相同：总是确认 shell，禁止写工作区外的文件。
- headless 的默认权限是 `workspace-write`。没有人能回答确认，所以默认值要能让常见的编码任务（在工作目录里改文件）跑下去；shell 命令需要 `--permission full-access` 或白名单前缀。

### checkpoint

- 在 `agent/before-start` 时，只要会话的有效权限不是只读，就给 git 工作区拍快照（不动真实的暂存区）。
- 快照存为命名空间 `pid-checkpoints` 的 `custom` 事件，并关联触发这次运行的 user 消息的 seq。
- 新增 RPC 方法：
  - `checkpoint.list`；
  - `checkpoint.diff`；
  - `checkpoint.restore`：运行中拒绝。
- Pi 的 `pidesktop-rewind` 命令一次完成确认、恢复文件和切换分支。现在拆开了：客户端先确认，再调用 `checkpoint.restore`，再调用 `session.rewind`。

### 计划、记忆、hooks

- **计划**：`update_plan` 工具。计划存为命名空间 `pid-plan` 的 `custom` 事件，随分支变化；每次更新还会发出一条 `{ type: "plan" }` 实时增量。新增 `plan.get`。原来的 `/pidesktop-plan` 命令要等 commands 服务出现后再加。
- **记忆**：`desktop_memory` 工具，外加一个系统提示词片段，放入记忆文件的内容。对应原来 Rust 传给 Pi 的 `--append-system-prompt <memory.md>`。
- **hooks**：Pi 的事件名对应到 Harness 事件：

| Pi 事件 | Harness 事件 | 说明 |
|---|---|---|
| `session_start` | `session/created` | |
| `before_agent_start` | `agent/before-start` | |
| `agent_end` | `agent/settled` | 先触发 |
| `agent_settled` | `agent/settled` | 后触发 |
| `tool_call` | `tools/pre-execute` | 标记为 blocking 的 hook 失败时，拒绝这次工具调用 |
| `tool_result` | `tools/result` | |

  Windows 上 hook 命令改为原样交给 `cmd.exe /s /c`（`windowsVerbatimArguments`）。之前 Node 会把命令中的引号转义成 `\"`，cmd 无法识别，带引号路径的 hook 都会失败。Pi 那一份也有同样的问题。

### 配置

`<dataDir>/harness.json` 包含 `permissions`、`hooks`、`memory`、`plan` 四段。文件不存在时使用默认值；某一段格式不对时只忽略这一段并记录警告。这个文件由 P5 的设置界面写入，取代现在 Rust 通过环境变量传给 Pi 的做法。

## 后果

- 权限和 hooks 都挂在 `tools/pre-execute` 上，按注册顺序执行，第一个给出决定的监听器生效。Host 先加载权限，再加载 hooks。
- 桌面端在 P5 切换引擎前仍然走 Pi，所以这一批不会改变用户看到的任何行为。
- 复制的代码在 P6 之前维护两份，修改规则时要同时改两边。

## 备选方案

- **把 rules 和 checkpoints 抽成共享包，让 Pi 扩展也依赖它**：打包后的 Pi 运行时拿不到 `packages/`，而且 P6 就要删除 Pi 路径，不值得。否决。
- **在每个插件里直接注册 RPC 方法**：插件就要依赖 Host 的 `RpcError`，接口包会和传输层耦合。否决，方法统一放在 Host 的 `features-rpc`。
