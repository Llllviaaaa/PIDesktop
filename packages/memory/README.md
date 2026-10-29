# @pid/memory

本地记忆：一个 Markdown 文件，保存用户的长期偏好。见 [ADR 0009](../../docs/adr/0009-feature-plugins.md)。

- `desktop_memory` 工具：`read`、`append`、`replace`、`clear`，文件上限 256 KB。
- 系统提示词片段 `memory` 放入文件内容。

配置：`{ file }`，Host 传入 `<dataDir>/memory.md`。在 `harness.json` 中设置 `memory.enabled: false` 可以关闭。
