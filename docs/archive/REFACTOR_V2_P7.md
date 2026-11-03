# P7 细化方案：加固与发布 0.3.0

> 上级文档：[V2 重构方案](REFACTOR_V2_PLAN.md) 第 5 节的 P7 一行。
> 状态：方案已确认（决策见第 2 节），按第 4 节分 5 个 PR 实施。

## 1. 现状

P6 结束后，Pi 已经完全移除：桌面端只通过 Harness Host 运行，前端直接使用 Host 的事件形状，store 也已按 slice 拆分。还缺的是出了问题之后的表现：

| 方面 | 现状 |
|---|---|
| Host 崩溃 | Rust 会重启 Host：重启前等待的时间逐次变长，一分钟内崩溃 5 次后停止重启（`harness_host.rs`）。**前端不会重连**：WebSocket 关闭后，正在进行的调用会失败，但 `harnessRuntime` 仍然持有已经断开的连接，之后的所有调用都会失败，直到刷新页面。runtime 也不会重新订阅自己的会话。 |
| 中断的一轮 | 一轮进行到一半时 Host 崩溃，会话日志会停在这一轮中间。下次构建上下文时，没有结果的工具调用会补上“已中断”的结果（`INTERRUPTED_TOOL_RESULT`）。但界面上的 `isStreaming` 会一直保持为 true，直到重新同步。 |
| 内存 | Host 打开过的会话一直留在 `Sessions.open` 中，除非被删除，长时间运行时会不断累积。重载插件时会释放 fiber（ADR 0003），但还没有测试确认没有遗留的子进程和句柄。 |
| 并发 | 已有测试覆盖单个会话内并行的工具调用，但没有测试一个 Host 同时运行多个会话的情况。 |
| 日志 | Host 把日志写到 stderr，Rust 再用 `eprintln!` 输出。Windows 的发布版没有控制台，这些日志会全部丢失。没有调用级别的 trace。 |
| E2E | 没有。现有测试只覆盖到前端适配层与进程内 Host 之间（`test-harness-runtime`），没有测试真实页面的交互。 |
| P6 遗留 | Cargo 里已经用不到的依赖（`json5`、`regex`、`rusqlite`、`chrono`、`ureq`、`urlencoding` 和为 `ureq` 打的 rustls 补丁）；模型设置页里用不上的 OAuth 登录界面和 `providerService` 兼容层；仍带 Pi 字样的命名（`subscribeToPi`、`PiRuntimeStatus`、`piLog`）。 |

## 2. 已确认的决策

- **P7-1 E2E 测试在浏览器中运行，每个 PR 都跑**：
  - Playwright 打开前端的生产构建，连接一个真实的 Host，Host 使用脚本化的模型；在 Windows CI 上运行。
  - Tauri 命令（设置、Git、项目等）在测试中用桩代替。
  - Tauri 外壳本身由 Rust 测试和发布前的手动检查清单覆盖。
- **P7-2 日志和 trace 只写在本机**：
  - Host 和桌面端的日志都写到 `~/.pid/logs`，按天滚动，保留 7 天；
  - 每个 RPC 和每次模型调用都带 trace id 和耗时，敏感信息照常脱敏；
  - 设置里提供“打开日志目录”和“导出诊断包”，由用户自己决定是否附到 issue 上；
  - 不上传任何数据。
- **P7-3 0.3.0 一并清理 P6 遗留**：删除不再使用的 Cargo 依赖、OAuth 界面和 `providerService` 兼容层，并改掉剩下带 Pi 字样的命名。

## 3. 关键设计

### 3.1 崩溃恢复

- **前端重连**（`harnessClient.ts`、`harnessRuntime.ts`）：
  - 连接关闭时丢弃这个连接。下一次调用，或者一个后台重连循环（间隔 0.5 秒、1 秒、2 秒、4 秒，最多 30 秒），通过 `harness_endpoint` 重新取得地址；Rust 会在这里按退避规则重启 Host。
  - 连上之后，每个 runtime 用 `session.subscribe { afterSeq: lastSeq }` 重新订阅，补上断开期间写入的事件；再读一次 `state`，修正 `isStreaming`。
  - 断开期间，界面顶部显示“Harness 已断开，正在重连”；Rust 停止重启后，显示“Harness 多次崩溃”，并提供重新启动的按钮。
- **未完成的一轮**：
  - Host 启动后，日志停在一轮中间的会话照常打开；
  - 重新订阅后，前端从 `state` 得知会话已不在运行，把还在流式显示的回复标记为中断（`isError`），并结束这一轮；
  - 不自动重试。
- **Rust**：`harness_endpoint` 返回时附带一个 Host 实例编号，每次重启加一，前端据此判断 Host 是否重启过；同时补上 `KEEPS_CRASHING` 之后让用户重新启动 Host 的命令。
- **测试**：
  - 在测试中停止进程内的 Host 再重新启动，检查 runtime 能自动重连并补上断开期间的事件，新的提示可以正常发送；
  - 停在一轮中间的会话重新打开后，回复被标记为中断。

### 3.2 内存泄漏与并发

- **会话缓存**：`Sessions` 只把正在运行、或者有订阅者的会话留在内存中。其余会话闲置 10 分钟后卸载，下次用到时再从存储读取。
- **连接清理**：WebSocket 关闭时，释放这个连接的订阅和由它发起、尚未回答的 `ui/request`。
- **插件重载**：补充测试，确认反复重载 MCP、浏览器、电脑操控插件之后，没有遗留的子进程，旧工具已注销，计时器已清除。
- **并发压测**（`packages/host/test/stress.test.ts`）：
  - 一个 Host 同时运行 20 个会话，使用脚本化的模型和工具；
  - 检查每个会话的日志各自完整、顺序正确，通知没有发到别的会话；
  - 反复创建再删除 200 个会话之后，堆内存和活动句柄回到基线附近（允许一定误差）。
  - 压测作为单独的 CI 步骤运行，不放进 `test:unit`。

### 3.3 可观测性

- **Host**：
  - `Logger` 增加一个写文件的 exporter，写到 `~/.pid/logs/host-YYYY-MM-DD.log`，保留 7 天；
  - RPC 网关为每个调用生成 trace id，记录方法名、耗时和结果；`llm` 服务记录每次模型调用的 provider、模型、token 数和耗时；
  - 所有日志都经过 `redact` 处理。
- **Rust**：Host 的 stderr 和桌面端自己的日志写到 `~/.pid/logs/desktop-YYYY-MM-DD.log`，不再只输出到控制台。
- **设置 › 调试**：
  - “打开日志目录”；
  - “导出诊断包”：一个 zip，包含最近的日志、版本号和脱敏后的设置，由用户自己保存。

### 3.4 E2E

- **Host**：测试专用的入口 `packages/host/test/e2e-host.ts`，组合真实的插件，再加上读取脚本文件的模型。生产代码不增加测试开关。
- **前端**：在 `vite build` 时加一个 e2e 模式，加载 `src/dev/tauriStub.ts`，把 Tauri 的 `invoke` 换成返回固定数据的桩（设置、项目、Git 快照等），Host 地址和 token 通过 URL 传入。
- **场景**（`e2e/*.spec.ts`）：
  - 发送消息，看到流式输出；
  - 工具调用触发权限确认，允许和拒绝两种情况；
  - 回退和编辑消息；
  - 从会话树分叉；
  - 侧边聊天；
  - 立即运行一个定时任务；
  - 保存一个 provider；
  - Host 重启后重连（依赖 3.1）。
- **CI**：在 Windows runner 上运行，失败时上传截图和 trace。

### 3.5 收尾与发布

- **P6 遗留**：
  - 删除不再使用的 Cargo 依赖，并重新生成 `Cargo.lock`。本地没有 Rust 工具链，需要用一次 CI 运行生成后提交，或者在本机安装工具链。
  - 模型设置页去掉 OAuth 登录界面，直接使用 `harnessProviders`，删除 `providerService` 兼容层。
  - 改名：`subscribeToPi` → `subscribeToRuntimes`，`PiRuntimeStatus` → `RuntimeStatus`，`piLog` → `hostLog`，用 language service 的 rename 完成。
- **发布 0.3.0**：
  - 版本号改为 0.3.0（`package.json`、`Cargo.toml`、`tauri.conf.json`、两个 lockfile）；
  - 编写发布说明，重点写从 0.2 升级时的迁移：provider、密钥、技能、历史任务的导入，以及 OAuth 登录不再支持；
  - 手动检查清单收录 P5 和 P6 PR 中所有标记为“未在应用中验证”的项目，在安装包上逐项确认；
  - 记录安装包体积和冷启动时间，与 0.2.29 对比。

## 4. 分 PR 实施

| PR | 内容 | 完成标准 |
|---|---|---|
| **P7a 崩溃恢复** | 第 3.1 节 | 进程内 Host 重启后，runtime 自动重连并补上事件；停在一轮中间的会话显示为中断（有测试） |
| **P7b 泄漏与并发** | 第 3.2 节 | 20 个会话的并发压测通过；反复创建和删除后内存、句柄回到基线；重载插件后没有遗留的子进程 |
| **P7c 可观测性** | 第 3.3 节 | 两个日志文件按天滚动；RPC 和模型调用带 trace id；诊断包中没有密钥（有测试） |
| **P7d E2E** | 第 3.4 节 | 8 个场景在 Windows CI 上每个 PR 都运行 |
| **P7e 收尾与 0.3.0** | 第 3.5 节 | 没有未使用的依赖；没有带 Pi 字样的 API；手动检查清单全部通过；0.3.0 安装包已构建 |

P7a、P7b、P7c 互不依赖，可以并行开发。P7d 的重连场景依赖 P7a。P7e 最后进行。

## 5. 风险

| 风险 | 对策 |
|---|---|
| 重连时重放事件，出现重复或乱序 | 按 `lastSeq` 续订，Host 只发送更新的事件；reducer 按 seq 去重；有测试覆盖 |
| 卸载会话时，正好有调用到达 | 只卸载既没有订阅者、也不在运行的会话；`Sessions.get` 本来就会重新加载 |
| 浏览器 E2E 用桩代替 Tauri，桩与真实命令不一致 | 桩的数据复用 Rust 命令的类型；Tauri 外壳由 Rust 测试和手动清单覆盖 |
| 删除 Cargo 依赖后 `--locked` 构建失败 | `Cargo.lock` 用 cargo 生成，不手改；在合并前的 CI 中验证 |
| 日志里泄漏密钥 | 所有写文件的日志都经过 `redact`；为诊断包增加测试，用含密钥的设置检查导出结果 |
