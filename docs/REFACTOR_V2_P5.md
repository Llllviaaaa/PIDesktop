# P5 细化方案：前端切换到 Harness 引擎

> 上级文档：[V2 重构方案](REFACTOR_V2_PLAN.md) 第 5 节的 P5 一行。
> 状态：方案已确认（决策见第 2 节），按第 4 节分 4 个 PR 实施。

## 1. 现状

P0–P4 完成后，Harness Host 已经具备 Pi 引擎的全部能力：

- agent loop、会话、工具、权限、计划、记忆、hooks、checkpoint；
- 子 agent、MCP、computer use、浏览器、定时任务。

但桌面端仍然只走 Pi：

| 层 | Pi 路径的现状 |
|---|---|
| 前端 | `src/lib/pi.ts`、`piTransport.ts`、`piRpcRouter.ts` 和 `store.ts`（1.6k 行）通过 `sendCommand(runtimeId, …)` 驱动 Pi，处理约 20 种 Pi 事件（`message_update`、`tool_execution_*`、`extension_ui_request` 等），一共 11 个文件引用 `usePiStore`。 |
| Rust 设置 | `AppSettings` 里的权限规则、hooks、MCP、浏览器、computer、子 agent、记忆、计划等设置，由 `pi/launch.rs` 转成环境变量和命令行参数交给 Pi。 |
| 模型与密钥 | provider 配置在 Pi 的 `models.json`（`commands/provider.rs`），key 以明文或 `!命令` 的形式写在里面；MCP 的密钥另用 DPAPI 加密保存（`secret_store.rs`）。 |
| 会话列表与历史 | Rust 的 `pi/sessions.rs` 直接解析 Pi 的 JSONL 会话文件。 |
| 定时任务 | Rust 的 `commands/schedule.rs` 调用 `pi --print` 执行。 |
| Host 数据目录 | Rust 传给 Host 的是 Tauri 的 `app_data_dir`，与决策 D4 的 `~/.pid` 不一致。 |

## 2. 已确认的决策

- **P5-1 密钥由 Host 自己解密**：
  - Rust 把 key 存入 `<dataDir>/secrets.dat`，格式是 DPAPI 加密的 JSON，与 MCP 密钥的保存方式相同。
  - `providers.json` 只引用 `{ secret: "<id>" }`。
  - Host 用 Bun FFI 调用 `crypt32!CryptUnprotectData`，在用到时解密，作为 `credentials` 的一个密钥存储注册进去（0007 预留的接口）。
  - key 不经过环境变量和子进程，Rust 和 Host 共用同一种文件格式。
  - 非 Windows 平台和测试环境使用内存存储。
- **P5-2 设置热重载**：
  - Rust 写完 `harness.json` 或 `providers.json` 后，调用 RPC `config.reload`。
  - Host 只卸载并重新加载配置有变化的插件，正在运行的会话不中断，新设置从下一次调用开始生效。
  - Host 对每个插件记录它的配置，比较之后才重载，所以没变的插件（例如 MCP 连接）不会被打断。
- **P5-3 用 `engine` 设置灰度切换**：
  - 设置里新增 `engine: "pi" | "harness"`，放在“实验”分组，默认 `pi`。
  - P5 期间两条路径并存；P5 的最后一个 PR 把默认值改为 `harness`。
  - P6 删除 Pi 路径和这个开关。
- **数据目录对齐 D4**：Rust 改为把 `~/.pid` 传给 Host，取代 `app_data_dir`。better-sidebar 的设置文件随之迁移一次。

## 3. 关键设计

### 3.1 设置同步（Rust → Host）

> **实施时的调整（P5a，见 ADR 0013 和 #85）**：设置到 `harness.json` 的映射改为在 Host 里用 TypeScript 实现（`desktop-settings.ts`），`models.json` 的导入也放在 Host 里（`pi-import.ts`）。Rust 只负责把公开设置作为一行 `{"desktop": …}` 写进 Host 的 stdin。下面原来的 Rust 方案保留作对照。

`AppSettings` 中与 agent 相关的字段，由 Rust 的一个纯函数 `harness_config(&AppSettings) -> serde_json::Value` 转成 `harness.json` 的各段：

| AppSettings | harness.json |
|---|---|
| `permission_mode` 默认值、`tool_rules`、`rule_*` | `permissions` |
| `hooks_enabled`、`hooks`、`hooks_inherit_environment` | `hooks` |
| `memory_enabled` / `plan_tracking_enabled` | `memory.enabled` / `plan.enabled` |
| `mcp_enabled`、`mcp_servers`（密钥改为 `{ secret }`）、`mcp_confirm_tools` | `mcp` |
| `subagents_enabled`、`subagent_max_concurrency`，以及 provider、model | `subagents` |
| `browser_*` | `browser` |
| `computer_enabled`、`computer_confirm_actions`，helper 为桌面端 exe 自身 | `computer` |
| `personality`、`custom_instructions` | 新增 `prompt` 段，作为一个系统提示词片段 |

- Rust 在每次 `set_settings` 和启动时写入这些文件，然后调用 `config.reload`。
- Rust 还没有 RPC 客户端，这里只需要一个最小的 WebSocket 客户端：每次请求都完成 `initialize`，再调用一次方法。也可以给 Host 加一个只供 Rust 调用的 stdin 控制通道。**选 stdin**：Rust 本来就持有 Host 的 stdin，不需要再引入 WebSocket 依赖。命令每行一个 JSON，例如 `{"reload":true}`。

### 3.2 provider 迁移

- 首次以 Harness 引擎启动时，Rust 把 Pi 的 `models.json` 一次性转换为 `providers.json`：
  - `api` 按 Pi 的 api 字段映射：`openai-completions` 映射为 `openai-compat`，`anthropic-messages` 映射为 `anthropic`；
  - 明文 key 移入 `secrets.dat`；
  - 无法转换的条目（`!命令` 写法、不支持的 api）保留原样并在界面上提示。
- 之后，provider 设置界面在 `engine=harness` 时读写 `providers.json`，增删改的同时调用 `config.reload`。
- 新增 RPC 方法 `provider.check`，用 `model.list` 实现连通性检查。

### 3.3 前端：`agentClient` 与 transcript 适配

> **实施时的调整（P5b，见 ADR 0014）**：没有在 store 里抽 `RuntimeAdapter`，而是在传输层模拟 Pi runtime（`src/lib/harnessRuntime.ts`）：Pi 命令换成 Host 的 RPC，Host 的通知翻译成 Pi 事件。store 和界面因此基本不用改，store 的拆分推迟到 P6。下面的原方案保留作对照。

- 新增 `src/lib/agentClient.ts`：在 `harnessClient` 之上，按 `@pid/protocol` 的类型封装 session、model、permission、plan、checkpoint、schedule、ui、usage 各类方法，并负责断线重连后用 `session.subscribe { afterSeq }` 续上。
- 新增 `src/lib/harnessTranscript.ts`，**纯函数**：把持久化事件和实时增量转成前端现有的 transcript 结构（`AgentMessage` 等）。
  - 渲染组件（消息、工具卡片、计划、rich content）不需要修改。
  - 可以直接拿 0008 的黄金日志做测试夹具。
- `store.ts` 按引擎分出一层 `RuntimeAdapter`：`connect`、`sendMessage`、`abort`、`steer`、`followUp`、`setModel`、`setThinkingLevel`、`compact`、`fork`、`rewind`、`answerExtension` 等。
  - Pi 适配器包装现有代码；
  - Harness 适配器调用 `agentClient`。
  - 借这次机会把 store 拆成 runtime、sessions、transcript、ui 几个 slice，这是原计划 P5 的内容，只拆这次要改动的部分。
- `ui/request` 映射到现有的扩展对话框组件（确认、选择、输入），`ui.respond` 回答。通知走现有的 toast。
- 会话侧边栏、历史、归档、删除、导出在 `engine=harness` 时改用 Host 的 `session.*`，还需要补上 `session.delete` 和 `session.export`（0002 里列了，P3 推迟了）。
- 定时任务界面和用量页在 `engine=harness` 时改用 `schedule.*` 和 `usage.summary`。
- Pi 专属的“Pi 包”页面在 `engine=harness` 时隐藏。插件管理界面放到 P6 或之后。

### 3.4 定时任务迁移

切到 Harness 时，Rust 把 `scheduled-tasks.json` 一次性转换为 Host 的 `schedules.json`：字段一一对应，`permissionMode` 不变。转换后停用 Rust 调度器（`engine=harness` 时 `run_due_scheduled_tasks` 不再执行），避免同一个任务被执行两次。

## 4. 分 PR 实施

| PR | 内容 | 完成标准 |
|---|---|---|
| **P5a 配置与密钥** | `harness_config()` 和 Rust 侧的测试；`~/.pid` 数据目录；Host 的 stdin 控制通道和 `config.reload`（按插件比较配置后热重载）；`secrets.dat` 与 Host 端的 DPAPI 存储（Bun FFI）；`models.json` 到 `providers.json` 的转换器；`personality` 和 `custom_instructions` 的提示词片段 | Rust 修改设置后，Host 不重启就能生效（有集成测试）；用 DPAPI 保存的 key 能被 Host 解密使用（Windows CI 上测试） |
| **P5b 前端适配层** | `agentClient`、`harnessTranscript`（用黄金日志测试）、`RuntimeAdapter` 和 Harness 适配器、`ui/request` 对话框、`engine` 设置（默认 `pi`）；新建任务、对话、中止、steer、follow-up、切换模型和推理强度、权限和 agent 模式 | `engine=harness` 时能完成一次带工具调用、权限确认和计划的完整对话；前端组件测试覆盖 transcript 映射和对话框 |
| **P5c 会话与周边** | 会话列表、历史、归档、删除、导出、fork、回退（结合 checkpoint 恢复文件）、compact；`session.delete` 和 `session.export`；定时任务界面和任务表迁移；用量页；provider 设置界面改读写 `providers.json` | `CODEX_PARITY.md` 逐项核对，`engine=harness` 下全部功能可用 |
| **P5d 切换默认引擎** | `engine` 默认改为 `harness`；首次启动时的迁移提示（provider、定时任务）；隐藏 Pi 专属的界面；更新文档 | 全新安装和从旧版本升级两种情况都能直接使用；保留切回 Pi 的出口，直到 P6 |

> **P5d 实施时的调整**：见 ADR 0014 的“P5d”一节。已有的 Pi 会话始终用 Pi 打开，只有新任务跟随引擎设置。切换提示会列出不会迁移的 provider；`auth.json` 中内置 provider 的密钥导入留到 P6 之前补上。

每个 PR 都要满足：CI 全绿、做过 GitNexus 影响分析、补齐相应的 ADR（P5a 的密钥与热重载、P5b 的前端适配层各写一篇）。

## 5. 风险

| 风险 | 对策 |
|---|---|
| store 改造牵连面大，容易引入回归 | 先用 `RuntimeAdapter` 把 Pi 路径原样包起来，Pi 的行为不变；Harness 路径单独测试；默认引擎到 P5d 才切换 |
| Bun FFI 调用 DPAPI 出错（打包后路径、权限） | 编译后的 exe 冒烟测试里加入解密用例；失败时 provider 显示“密钥不可用”，不影响其他功能 |
| 热重载时插件卸载不干净（MCP 子进程、浏览器） | 每个插件的副作用都已挂在 `ctx.effect` 上（0003）；补测试：重载后没有遗留进程，旧工具已注销 |
| 两套调度器同时运行 | 按 `engine` 只启用其中一套，并在任务表迁移时加锁 |
| 真实模型的流式格式与手写夹具不同（0007 提过） | P5b 第一次端到端联调时用真实 key 录制响应，补充到契约测试中 |
