# @qianji/subagents

`delegate_task` 工具：把最多 8 个互相独立的任务交给子 agent 并行执行。每个子 agent 运行在调用方会话的一个子会话里，由同一个 loop 驱动。见 [ADR 0010](../../docs/adr/0010-subagents-mcp-usage.md)。

- 子会话的头部记录 `parent: { sessionId, callId }`，权限模式为 `read-only` 或 `workspace-write`。
- 子 agent 可用的工具：`read`、`grep`、`find`、`ls`；`workspace-write` 时再加 `edit`、`write`。没有 `bash`，也不能再委派。
- 父会话的工具结果里是各子 agent 的最终回答；运行进度以 `{ type: "subagents" }` 实时增量发出。
- **结构化结果**：调用时传入 `outputSchema`（一个 JSON Schema），每个子 agent 都必须用一个符合该 schema 的 JSON 值作为最终回答（`src/structured.ts`，思路来自 oh-my-pi 的 `task` 工具）。
  - 回答外面可以包一层 Markdown 代码块。
  - 解析失败或不符合 schema 时，会在同一个子会话里请它改正一次；改正后仍不符合，这个任务记为失败，错误里写明不符合的位置（例如 `$.files[0] should be string`）。
  - 成功时，父会话收到的是格式化后的 JSON 代码块，`details.results[].structured` 里是解析后的值。
  - 检查范围是工具 schema 常用的子集：`type`、`enum`、`const`、`properties`、`required`、`additionalProperties: false`、`items`、`minItems`、`maxItems`。其他关键字接受但不检查。
- 中止父会话的运行，会连带中止子 agent。

配置：`{ model?, effort?, concurrency? }`。并发默认 3，上限 4。
