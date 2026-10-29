# V2 重构方案：自研 Agent Harness（cordis 插件化），移除 Pi 运行时

> 状态：方向已确认（全自研，决策见第 7 节）。P0（#73）、P1（#76）、P2（#77）已完成，P3（#78）、P4 前三批（#79、#81、#82）已完成，P4 最后一批进行中。允许破坏性调整。
> 参考：DeepSeek Harness（DSH）的 cordis 插件架构（`@deepseek-ai/dsh-*`，MIT / BSD-3-Clause）。

## 1. 目标与非目标

**目标**
- 不再以 `pi --mode rpc` 作为执行引擎，自己实现 agent loop、工具管线、会话存储和模型接入。
- 扩展机制改为 **cordis 插件**：所有能力（工具、权限、MCP、浏览器、computer-use、子 agent、记忆、计划、hooks、checkpoint、better-sidebar）都是同一个 cordis 根上下文里的插件，统一生命周期、依赖注入和配置。
- 前端与新 Harness 之间使用自己定义的、带版本号的协议，不再透传 Pi 的 JSONL 事件。
- Rust 层瘦身，只负责原生能力和进程托管。

**非目标（本轮不做）**
- 兼容 Pi 扩展（`ExtensionAPI`）和 Pi packages 生态。
- 云端执行、账号体系。
- 操作系统级沙箱（保留在后续路线上，DSH 的 `dsh-sandbox-windows-acl` 可以参考）。

## 2. 现状：对 Pi 的依赖面

| 层 | 依赖点 | 规模 |
|---|---|---|
| 进程 | 每个任务一个 `pi --mode rpc` 子进程（`src-tauri/src/pi/*`），由 `scripts/prepare-pi-runtime.mjs` 用 bun 打包 | Rust 约 2k 行 |
| RPC 命令 | `prompt` `steer` `follow_up` `abort` `get_state` `get_messages` `get_commands` `get_available_models` `set_model` `get_available_thinking_levels` `set_thinking_level` `new_session` `switch_session` `fork` `clone` `get_fork_messages` `compact` `set_session_name` `export_html` `get_session_stats` `bash` `abort_bash` | 约 22 个 |
| 事件 | `agent_*` `turn_*` `message_*` `tool_execution_*` `queue_update` `compaction_*` `auto_retry_*` `extension_ui_request` 等（`src/types.ts`） | 约 20 种 |
| 前端 | `src/lib/pi.ts`、`piTransport.ts`、`piRpcRouter.ts`、`piProtocol.ts`、`piMessages.ts`、`piToolCalls.ts`、`store.ts`；共 11 个文件引用 `usePiStore` | 核心约 3k 行 |
| 扩展 | `src-tauri/resources/pidesktop-*.ts`，使用 `pi.registerTool`（22 处）、`registerCommand`（13 处）、`sendMessage`、`appendEntry`，以及 `pi.on('tool_call' / 'before_agent_start' / 'session_start' / …)` | 约 4.6k 行 |
| 磁盘格式 | `~/.pi/agent/sessions/*.jsonl`（`pi/sessions.rs` 直接解析）、`models.json`（`commands/provider.rs`）、`settings.json` 和 packages（`commands/packages.rs`）、`.pi/themes` 与 `.pi/pets` | Rust 约 2.5k 行 |

`src-tauri/resources/*-core.ts` 里的纯逻辑（规则求值、checkpoint、hooks、plan、subagents、computer-core、providers-core）**大部分可以直接复用**，只需要换掉外层的 Pi 适配。

## 3. 参考：DSH 的 cordis 设计要点

DSH 把 harness 拆成 100 多个小包，可以归纳出几条值得照搬的规则：

1. **接口包与实现包分离**。例如 `dsh-llm`（抽象服务和词汇表）对应 `dsh-llm-deepseek` / `dsh-llm-pi-ai`（适配器）；`dsh-fs` 对应 `dsh-fs-local` / `dsh-fs-sandbox`；`dsh-session-persistence` 对应 `-jsonl`。消费方只依赖接口包。
2. **只有一个包包含 loop 逻辑**（`dsh-agent-loop`）。其余能力都是挂在扩展点上的插件，新增行为不改 loop。
3. **扩展点就是 cordis 事件的不同语义**：
   - `waterfall`：可以改写的管线，例如 `llm/request`、`tools/pre-execute`、系统提示词组装；
   - `bail`：第一个返回值胜出，用于权限放行或拒绝；
   - `serial` / `parallel`：顺序或并发的生命周期钩子；
   - `emit`：只观察，例如 `tools/result`、`session/event`。
4. **Agent 作用域（scope）**：每个 agent 或会话有自己的子上下文。在这个作用域里注册的工具、提示词片段和监听器，会在会话结束时随 fiber 一起释放。子 agent 就是带 owner 的子作用域。
5. **会话采用事件溯源**：Session 是只追加的事件日志，LLM 消息由它派生。持久化是订阅 `session/event` 的插件，fork 和回退都按事件序号切分。
6. **配置用 schemastery 声明**，由 loader 按配置文件装配插件，支持热更新。

本方案**沿用这套机制，代码自己写**。DSH 的包目前都是 rc 版本，接口还会变，不直接依赖它们，只作为设计参考，并在 ADR 里记录对照关系。

## 4. 目标架构

```text
┌────────────── React UI（Tauri WebView）──────────────┐
│ store slices: runtime / sessions / transcript / ui  │
│ agentClient ── WebSocket JSON-RPC（loopback + token）│
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────── Harness Host（Bun 单文件 exe）────────────┐
│ cordis root                                          │
│  ├ core:   logger · settings(schemastery) · storage   │
│  ├ gateway: webServer · rpc（协议 v1）· ui-bridge     │
│  ├ llm:    llm 接口 · openai-compat · anthropic · …   │
│  ├ agent:  agents 接口 · agent-loop（唯一的 loop）    │
│  ├ session: sessions · persistence-jsonl · query     │
│  ├ tools:  tools 接口 · fs · bash · search · edit     │
│  ├ policy: permissions · rules · approval · hooks     │
│  ├ prompt: system-prompt · context-files · skills     │
│  ├ feats:  plan · memory · checkpoints · subagents ·  │
│  │         compaction · title · schedule              │
│  ├ integ:  mcp · browser(CDP) · computer(→原生助手)   │
│  └ ui:     better-sidebar（原 sidecar，原样加载）     │
└───────────────────────┬──────────────────────────────┘
                        │ 托管 / 原生能力
┌──────────────── Rust（Tauri）─────────────────────────┐
│ 窗口/托盘 · Host 进程托管（启动、重启、退出清理）       │
│ PTY 终端 · Git · computer-use 原生助手 · 密钥存储       │
└──────────────────────────────────────────────────────┘
```

关键决策：

- **单个 Host 进程承载多个会话**，取代“每个任务一个 Pi 进程”。每个会话是一个 cordis 子作用域，取消、释放和资源回收都交给 fiber。bash 等工具本来就会起子进程，所以隔离性不会变差。Host 崩溃时由 Rust 拉起，会话从磁盘恢复。
- **把 better-sidebar sidecar 合并进 Host**。它本来就是 cordis 插件，注入的 `webServer`、`sessions`、`tools`、`webRuntime` 改由 Host 原生提供，不再需要 shim。
- **前端直接连 Host**，用 WebSocket 加一次性 token，不再经 Rust 中转 JSONL。Rust 只负责把端口和 token 交给前端（复用现在 `sidebar_host_base` 的做法）。
- **扩展即 cordis 插件**：一个模块导出 `name`、`inject`、`Config`（schemastery）和 `apply(ctx, config)`。内置插件和用户插件（`~/.pid/plugins`、项目内 `.pid/plugins`、npm 包）使用同一套机制。项目级插件仍然需要显式信任。
- **Skills 继续兼容 `SKILL.md`**。这是跨工具通用的格式，不属于 Pi 专有。AGENTS.md 和 CLAUDE.md 等上下文文件同样保留。

### 4.1 Monorepo 布局（npm workspaces）

```text
packages/
  protocol/          # 前端与 Host 的协议：类型、schema、版本
  host/              # Host 入口：cordis 根、loader、bun 打包
  core-*/            # llm, agent, session, tools, system-prompt …（接口包）
  plugin-*/          # agent-loop, llm-openai, tool-fs, permissions, mcp …（实现包）
  testkit/           # mock LLM（脚本化流）、loop 黄金测试工具
src/                 # 前端（保持现有位置）
src-tauri/           # Rust（瘦身）
```

### 4.2 核心扩展点（v1 词汇表草案）

| 事件或服务 | 语义 | 用途示例 |
|---|---|---|
| `ctx.llm.registerAdapter` / `llm/request`（waterfall） | 适配器注册，请求改写 | 新增模型厂商，注入缓存标记 |
| `ctx.tools.register` / `tools/pre-execute`（bail） | 注册工具，执行前放行、拒绝或询问 | 权限模式、规则、plan 模式只读 |
| `tools/execute`（waterfall） / `tools/result`（emit） | 包裹执行，观察结果 | checkpoint、hooks、输出截断 |
| `ctx.systemPrompt.section()` | 提示词片段 | 模式说明、rich content、记忆、skills |
| `agent/turn-start` `agent/turn-end` `agent/settled`（serial） | 生命周期 | 计划同步、标题生成、通知 |
| `session/event`（emit） / `session/flush`（parallel） | 事件溯源 | jsonl 持久化、查询索引 |
| `ctx.ui.confirm/select/input/notify` | 发往前端的交互请求 | 取代 `extension_ui_request` |
| `ctx.commands.register` | 斜杠命令 | 取代 `pi.registerCommand` |

## 5. 分阶段计划

每个阶段单独提 PR，CI 保持全绿。P1 到 P5 期间 Pi 路径保持可用，通过设置项 `engine: pi | harness` 切换，到 P6 再删除 Pi 路径。

| 阶段 | 内容 | 完成标准 | 依赖 |
|---|---|---|---|
| **P0 设计定稿** | 本文档评审；ADR：协议、事件词汇、会话格式、目录布局；workspace 脚手架 | ADR 合入，`packages/` 能构建和测试 | — |
| **P1 Host 骨架** | 新建 `packages/host`，cordis 根、logger、settings、storage、webServer、WS JSON-RPC gateway、token 鉴权；把 better-sidebar sidecar 并入；Rust 的 `sidebar_host.rs` 改为通用的 `harness_host.rs` 托管 | 侧边栏功能不回退；`ping` 和 `host.info` 能从前端调用 | P0 |
| **P2 LLM 层** | `core-llm` 接口（流式块：text、thinking、tool_call、usage、finish）；适配器 `llm-openai-compat`（覆盖 OpenAI、DeepSeek、OpenRouter、Ollama 等）、`llm-anthropic`、`llm-gemini`；模型目录和发现；provider 配置从 `models.json` 迁到自有配置；密钥通过 Rust `secret_store` 下发；重试策略 | 用 mock server 和真实 key 跑通流式与工具调用；用量和费用字段齐全 | P1（可与 P3 并行起步） |
| **P3 Loop 与会话** | `core-session`（事件溯源，支持 fork、rewind、compaction 边界）+ `session-persistence-jsonl`；`core-agent` + `agent-loop`（turn/step、并行工具、abort、steer 和 follow-up 队列、自动重试、compaction）；`core-tools` 管线；内置工具 read/write/edit/bash/grep/find/ls；system-prompt 与上下文文件、skills；`testkit` 黄金测试 | headless 模式能完成一个真实编码任务；loop 的黄金测试覆盖各类事件序列 | P2 |
| **P4 能力迁移** | 每个 `pidesktop-*` 迁成一个 cordis 插件：permissions/rules/guard → `tools/pre-execute`；plan、memory、hooks、checkpoints；subagents 改为进程内子 agent 作用域；mcp、browser、computer；schedule 从 Rust 移入 Host；title 和 usage | `scripts/test-*.test.ts` 中对应套件迁移后通过；`CODEX_PARITY.md` 逐项对照 | P3。各插件之间相互独立，可以并行 |
| **P5 前端切换** | `packages/protocol` 生成客户端；`lib/pi*` 替换为 `agentClient`；拆分 `store.ts` 为 slices，从 `App.tsx` 抽出路由和视图；extension UI 改为 `ui` 服务；“Pi 包”页面改为插件和 skills 管理；`dsh-host` 的 `PiSessions` 改为直接读 Host 的 sessions | `engine=harness` 下全部功能可用；前端组件测试补到关键路径 | P3，并随 P4 逐步推进 |
| **P6 移除 Pi** | 删除 `@earendil-works/*`、`prepare-pi-runtime`、Rust `pi/*`、`provider.rs` 和 `packages.rs` 中与 Pi 相关的代码、`engine` 开关；提供可选的一次性导入器（`~/.pi/agent/sessions` → 新格式）；更新 README、CODEX_PARITY、THIRD_PARTY_NOTICES；处理产品改名和数据目录 | 仓库里没有 Pi 运行时依赖；安装包体积和启动时间有记录 | P5 |
| **P7 加固** | Host 崩溃恢复、会话并发压测、内存和句柄泄漏检查（fiber 释放）、E2E（Tauri + mock LLM）、可观测性（日志和 trace） | 发布 0.3.0 | P6 |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 自研 loop 的边界情况很多（中断、并行工具、重试、compaction 时机） | 只允许一个 loop 包；testkit 提供脚本化 mock LLM；参考 DSH `agent-loop-testkit` 的做法写黄金测试 |
| 多厂商流式协议差异（thinking、工具参数增量、缓存） | 统一的块组装器，加上每个适配器各自的契约测试（录制真实响应回放）；先覆盖 openai-compat 和 anthropic 两种协议，再扩展其他厂商 |
| 单进程多会话，一个会话异常拖垮全部 | 每个会话的工具执行都在 try 和 abort 边界内；Host 由 Rust 托管自动重启；会话随时落盘 |
| 改动面大，长期分支难以合并 | `engine` 开关让两条路径共存，坚持小 PR 合入 main |
| cordis 版本风险（4.0.x，存在 alpha 版本） | 锁定版本；只用 Context、Service、事件、fiber 这些稳定 API |
| 用户历史会话丢失 | P6 提供导入器；旧数据只读，不删除 |

## 7. 已确认的决策

- **D1 全自研**：loop 和模型适配器都自己写，不引入 `pi-ai` 或 `pi-agent-core` 作为过渡。适配器先做 openai-compat（覆盖 OpenAI、DeepSeek、OpenRouter、Ollama 等）和 anthropic，再做 gemini。
- **D2 单 Host 多会话**：一个 Host 进程，每个会话是一个 cordis 子作用域；Host 由 Rust 托管，崩溃后自动重启，会话从磁盘恢复。
- **D3 一次性导入器**：在 P6 提供可选导入，把 `~/.pi` 下的会话和模型配置转成新格式；旧数据只读，不删除。
- **D4 暂不改名**：开发期间继续叫 Pi Desktop，新数据目录先用 `~/.pid`；产品改名放到 P6 统一处理。
- **D5 Bun 单文件 exe**：沿用现有的 bun 打包链路（`prepare-pi-runtime`、`prepare-sidebar-host`）。

## 8. 落地前的准备

- 仓库内没有 GitNexus 索引（`.gitnexus/` 不存在）。按 CLAUDE.md 的要求，每个阶段动手前先执行 `npx gitnexus@latest analyze`，再对 `usePiStore`、`sendCommand`、`subscribeToPi`、`PiSessions` 以及 Rust 的 `pi::*` 做 upstream impact，并在 PR 描述里附上结果。
- 本方案中的规模统计来自文本搜索，只用于估算工作量，不能替代 impact 分析。
