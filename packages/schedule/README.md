# @pid/schedule

由 Host 执行的定时任务，见 [ADR 0011](../../docs/adr/0011-computer-and-schedule.md)。

- 每次运行在任务目录下新建一个会话，并标记为无人值守（`ui.markUnattended`）：需要用户确认的操作一律拒绝。到超时后中止运行。
- 运行频率支持 `hourly`、`daily`、`weekdays`、`weekly`，按本地时间计算。最多同时运行 2 个任务。
- 权限模式只能是 `read-only`、`ask` 或 `workspace-write`。
- 任务存在 `<dataDir>/schedules.json`，运行记录存在 `<dataDir>/schedule-runs.jsonl`。
- 事件：`schedule/task`、`schedule/run`。Host 的 `schedule-rpc` 把它们转发为同名通知。

只有长期运行的 RPC Host 会加载本插件，headless 运行不加载。
