# 0004 会话格式（事件溯源 JSONL）

- 状态：已接受
- 日期：2026-10-28

## 背景

现在的会话格式由 Pi 决定，存放在 `~/.pi/agent/sessions`，由 Rust 的 `pi/sessions.rs` 直接解析。V2 需要一种自己掌控的格式，支持 fork、编辑回退（rewind）、compaction 和断线续传（见 0002 的 `seq`）。

## 决策

### 位置

- 会话文件：`~/.pid/sessions/<YYYY-MM>/<sessionId>.jsonl`，按创建月份分目录，避免单个目录下文件过多。
- 索引：`~/.pid/index.sqlite`（使用 `bun:sqlite`）。只保存可重建的派生数据，包括标题、cwd、更新时间、归档标记和全文检索。索引损坏时直接删除重建。
- `sessionId` 采用 UUIDv7，按时间有序。

### 文件结构

第一行是头部，之后每行一条事件：

```jsonc
{"format":"pid.session","version":1,"id":"…","createdAt":"…","cwd":"D:/repo","forkedFrom":{"sessionId":"…","seq":42}}
{"seq":1,"ts":"…","type":"user","data":{"content":[{"type":"text","text":"…"}]}}
{"seq":2,"ts":"…","type":"assistant","data":{"content":[…],"model":{"provider":"…","id":"…"},"usage":{…},"stop":"tool_use"}}
{"seq":3,"ts":"…","type":"tool-call","data":{"callId":"…","name":"read","args":{…}}}
{"seq":4,"ts":"…","type":"tool-result","data":{"callId":"…","content":[…],"isError":false}}
```

- `seq` 从 1 开始，在会话内严格递增、连续。
- 流式增量**不落盘**，只有完整的消息才写入。
- 每条事件追加写入。每一轮结束时调用一次 fsync，同时在 `session/flush` 时做检查点。

### v1 事件类型

| type | 作用 |
|---|---|
| `user` / `assistant` | 对话消息 |
| `tool-call` / `tool-result` | 工具调用与结果（结果过大时只存 spill 文件的引用） |
| `model` / `effort` | 切换模型或推理强度 |
| `compaction` | `{ throughSeq, summary }`：派生 LLM 上下文时，`throughSeq` 及之前的内容用 summary 替代 |
| `rewind` | `{ toSeq, reason }`：之后派生消息时从 `toSeq` 处续写，`toSeq` 之后的旧事件保留在文件中 |
| `label` | 会话重命名、归档等元信息 |
| `custom` | `{ ns, data }`：插件私有数据，`ns` 必须是插件名。读取方忽略不认识的 `ns` |

### 派生规则

LLM 上下文和前端的对话记录都是从事件序列派生出来的，不单独存储：

1. 从头扫描，遇到 `rewind` 时把当前分支截断到 `toSeq`。
2. 在当前分支上，用最近一次 `compaction` 的 summary 替代 `throughSeq` 及之前的内容。
3. 派生过程只依赖文件本身，具有确定性，测试时可以直接拿 JSONL 夹具做断言。

### fork 与子 agent

- **fork** 会新建一个会话文件，把来源会话截至 `seq` 的当前分支事件复制过去并重新编号，头部的 `forkedFrom` 记录来源。新文件自成一体，删除来源会话不影响它。
- **子 agent** 也是独立的会话文件，头部记录 `parent: { sessionId, callId }`。父会话里只保存 `tool-result` 摘要。

### 版本演进

- 头部的 `version` 是格式版本。读取方遇到更高的主版本就拒绝打开，遇到相同主版本下不认识的事件类型就忽略。
- 格式升级时提供迁移函数 `vN→vN+1`，按需在读取时惰性迁移，参考 DSH 的 `session-format-v*-to-v*` 包。

## 后果

- 回退和 compaction 都不删除历史，便于审计和恢复，代价是文件只增不减。归档时可以选择压缩。
- 会话列表和搜索改由 Host 的索引提供，Rust 不再解析会话文件。
- P6 的 Pi 导入器负责把 Pi 的树形会话转换成本格式。

## 备选方案

- **一个文件存整棵树、按 id/parentId 链接（Pi 的做法）**：派生规则要遍历整棵树，续传序号不好定义，否决。
- **直接存 SQLite**：可读性差，备份和 diff 也不方便，否决。SQLite 只用作索引。
