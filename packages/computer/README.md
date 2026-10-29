# @pid/computer

Windows computer use，通过桌面端的原生 helper（`<helper> --computer-helper`）实现，见 [ADR 0011](../../docs/adr/0011-computer-and-schedule.md)。

- 工具：`computer_sources`、`computer_state`、`computer_start`、`computer_stop`、`computer_screenshot`、`computer_inspect`、`computer_click`、`computer_move`、`computer_scroll`、`computer_type`、`computer_key`。
- 每个 agent 会话各自有一个 computer 会话，状态变化通过 `{ type: "computer" }` 实时增量通知前端。
- 进入控制模式前需要用户确认，除非会话是完全访问。只读会话不能进入控制模式，只有屏幕可以被控制。
- `core.ts` 复制自 `pidesktop-computer-core.ts`。

配置（`harness.json` 的 `computer` 段）：`{ enabled, helper?, confirmActions? }`。没有配置 `helper` 时读环境变量 `PID_COMPUTER_HELPER`。
