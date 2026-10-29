# 架构决策记录（ADR）

V2 重构（[REFACTOR_V2_PLAN.md](../REFACTOR_V2_PLAN.md)）期间的架构决策。每条记录一旦“已接受”就不再改写；要推翻某个决策，就新写一条记录取代它，并在旧记录的状态里注明。

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](0001-harness-host-process.md) | Harness Host 进程与托管 | 已接受 |
| [0002](0002-client-protocol.md) | 前端与 Host 的协议 | 已接受 |
| [0003](0003-plugin-model-and-events.md) | 插件模型与扩展点词汇 | 已接受 |
| [0004](0004-session-format.md) | 会话格式（事件溯源 JSONL） | 已接受 |
| [0005](0005-repository-layout.md) | 仓库布局与包约定 | 已接受 |
| [0006](0006-better-sidebar-in-host.md) | better-sidebar 宿主端并入 Host（边界例外） | 已接受 |
| [0007](0007-llm-layer.md) | LLM 层：统一词汇、适配器与密钥引用 | 已接受 |
| [0008](0008-agent-loop-and-sessions.md) | Agent loop、会话与工具管线 | 已接受 |
| [0009](0009-feature-plugins.md) | 能力迁移（一）：交互、权限、checkpoint、计划、记忆、hooks | 已接受 |
| [0010](0010-subagents-mcp-usage.md) | 能力迁移（二）：子 agent、MCP、标题与用量 | 已接受 |
| [0011](0011-computer-and-schedule.md) | 能力迁移（三）：computer use 与定时任务 | 已接受 |
| [0012](0012-browser.md) | 能力迁移（四）：内置浏览器 | 已接受 |

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
