# @pid/permissions

权限模式（`read-only`、`ask`、`workspace-write`、`full-access`）、agent 模式（`agent`、`plan`、`ask`）和工具规则，挂在 `tools/pre-execute` 上。见 [ADR 0009](../../docs/adr/0009-feature-plugins.md)。

- 判断逻辑（`rules.ts`）复制自 Pi guard 的 `pidesktop-rules.ts`，P6 之前两份要保持一致。
- `permissions` 服务：
  - `modes(session)` 返回会话的模式和有效模式（agent 模式不是 `agent` 时一律按只读处理）；
  - `set(session, change)` 修改模式，记为 `custom` 事件 `pid-permissions`。
- 需要确认时通过 `ui.confirm` 询问，没有 UI 时拒绝。
- 系统提示词片段 `agent-mode` 加入当前 agent 模式的说明。

配置（`harness.json` 的 `permissions` 段）：`defaultPermission`、`defaultAgentMode`、`alwaysConfirmShell`（默认 true）、`blockWriteOutsideWorkspace`（默认 true）、`shellAllowPrefixes`、`toolRules`。
