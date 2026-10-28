# @pid/host

Harness Host 的 cordis 根，见 [ADR 0001](../../docs/adr/0001-harness-host-process.md) 和 [ADR 0003](../../docs/adr/0003-plugin-model-and-events.md)。

`createHost({ version, dataDir, plugins })` 会创建根 `Context`。`start()` 先装载内置服务，再按顺序装载插件；`stop()` 会释放根 fiber，所有插件的副作用随之回收。

## 服务

| 键 | 类 | 说明 |
|---|---|---|
| `hostInfo` | `HostInfo` | Host 版本、协议版本、数据目录、启动时间 |

进程入口（参数解析、WebSocket 网关、stdout 端口握手）和 better-sidebar 的并入在 P1 实现。
