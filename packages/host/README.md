# @pid/host

Harness Host 的 cordis 根，见 [ADR 0001](../../docs/adr/0001-harness-host-process.md) 和 [ADR 0003](../../docs/adr/0003-plugin-model-and-events.md)。

`createHost({ version, dataDir, plugins })` 会创建根 `Context`。`start()` 先装载内置服务，再按顺序装载插件；`stop()` 会释放根 fiber，所有插件的副作用随之回收。

## 服务

| 键 | 类 | 说明 |
|---|---|---|
| `hostInfo` | `HostInfo` | Host 版本、协议版本、数据目录、启动时间 |
| `webServer` | `WebServer` | 只监听本机回环地址的 HTTP 服务和路由表；校验页面 Origin 并处理 CORS |
| `rpc` | `RpcGateway` | `/rpc` 上的 JSON-RPC 2.0 网关（ADR 0002）：校验 token、处理 `initialize`、`host.info`、`host.ping`；插件通过 `ctx.rpc.method()` 注册方法，通过 `broadcast()` 推送通知 |

插件 `pid-better-sidebar`（`src/better-sidebar/`）负责加载 better-sidebar 的宿主端，见 [ADR 0006](../../docs/adr/0006-better-sidebar-in-host.md)。

## 进程

`src/bin.ts` 是可执行文件的入口，`scripts/prepare-harness-host.mjs` 把它打包成 `src-tauri/resources/harness/pid-harness.exe`：

```text
pid-harness --data-dir <dir> [--port <n>] [--page-origin <origin>]... [--exit-with-stdin]
```

- token 从环境变量 `PID_HARNESS_TOKEN` 读取。没有设置时（例如为纯浏览器开发手动启动）会自动生成一个并打印到 stderr。
- 开始监听后，stdout 只输出一行 `{"port": n}`，日志全部写到 stderr。
- 浏览器开发时，用 `node scripts/prepare-harness-host.mjs --bundle-only` 打包，然后执行 `node node_modules/.cache/pidesktop-harness-host/host.mjs --data-dir <dir> --port 47100 --page-origin http://localhost:1420`。
