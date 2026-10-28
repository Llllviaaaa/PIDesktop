# @pid/protocol

前端与 Harness Host 之间的协议，按 [ADR 0002](../../docs/adr/0002-client-protocol.md) 实现。前端（`src/`）和 Host 都依赖这个包，它是协议定义的唯一来源。

目前包含：

- `PROTOCOL_VERSION`、`isCompatibleProtocol`：`主.次` 版本号与兼容判断。
- `decodeMessage`、`success`、`failure`、`ErrorCode`：JSON-RPC 2.0 帧的解码与构造，只校验信封；各方法参数的校验放在对应的处理器里。
- `clientSubprotocols`、`readOfferedSubprotocols`：借用 `Sec-WebSocket-Protocol` 携带 token 的握手方式。
- `InitializeParams`、`InitializeResult`。

各个方法的参数和结果类型随 P1 及之后的阶段逐步补充。
