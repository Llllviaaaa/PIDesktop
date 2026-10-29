# @pid/agent

agent 的接口，见 [ADR 0008](../../docs/adr/0008-agent-loop-and-sessions.md)。唯一的实现是 `@pid/agent-loop`。

## 服务

`agents`：`prompt`、`steer`、`followUp`、`abort`、`compact`、`status`、`idle`。运行中再次 `prompt` 抛 `AgentBusyError`，会话没有模型时抛 `NoModelError`。

## 事件

| 事件 | 方式 | 说明 |
|---|---|---|
| `agent/before-start` | serial | 一次运行开始 |
| `agent/turn-start` / `agent/turn-end` | serial | 每一轮的开始和结束 |
| `agent/settled` | parallel | 运行结束，带结果 |

实时进度以 `AgentDelta` 的形式通过 `session/delta` 发出。
