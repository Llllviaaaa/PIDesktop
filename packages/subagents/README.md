# @pid/subagents

`delegate_task` 工具：把最多 8 个互相独立的任务交给子 agent 并行执行。每个子 agent 运行在调用方会话的一个子会话里，由同一个 loop 驱动。见 [ADR 0010](../../docs/adr/0010-subagents-mcp-usage.md)。

- 子会话的头部记录 `parent: { sessionId, callId }`，权限模式为 `read-only` 或 `workspace-write`。
- 子 agent 可用的工具：`read`、`grep`、`find`、`ls`；`workspace-write` 时再加 `edit`、`write`。没有 `bash`，也不能再委派。
- 父会话的工具结果里是各子 agent 的最终回答；运行进度以 `{ type: "subagents" }` 实时增量发出。
- 中止父会话的运行，会连带中止子 agent。

配置：`{ model?, effort?, concurrency? }`。并发默认 3，上限 4。
