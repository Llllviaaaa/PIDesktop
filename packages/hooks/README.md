# @pid/hooks

用户 hooks：在 agent 事件和工具事件上运行 shell 命令，事件内容以 JSON 形式从 stdin 传入。见 [ADR 0009](../../docs/adr/0009-feature-plugins.md)，事件的对应关系写在 `src/index.ts` 的文件头。

- 标记为 blocking 的 `tool_call` hook 失败时，拒绝这次工具调用；其他 hook 失败时记录日志，并通过 `ui.notify` 提示用户。
- 默认不把疑似密钥的环境变量（key、token、password 等）传给 hook，`inheritEnvironment: true` 时才传。
- Windows 上 hook 命令原样交给 `cmd.exe /s /c` 执行。

配置（`harness.json` 的 `hooks` 段）：`{ hooks: DesktopHookConfig[], inheritEnvironment? }`。
