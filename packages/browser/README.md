# @pid/browser

内置浏览器工具：通过 Chrome DevTools 协议驱动 Edge、Chrome 或 Chromium，见 [ADR 0012](../../docs/adr/0012-browser.md)。

- 工具：`browser_navigate`、`browser_inspect`、`browser_screenshot`、`browser_click`、`browser_type`、`browser_press`、`browser_scroll`、`browser_select`、`browser_wait`、`browser_tabs`、`browser_upload`。
- 每个 agent 会话各有一个浏览器，首次使用时启动；上传和下载限制在该会话的目录内；空闲 `idleMinutes`（默认 10 分钟）后关闭。
- 只读会话中拒绝所有交互操作。其他情况下，交互操作需要通过 `ui.confirm` 确认，除非会话是完全访问。
- `driver.ts` 复制自 `pidesktop-browser.ts`。profile 目录、可执行文件和工作区根目录改为构造选项传入。

配置（`harness.json` 的 `browser` 段）：`{ enabled, headless, confirmActions, profileDir, executable, idleMinutes }`。
