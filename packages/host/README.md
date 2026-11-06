# @pid/host

Harness Host 的 cordis 根，见 [ADR 0001](../../docs/adr/0001-harness-host-process.md) 和 [ADR 0003](../../docs/adr/0003-plugin-model-and-events.md)。

`createHost({ version, dataDir, plugins })` 会创建根 `Context`。`start()` 先装载内置服务，再按顺序装载插件；`stop()` 会释放根 fiber，所有插件的副作用随之回收。

## 服务

| 键 | 类 | 说明 |
|---|---|---|
| `hostInfo` | `HostInfo` | Host 版本、协议版本、数据目录、启动时间 |
| `webServer` | `WebServer` | 只监听本机回环地址的 HTTP 服务和路由表；校验页面 Origin 并处理 CORS |
| `rpc` | `RpcGateway` | `/rpc` 上的 JSON-RPC 2.0 网关（ADR 0002）：校验 token、处理 `initialize`、`host.info`、`host.ping`；插件通过 `ctx.rpc.method()` 注册方法，通过 `broadcast()` 推送通知 |

插件 `pid-workbench-rpc`（`src/workbench-rpc.ts`）提供 Agent `sidebar_open` 工具与 `workbench.open` RPC 方法，向统一前端广播 `workbench/open` 通知。

## 动态插件与分层覆盖

`PluginManager`（`src/plugin-manager.ts`，见 [ADR 0016](../../docs/adr/0016-dynamic-plugins-and-hmr.md)）统一管理三层插件来源（`workspace` > `user` > `builtin`）：

- 内置兜底层：由 `builtinFeatureDefinitions` 提供默认实现（拓扑依赖排序加载，逆序卸载），随安装包更新；
- 用户全局层：`<dataDir>/plugins/<dir>/` 与 `<dataDir>/plugins.json`（支持 `local` 目录关联/复制、`.tgz`/`.zip` 归档、`git` 仓库与内嵌 `BUN_BE_BUN=1` 的 `npm` 包安装；同 `id` 自动覆盖内置版本，移除后回退至内置版本）；
- 工作区项目层：`<workspace>/.pid/plugins/<dir>/`，受 `<dataDir>/trusted-workspaces.json` 显式信任门禁保护，并在独立子作用域 `WorkspacePluginScope` 中按工作区隔离挂载；
- 客户端脚本与静态资源：通过 `/plugins/<id>/client.js`、`plugin.clientBundle` 与 `/plugins/<id>/assets/*` 按内容哈希 `ETag` 分发，并支持 `watch` 模式下的 Fiber 级故障回滚热重载（`plugin/changed`）。

## 进程

`src/bin.ts` 是可执行文件的入口，`scripts/prepare-harness-host.mjs` 把它打包成 `src-tauri/resources/harness/pid-harness.exe`：

```text
pid-harness --data-dir <dir> [--port <n>] [--page-origin <origin>]... [--exit-with-stdin]
```

- token 从环境变量 `PID_HARNESS_TOKEN` 读取。没有设置时（例如为纯浏览器开发手动启动）会自动生成一个并打印到 stderr。
- 开始监听后，stdout 只输出一行 `{"port": n}`，日志全部写到 stderr。
- 浏览器开发时，用 `node scripts/prepare-harness-host.mjs --bundle-only` 打包，然后执行 `node node_modules/.cache/pidesktop-harness-host/host.mjs --data-dir <dir> --port 47100 --page-origin http://localhost:1420`。
