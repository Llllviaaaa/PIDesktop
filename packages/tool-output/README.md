# @qianji/tool-output

工具输出上限，见 [ADR 0019](../../docs/adr/0019-context-pressure.md)。插件挂在 `tools/execute` 上，ADR 0003 把这个扩展点留给输出截断。

```ts
ctx.plugin(toolOutput, { spillDir: join(dataDir, "spill") });
```

| 字段 | 说明 |
|---|---|
| `spillDir` | 存放全文的目录；不设时超长输出只截断、不保存 |
| `maxChars` | 原样传给模型的文本上限，默认 50000 字符 |
| `retentionDays` | 启动时删除 `spillDir` 下超过这个天数的会话目录，默认 7 天 |

- 文本超过上限时，只保留开头和结尾各 40%，中间插入一条说明，告诉模型全文的路径，以及可以用 `read`（`offset`、`limit`）翻页、用 `grep` 搜索。
- 全文保存在 `<spillDir>/<sessionId>/<callId>.txt`。保存失败时照样截断，说明里注明没能保存。
- 图片和 `details` 原样保留。
- `read`、`bash`、`grep` 自己会限制输出长度，正常情况下不会触发这个上限。真正需要它的是 MCP、浏览器、子 agent 这类不限长度的工具。
