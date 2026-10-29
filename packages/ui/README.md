# @pid/ui

`ui` 服务：插件通过 `confirm`、`select`、`input` 向用户提问，通过 `notify` 发送通知，不关心由谁回答。见 [ADR 0009](../../docs/adr/0009-feature-plugins.md)。

- `attach(transport)` 挂上实际的投递通道，Host 的 `ui-rpc` 是桌面端的实现。同一时间只能挂一个。
- 没有 transport 时，提问立即返回“无回答”（`confirm` 返回 `false`，其余返回 `undefined`）。
- `signal` 中止或 transport 被卸下时，等待中的提问会被取消。
- `respond(requestId, value)` 回答提问；`pending()` 列出仍在等待的提问。
