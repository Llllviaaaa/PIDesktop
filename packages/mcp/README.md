# @pid/mcp

把 MCP 服务器提供的能力注册为工具，见 [ADR 0010](../../docs/adr/0010-subagents-mcp-usage.md)。

- `mcp` 服务在后台连接所有启用的服务器（stdio 或 Streamable HTTP），每个远程工具注册为 `mcp__<server>__<tool>`。
- 有服务器支持时，额外注册资源和提示词相关的工具：`mcp_list_resources`、`mcp_read_resource`、`mcp_subscribe_resource`、`mcp_unsubscribe_resource`、`mcp_list_prompts`、`mcp_get_prompt`。
- 只读会话只能访问标记为 `trustedReadOnly` 的服务器。其他调用都要通过 `ui.confirm` 确认，除非会话是完全访问，或 `confirmTools` 为 `false`。
- `statuses()` 返回各服务器的连接状态；`ready` 在所有服务器连接成功或失败后完成。
- `client.ts` 原样复制自 `pidesktop-mcp.ts`，只补了 `export`。

配置（`harness.json` 的 `mcp` 段）：`{ servers: McpServerConfig[], confirmTools? }`。
