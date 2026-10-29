# @pid/session

事件溯源的会话日志，见 [ADR 0004](../../docs/adr/0004-session-format.md) 和 [ADR 0008](../../docs/adr/0008-agent-loop-and-sessions.md)。

## 服务

| 键 | 类 | 说明 |
|---|---|---|
| `sessions` | `Sessions` | `create`、`get`、`list`、`fork`、`registerStorage`。每个打开的日志对应一个 `Session`，提供 `append`、`delta`、`state`、`flush` |

## 事件

| 事件 | 方式 | 说明 |
|---|---|---|
| `session/created` | emit | 新建了一个会话 |
| `session/event` | emit | 一条事件已交给存储 |
| `session/delta` | emit | 不落盘的实时进度，带 `liveSeq` |
| `session/flush` | parallel | 存储已 fsync，插件做各自的检查点 |

## 派生

`currentBranch`、`deriveState`、`forkEvents`、`compactionPoint` 都是事件列表的纯函数，测试可以直接拿 JSONL 夹具断言。没有注册存储时使用 `MemoryStorage`。
