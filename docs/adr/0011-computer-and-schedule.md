# 0011 能力迁移（三）：computer use 与定时任务

- 状态：已接受
- 日期：2026-10-29

## 背景

P4 的第三批，迁两样东西：

- `pidesktop-computer`：Windows computer use；
- 定时任务：目前是 Rust 的 `commands/schedule.rs` 和 `scheduler.rs`，按时启动一个 `pi --print` 进程。

浏览器（`pidesktop-browser`）放在第四批，也是 P4 的最后一批。

## 决策

### computer use

- 每个动作仍然调用一次桌面端的原生 helper（`<helper> --computer-helper`），从 stdin 传入 JSON，从 stdout 读回一行 JSON。调用逻辑从 Pi 扩展移植过来，`core.ts` 原样复制。
- helper 的路径来自 `harness.json` 的 `computer.helper`，没有配置时读环境变量 `PID_COMPUTER_HELPER`，P5 由 Rust 传入。没有 helper 时，工具会说明不可用。
- Pi 扩展是一个任务一个进程，所以 computer 会话是进程级的全局状态。Host 同时服务多个会话，改为**按 agent 会话分别保存** computer 会话和最近一次截图：一个会话开启了控制，不会让另一个会话也能控制。
- 原来的 `ctx.ui.setStatus` 改为 `{ type: "computer" }` 实时增量。
- 规则不变：
  - 只有屏幕可以进入控制模式，窗口只能观察；
  - 只读会话不能进入控制模式；
  - 进入控制模式前要通过 `ui.confirm` 确认，除非会话是完全访问或配置关闭了 `confirmActions`；
  - 鼠标和键盘操作都必须先有一个已批准的控制会话。

### 定时任务

- `@pid/schedule` 在 Host 里定时执行任务。每次运行就是在任务目录下新建一个普通会话：
  - 使用任务指定的模型，没有时用 `defaultModel`；
  - 权限模式由任务指定；
  - 标题为“<任务名>（定时）”；
  - 到超时（默认 30 分钟，最多 240 分钟）就中止。
- **无人值守**：`ui` 新增 `markUnattended(sessionId)`。被标记的会话发出的提问一律得不到回答，权限插件按“没有 UI”处理，直接拒绝需要确认的操作。这一点很重要：桌面端开着时，定时任务不能在用户不知情的情况下弹出确认框，更不能等着用户来点。
- 任务的权限模式只能是 `read-only`、`ask` 或 `workspace-write`，与 Rust 版的 `is_safe_unattended_permission` 一致，不允许 `full-access`。
- 计算下次运行时间的逻辑从 Rust 的 `next_scheduled_run` 移植过来，支持 hourly、daily、weekdays、weekly，使用本地时间；遇到夏令时跳过的时间，向后顺延。
- 最多同时运行 2 个任务，每 30 秒检查一次哪些任务到期。
- Host 重启时，未跑完的任务和运行记录标记为 `interrupted`。
- **存储**：
  - 任务存在 `<dataDir>/schedules.json`；
  - 运行记录追加写入 `<dataDir>/schedule-runs.jsonl`，增长过多时只保留最近 500 条。Rust 版用的是 SQLite，这里只是给界面列历史，没必要引入数据库。
- 这是 Host **自己的**任务表。P5 之前，Rust 的调度器继续为 Pi 引擎跑它自己的任务，两边互不读取，所以同一个任务不会被执行两次。迁移任务表属于 P5。
- 只有长期运行的 RPC Host 会加载调度器，headless 运行不加载。
- **RPC**：
  - 方法：`schedule.list`、`schedule.save`、`schedule.delete`、`schedule.run`、`schedule.cancel`、`schedule.runs`；
  - 通知：`schedule/task`（任务变化或删除）、`schedule/run`（运行开始和结束），发给所有客户端。

## 后果

- 定时任务的运行结果就是一个普通会话，可以在会话列表里打开，查看完整过程，也可以接着对话。Rust 版要靠运行前后的会话列表去猜是哪一个会话。
- Rust 里的调度器和 `run_pi_print` 在 P6 删除。
- computer use 仍然只支持 Windows，跨平台不在本轮范围内。

## 备选方案

- **定时任务继续由 Rust 调度，改为调用 Host 的 RPC**：Rust 要实现一个 RPC 客户端，还要处理 Host 重启，反而更复杂。调度本身很小，放在 Host 里最简单。否决。
- **无人值守时自动同意确认**：等于让定时任务拥有完全访问权限，违背了禁止 `full-access` 的初衷。否决。
