# @pid/plan

`update_plan` 工具：模型为多步骤的工作维护一份可见的计划。见 [ADR 0009](../../docs/adr/0009-feature-plugins.md)。

- 计划记为 `custom` 事件 `pid-plan`，随会话分支变化。`planOf(session)` 读取当前计划。
- 每次更新会发出 `{ type: "plan", plan }` 实时增量。
- 校验规则（最多 50 步，同一时间只能有一步 `in_progress`）沿用 `pidesktop-plan-core.ts`。
