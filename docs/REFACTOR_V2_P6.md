# P6 细化方案：移除 Pi

> 上级文档：[V2 重构方案](REFACTOR_V2_PLAN.md) 第 5 节的 P6 一行。
> 状态：方案已确认（决策见第 2 节），按第 4 节分 5 个 PR 实施。

## 1. 现状

P5 结束后，Harness 是默认引擎，Pi 只作为退路保留。还依赖 Pi 的地方：

| 层 | 依赖 Pi 的部分 |
|---|---|
| 运行时 | `@earendil-works/pi-ai`、`pi-coding-agent` 两个 npm 依赖；`prepare-pi-runtime` 把 Pi 打包进 `src-tauri/resources/pi-runtime`；`pidesktop-*.ts` 共 18 个 Pi 扩展，由 `extensions.rs` 嵌入并写出。 |
| Rust | `pi/*`：进程、RPC、会话解析、side chat、runtime 复用，约 2.4k 行。`commands/` 下的 `runtime.rs`、`session.rs`、`provider.rs`（`models.json`）、`packages.rs`（Pi 包市场、技能和外观扩展目录）、`schedule.rs` 与 `scheduler.rs` 中的 Pi 执行器、`usage.rs`，以及 `commit.rs`（用 `pi --print` 生成提交信息）。`config.rs` 里有 `piBinary`、`sessionDir`、`separatePiConfig`、`engine`、`harnessPromptSeen` 和 Pi 配置目录。 |
| 前端 | `pi.ts`、`piTransport.ts`、`piRpcRouter.ts`、`piProtocol.ts`、`piMessages.ts`、`piToolCalls.ts`；`providerService.ts`（Pi 的 provider 服务，用于 OAuth 登录）；“插件”页面（Pi 包）；`HarnessOffer`；设置里的引擎开关和 Pi 进程设置。 |
| 前端状态 | `store.ts`（1.6k 行）仍然处理 Pi 的事件形状。Harness 的事件由 `harnessRuntime.ts` 在传输层转换成 Pi 事件（ADR 0014），会丢失一些信息：不计费用，`messageCount` 不计工具结果。 |
| 用户数据 | 旧会话在 `~/.pi/agent/sessions`（或自定义的 `sessionDir`、独立配置目录）；技能、主题、宠物在 `~/.pi/agent/{skills,themes,pets}` 和项目的 `.pi/` 下。 |

## 2. 已确认的决策

- **P6-1 先移除 Pi，再改为原生形状**：
  - 先补齐还缺的 Host 功能，再整体删除 Pi。删除时保留 `harnessRuntime` 这层模拟，界面行为不变，应用尽早摆脱 Pi。
  - 之后的 PR 把前端改为直接使用 Host 的事件形状，同时把 store 拆成 runtime、sessions、transcript、ui 几个 slice。
- **P6-2 旧会话一次性导入**：
  - Host 把 Pi 会话转换为 `~/.pid` 的会话，原文件只读，不修改也不删除。
  - 导入后是普通的 Harness 会话，可以继续对话。
  - 升级后首次启动时提示一次，设置里也可以随时重新执行；重复执行会跳过已导入的会话。
- **P6-3 暂不改名**：
  - 继续叫 Pi Desktop，数据目录仍是 `~/.pid`。
  - 界面里与 Pi 引擎有关的文字一并去掉。
  - 改名等定下新名字后单独处理。

## 3. 关键设计

### 3.1 补齐 Host 功能（删除 Pi 之前）

- **生成提交信息**：
  - Host 新增 RPC `llm.complete`：一次不带工具的模型调用，参数为 `{ provider?, model?, system?, prompt }`，没有指定模型时使用默认模型。
  - `commit.rs` 改为通过 Host 调用，不再执行 `pi --print`。
- **技能、主题、宠物的目录**：
  - 技能、主题、宠物的用户目录改为 `~/.pid/{skills,themes,pets}`，项目目录改为 `.pid/`。技能目录与 `@pid/prompt-context` 已经读取的位置一致。
  - 首次启动时，把 `~/.pi/agent` 下的这三个目录复制一次，已存在的同名项不覆盖。
  - 项目里的 `.pi/` 不自动复制：项目目录归用户管理。设置页提示可以手动迁移。
- **用量**：`usage.summary` 只统计 Host 的会话。导入的 Pi 会话保留原来的 token 数，所以旧用量不会消失。

### 3.2 Pi 会话导入器

- **触发方式**：Host 新增 RPC `import.piSessions`：
  - 参数为要扫描的目录：默认会话目录、独立配置下的会话目录，以及设置里自定义的 `sessionDir`；
  - 过程中用 `import/progress` 通知报告进度；
  - 返回导入、跳过和失败的数量。
- **转换**：
  - Pi 的会话是一棵树（每条记录带 `parentId`），只导入叶子所在的当前分支，与侧边栏打开时看到的内容一致。
  - `message` 按角色映射为 `user`、`assistant`、`tool-call`/`tool-result`。
  - `model_change` 映射为 `model`，`thinking_level_change` 映射为 `effort`，`compaction` 保留摘要。
  - 标题、cwd、创建时间和 usage 原样带过来。
  - 认不出的记录类型跳过，并计入报告。
- **幂等**：
  - 会话头记录 `importedFrom: { format: "pi", file, id }`。
  - `~/.pid/pi-import.json` 记下已导入的文件和它们的修改时间，重复导入时跳过。
- **测试**：用 Pi 会话样本做 golden 测试，包括分支、压缩、工具调用和图片。在 Pi 依赖删除之前，这些样本从真实的 Pi 运行中录制并提交进仓库。
- **界面**：
  - 升级后首次启动时，显示一次“导入 Pi 的历史任务”，列出找到的会话数量；
  - 设置 › 已归档 页提供同样的按钮；
  - 导入完成后刷新侧边栏。

### 3.3 删除 Pi

- **依赖与打包**：
  - 删除 `@earendil-works/*` 依赖、`prepare-pi-runtime`、`test-pi-runtime`、`src-tauri/resources/pi-runtime` 和 18 个 `pidesktop-*.ts`；
  - 修改 Tauri 的 `resources` 配置，不再打包这些文件。
- **Rust**：
  - 删除 `pi/*`、`extensions.rs`、`provider.rs`、`runtime.rs` 和 Pi 的会话列表；
  - 定时任务只保留 Host 一套，删除 `scheduler.rs` 中的 Pi 执行器和 `run_due_scheduled_tasks`；
  - `packages.rs` 只保留外观扩展目录（已改为 `~/.pid`），删除 Pi 包市场的部分。
- **设置**：
  - 删除 `piBinary`、`sessionDir`、`separatePiConfig`、`engine`、`harnessPromptSeen`。旧设置文件里这些字段会被忽略。
  - 还停留在 Pi 引擎上的安装，升级后直接使用 Harness，并看到 3.2 节的导入提示。
- **前端**：
  - 删除 `providerService` 和 OAuth 登录界面、“插件”页面、`HarnessOffer`、引擎开关和 Pi 进程设置；
  - `pi.ts` 改名为 `agent.ts`，只保留与 Host 相关的部分。
- **保留**：
  - Host 里的 `pi-import.ts`（`models.json` 和 `auth.json`）和 `pi-builtins.ts` 保留，P7 再评估。
  - `test-pi-builtins.test.ts` 在 Pi 不存在时会跳过，改为固定的样本。
- **文档与记录**：
  - 更新 README、CODEX_PARITY、THIRD_PARTY_NOTICES；
  - 在 PR 中记录删除前后的安装包体积和冷启动时间。

### 3.4 前端改为 Host 的原生形状

- **事件**：
  - store 直接处理 Host 的 `PersistedEvent` 和 `LiveDelta`；
  - `harnessTranscript.ts` 的映射改为 transcript slice 的 reducer；
  - 删除 `harnessRuntime.ts` 里模拟 Pi 命令的部分（`sendCommand` 和 `pidesktop-*` 斜杠命令），以及 `piMessages`、`piProtocol`、`piRpcRouter`、`piTransport`。
- **store 拆分**：
  - `runtime`：连接、运行状态、模型、权限；
  - `sessions`：列表、归档、fork 和回退；
  - `transcript`：消息和流式内容；
  - `ui`：对话框、通知、hub 页面。

  组件按 slice 订阅，不再整体订阅 `usePiStore`，之后改名为 `useAppStore`。
- **补回模拟层丢失的信息**：transcript 显示 Host 给出的费用（如果 provider 提供了价格）和完整的消息计数。

## 4. 分 PR 实施

| PR | 内容 | 完成标准 |
|---|---|---|
| **P6a 补齐 Host 功能** | `llm.complete` 和提交信息改由 Host 生成；技能、主题、宠物改用 `~/.pid` 的目录，并一次性复制 | 没有 Pi 可执行文件时，提交信息、技能页、外观扩展都能正常使用（有测试） |
| **P6b Pi 会话导入器** | `import.piSessions`、golden 样本、首次启动提示和设置里的按钮 | 样本中的会话导入后可以继续对话；重复导入不会产生重复会话 |
| **P6c 删除 Pi** | 第 3.3 节的全部内容 | 仓库里没有 Pi 运行时依赖；CI 全绿；安装包体积和启动时间已记录 |
| **P6d 原生事件** | store 直接处理 Host 事件，删除模拟层 | 现有的端到端适配测试改用原生事件后通过；费用和消息计数正确 |
| **P6e 拆分 store** | 拆成四个 slice，组件改为按 slice 订阅 | 不再有组件整体订阅 store；行为不变（现有测试和截图对比） |

P6a 和 P6b 互不依赖，可以并行开发。P6c 依赖这两个。P6d 和 P6e 依次进行。

> **P6d 拆成两个 PR**：P6d-1 把命令改为类型化的方法调用（ADR 0014 “P6d-1”一节）；P6d-2 让 store 直接处理 Host 的事件，删除 `piMessages` 和 Pi 的事件、消息类型，并把 `pi.ts` 改名为 `agent.ts`。

> **P6c 实施时的调整**：
> - `pi.ts` 暂不改名为 `agent.ts`：改名涉及所有引用它的文件，放到 P6d 用 GitNexus 的 rename 一起做。
> - `providerService` 暂时保留原来的接口，改由 Host 实现：列表来自 Host，填写或删除密钥改为编辑 provider，OAuth 直接报错。模型设置页留到 P6d、P6e 再整理。
> - Rust 的 `separate_pi_config` 作为隐藏设置保留，只用来找到 Pi 原来的配置目录，供一次性导入读取。`sessionDir` 同样只供导入使用。
> - Cargo 里已经用不到的依赖（`json5`、`regex`、`rusqlite`、`chrono`、`ureq`、`urlencoding` 和为 `ureq` 打的 rustls 补丁）暂时保留：删除它们需要重新生成 `Cargo.lock`，留到有本地 Rust 工具链时再处理。
> - Host 的定时任务改为始终启用：桌面端不再发送 `engine`，Rust 的调度器也已删除。
> - 体积：删除前打包的 Pi 运行时（`resources/pi-runtime`）未压缩约 132 MB；Harness Host（`pid-harness.exe`）约 111 MB，P5 起已经打包。冷启动时间需要在安装包上测量，本地没有 Rust 工具链，暂未测量。

每个 PR 都要满足：CI 全绿、做过 GitNexus 影响分析、补齐相应的 ADR（导入器、原生事件各写一篇）。

## 5. 风险

| 风险 | 对策 |
|---|---|
| 导入器漏掉 Pi 的某些记录类型，旧会话显示不全 | 认不出的类型计入报告，不静默丢弃；golden 样本覆盖分支、压缩、图片和工具调用；原文件不动，之后可以重新导入 |
| 删除 OAuth 登录后，订阅用户失去 provider | 升级提示里明确说明，并引导用户改用 API key（P5d 的提示已经列出这些 provider） |
| P6c 的改动面很大（约 9k 行 Rust 和前端代码） | 先完成 P6a 和 P6b，删除时不再改变功能；按目录分提交，便于审查和回滚 |
| 拆分 store 时出现渲染回归 | 先完成 P6d，确定数据形状后再拆；每个 slice 单独测试；用截图对比主要页面 |
| 项目目录里的 `.pi/` 技能和扩展不再生效 | 设置页检测到 `.pi/` 时提示迁移到 `.pid/`，并提供一键复制 |
