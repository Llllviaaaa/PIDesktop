# 架构决策记录（ADR）

V2 重构（[REFACTOR_V2_PLAN.md](../archive/REFACTOR_V2_PLAN.md)）期间的架构决策。每条记录一旦“已接受”就不再改写；要推翻某个决策，就新写一条记录取代它，并在旧记录的状态里注明。

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](0001-harness-host-process.md) | Harness Host 进程与托管 | 已接受 |
| [0002](0002-client-protocol.md) | 前端与 Host 的协议 | 已接受 |
| [0003](0003-plugin-model-and-events.md) | 插件模型与扩展点词汇 | 已接受 |
| [0004](0004-session-format.md) | 会话格式（事件溯源 JSONL） | 已接受 |
| [0005](0005-repository-layout.md) | 仓库布局与包约定 | 已接受 |
| [0006](0006-better-sidebar-in-host.md) | better-sidebar 宿主端并入 Host（边界例外） | 已接受 |
| [0007](0007-llm-layer.md) | LLM 层：统一词汇、适配器与密钥引用 | 已接受，部分由 0018 修订 |
| [0008](0008-agent-loop-and-sessions.md) | Agent loop、会话与工具管线 | 已接受，部分由 0019 修订 |
| [0009](0009-feature-plugins.md) | 能力迁移（一）：交互、权限、checkpoint、计划、记忆、hooks | 已接受 |
| [0010](0010-subagents-mcp-usage.md) | 能力迁移（二）：子 agent、MCP、标题与用量 | 已接受 |
| [0011](0011-computer-and-schedule.md) | 能力迁移（三）：computer use 与定时任务 | 已接受 |
| [0012](0012-browser.md) | 能力迁移（四）：内置浏览器 | 已接受 |
| [0013](0013-desktop-settings-and-secrets.md) | 桌面端设置、密钥与热重载 | 已接受 |
| [0014](0014-frontend-harness-adapter.md) | 前端接入 Harness：在传输层模拟 Pi runtime | 已接受 |
| [0015](0015-pi-session-import.md) | 导入 Pi 的历史任务 | 已废弃 |
| [0016](0016-dynamic-plugins-and-hmr.md) | 动态插件内核、分层覆盖与全栈热重载 | 已接受，部分由 0017 修订 |
| [0017](0017-plugin-trust-model.md) | 插件信任模型 | 已接受 |
| [0018](0018-anthropic-adaptive-thinking-and-caching.md) | Anthropic 适配器：自适应 thinking 与提示词缓存 | 已接受 |
| [0019](0019-context-pressure.md) | 上下文压力：提前压缩、摘要请求收缩与工具输出上限 | 已接受 |
| [0020](0020-tool-guards.md) | 工具调用的时限与重复提醒 | 已接受 |
| [0021](0021-powershell-fallback.md) | Windows 上没有 Git Bash 时改用 PowerShell | 已接受 |

## 旧名对照

项目从 PI-Desktop 更名为 Qianji（千机）后，代码里的名字已经全部换成新名。按上面的规则，已接受的记录不再改写，所以早期 ADR 里仍是旧名。阅读时请按下表对照：

| ADR 中的旧名 | 现在 | 兼容情况 |
|---|---|---|
| `@pid/*` 包 | `@qianji/*` | 外部插件仍可以导入 `@pid/*`，由 `packages/host/src/plugin-bridge.ts` 映射到新包 |
| `pid-harness.exe` | `qianji-harness.exe` | 构建时删除旧文件 |
| `PID_HARNESS_TOKEN`、`PID_COMPUTER_HELPER` | `QIANJI_HARNESS_TOKEN`、`QIANJI_COMPUTER_HELPER` | 旧变量仍作为回退读取 |
| `~/.pid/` | `~/.qianji/` | 桌面端启动时自动迁移旧目录 |
| `<workspace>/.pid/` | `<workspace>/.qianji/` | 旧目录仍会读取 |
| 插件清单字段 `pid` | `qianji` | `pid` 仍然兼容 |
| WebSocket 子协议 `pid.v1`、`pid.token.<token>` | `qianji.v1`、`qianji.token.<token>` | 不再接受旧名（前端与 Host 同版本发布，见 `packages/protocol/src/handshake.ts`） |

包与包之间的依赖规则（[0003](0003-plugin-model-and-events.md)、[0005](0005-repository-layout.md)）由 [`tests/test-package-boundaries.test.ts`](../../tests/test-package-boundaries.test.ts) 检查。

## 模板

```markdown
# NNNN 标题

- 状态：提议 | 已接受 | 被 NNNN 取代
- 日期：YYYY-MM-DD

## 背景
## 决策
## 后果
## 备选方案
```
