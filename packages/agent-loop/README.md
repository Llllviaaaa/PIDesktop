# @pid/agent-loop

唯一的 agent loop（`agents` 服务的实现），见 [ADR 0008](../../docs/adr/0008-agent-loop-and-sessions.md)。只有 `@pid/host` 加载它，其他包不得依赖它。

配置：`{ maxTurns?, compactAboveTokens?, summaryMaxTokens? }`。

`test/golden/*.jsonl` 是 loop 的黄金日志：每个场景用脚本化的 provider 跑一遍，再逐字比较会话日志。改变 loop 行为时用 `npx vitest run packages/agent-loop -u` 更新，并在评审中检查 diff。
