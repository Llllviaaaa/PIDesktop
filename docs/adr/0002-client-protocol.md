# 0002 前端与 Host 的协议

- 状态：已接受
- 日期：2026-10-28

## 背景

前端现在直接消费 Pi 的 JSONL 事件，并用 `piMessages`、`piToolCalls`、`piProtocol`、`piRpcRouter` 等适配层做翻译。这样一来，Pi 每改一次协议，前端都得跟着改；而前端刷新或运行时重启后能否续上，也取决于 Pi 支不支持。

## 决策

### 传输

- 使用 **WebSocket**，地址为 `ws://127.0.0.1:<port>/rpc`，消息采用 **JSON-RPC 2.0**，每帧一条 UTF-8 文本消息，不做批量。
- 浏览器的 WebSocket 不能自定义请求头，所以鉴权借用子协议字段：`Sec-WebSocket-Protocol: pid.v1, pid.token.<token>`。服务端校验 token 后，只回显 `pid.v1`。Origin 必须属于 `--page-origin` 列表，否则直接拒绝。
- 连接建立后，客户端第一条请求必须是 `initialize`，参数为 `{ protocolVersion, client: { name, version } }`。服务端返回 `{ protocolVersion, host: { version }, capabilities }`。在此之前收到的其他请求一律返回 `NotInitialized`。

### 版本

- 协议版本号格式为 `主.次`，当前是 `1.0`。增加方法、可选字段或事件类型时只升次版本，客户端必须忽略不认识的字段和事件类型。删除或改变已有语义时升主版本，主版本不一致的连接在 `initialize` 阶段就会被拒绝。
- 协议的类型和运行时校验都定义在 `@pid/protocol` 中，前端和 Host 共用这一个包，作为唯一来源。

### 方法命名

方法名采用 `<域>.<动作>` 格式。v1 规划如下，具体签名在各阶段落地时补进 `@pid/protocol`：

| 域 | 方法 |
|---|---|
| `host` | `initialize`, `host.info`, `host.ping` |
| `session` | `session.create`, `session.resume`, `session.list`, `session.get`, `session.subscribe`, `session.unsubscribe`, `session.prompt`, `session.steer`, `session.followUp`, `session.abort`, `session.fork`, `session.rewind`, `session.compact`, `session.rename`, `session.archive`, `session.delete`, `session.export` |
| `model` | `model.list`, `model.set`, `model.setEffort`, `provider.list`, `provider.save`, `provider.delete`, `provider.discover`, `provider.check` |
| `ui` | `ui.respond`（回应 Host 发起的确认、选择、输入请求） |
| `plugin` | `plugin.list`, `plugin.enable`, `plugin.disable`, `plugin.configure` |
| `command` | `command.list`, `command.run` |

### 事件推送与断线续传

- Host 通过通知 `session/event` 推送 `{ sessionId, seq, event }`。`seq` 是会话内单调递增的序号，与持久化事件的序号相同（见 0004）。流式增量（`*.delta`）不落盘，使用独立的序号空间 `{ sessionId, liveSeq, delta }`，通知名为 `session/delta`。
- 客户端调用 `session.subscribe { sessionId, afterSeq }` 订阅会话。Host 先补发 `afterSeq` 之后的持久化事件，再附上当前正在生成的消息快照，然后转入实时推送。前端刷新、断线重连和 Host 重启之后，都用这一个方法续上。
- Host 主动发起的交互请求用通知 `ui/request` 下发 `{ requestId, sessionId?, kind, ... }`，`kind` 取值为 `confirm`、`select`、`input`、`editor`、`notify`。客户端用 `ui.respond` 回应。如果交互请求还没得到回应时连接就断了，重连订阅后 Host 会重新下发。

### 错误码

JSON-RPC 的标准错误码保持原义。自定义错误码如下：

| 码 | 名称 | 含义 |
|---|---|---|
| -32001 | `NotInitialized` | 还没有完成 `initialize` |
| -32002 | `UnsupportedVersion` | 协议主版本不一致 |
| -32010 | `SessionNotFound` | 会话不存在 |
| -32011 | `SessionBusy` | 会话正在运行，不能执行该操作 |
| -32020 | `PermissionDenied` | 被权限策略拒绝 |
| -32030 | `ProviderError` | 模型服务返回错误，`data` 中带厂商原始信息 |
| -32099 | `Aborted` | 请求被取消 |

## 后果

- 前端可以删掉 Pi 适配层，只依赖 `@pid/protocol`。
- 连接由前端直接发起，不再经 Rust 中转，少一次序列化。
- 因为前端到 Host 是跨源请求，CORS 和 Origin 校验必须在 Host 端做好，可以沿用 sidecar `web-server.ts` 里已经做过的同源判断。

## 备选方案

- **继续经 Tauri invoke 中转**：多一跳，Rust 还要理解每条消息才能做鉴权，否决。
- **HTTP + SSE**：上行和下行要分成两个通道，交互请求的往返也更别扭，否决。
- **把 token 放在 URL 查询参数里**：容易被日志记录下来，否决。
