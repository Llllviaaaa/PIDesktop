# 0015 导入 Pi 的历史任务

- 状态：已接受
- 日期：2026-10-30

## 背景

P6 会删除 Pi（[P6 细化方案](../REFACTOR_V2_P6.md)）。决策 P6-2 要求把 Pi 的旧会话一次性转换成 Host 的会话：导入后可以继续对话，Pi 的原文件只读。

Pi 的会话文件与 Host 的会话格式（0004）有三点不同：

- Pi 的会话是一棵树，每条记录带 `parentId`，回退和分支都留在同一个文件里；
- 消息使用 pi-ai 的形状（`toolCall`、`toolResult`、`thinking`）；
- 还有一些 Host 没有对应概念的记录：书签、扩展状态、用量提示、上下文编辑、扩展注入的消息。

## 决策

- **Host 负责转换**：Host 提供 RPC `import.piSessions`（`packages/host/src/pi-sessions.ts`），扫描 `roots` 下的 `.jsonl` 文件。
  - `roots` 默认是 `~/.pi/agent/sessions`；桌面端设置了 `sessionDir` 时传入该目录。
  - 扫描规则与 Pi 自己的会话列表一致：最多 5 层，跳过 `.trash`。
  - 每个文件转换后用 `sessions.create` 写成 Host 的会话，`createdAt` 沿用 Pi 的创建时间，会话头记录 `importedFrom: { format: "pi", file, id }`。
- **只导入当前分支**：从文件的最后一条记录沿 `parentId` 回溯到根，与 Pi 最后显示的对话一致。被回退的分支不导入。
- **映射规则**：

  | Pi | Host |
  |---|---|
  | `message` user | `user`（字符串内容转成文本块，保留图片） |
  | `message` assistant | `assistant`。`toolCall` 转成 `tool-call` 块，并为每个调用追加一条 `tool-call` 事件。`stopReason` 映射为 `stop`，`error` 时带上 `errorMessage`。usage 按 `input`、`output`、`cacheRead`、`cacheWrite` 换算。模型变化时先写一条 `model` |
  | `message` toolResult | `tool-result` |
  | `message` bashExecution | `user` 文本（“Ran \`命令\`” 加输出）；标记为不进上下文的跳过 |
  | `model_change` | `model` |
  | `thinking_level_change` | `effort`（minimal 归为 low，xhigh 归为 high） |
  | `compaction` | `compaction`。`throughSeq` 取 `firstKeptEntryId` 对应事件的前一条 |
  | `branch_summary` | `custom`（`ns: "pi-import"`），不进上下文 |
  | `session_info` | `label` 的标题 |
  | 其余（`label`、`custom`、`custom_message`、`usage`、`context_edit`） | 跳过，按类型计数写进报告 |

- **幂等**：
  - `~/.pid/pi-import.json` 的 `sessions` 记录每个已导入的文件及其会话 id。之后再导入时跳过这些文件，即使 Pi 之后又改动了它；这样不会覆盖用户在 Host 上继续过的对话。
  - 没有用户消息的文件跳过，不生成空会话。
  - 读不了的文件计为失败，不影响其他文件。
- **询问一次**：
  - `dryRun` 只统计还没导入的文件数（`pending`），不写会话；
  - `markPrompted` 记下已经询问过用户。
  - 引擎为 Harness 且有待导入的任务时，桌面端启动后询问一次（`PiImportOffer`）。“以后再说”也会记录。设置 › 已归档 里可以随时再导入。
- **进度**：导入过程中广播 `import/progress { done, total }`。
- **测试样本**：`packages/host/test/fixtures/pi-sessions` 下的样本由 `scripts/record-pi-session-samples.mjs` 调用 Pi 自己的 `SessionManager` 生成，是真实的 Pi 文件，覆盖工具调用、思考、分支、压缩、图片、`!` 命令和扩展消息。样本已提交进仓库，删除 Pi 依赖后测试仍然可以运行。

## 后果

- 删除 Pi 之后，旧任务仍然可以在侧边栏打开并继续。
- 导入的会话保留原来的 token 用量，用量页的历史统计不会消失。
- 扩展注入的消息（例如 Pi 版的计划模式）和 Pi 的分支摘要不会进入模型上下文。继续对话时上下文比在 Pi 里少了这部分，影响很小，报告里会列出。
- 导入的会话里，模型仍然是 Pi 的 provider 和模型 id。Host 没有同名 provider 时，用户需要先切换模型。

## 备选方案

- **保留一个只读的 Pi 会话查看器**：Pi 的格式解析会一直留在应用里，导入后也不能继续对话。否决（P6-2）。
- **导入整棵树**：可以用 `rewind` 把被回退的分支也保留下来，但转换更复杂，而 Pi 的界面本来也只突出当前分支。暂不做；原文件仍在，需要时可以再加。
- **由 Rust 转换**：Rust 的 `pi/sessions.rs` 会在 P6c 删除，Host 本来就负责写会话。否决。
