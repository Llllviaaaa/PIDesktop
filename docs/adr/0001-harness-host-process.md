# 0001 Harness Host 进程与托管

- 状态：已接受
- 日期：2026-10-28

## 背景

现在每个任务都会启动一个 `pi --mode rpc` 进程，子 agent、定时任务和模型服务也各自再起一个，better-sidebar 还单独跑一个 sidecar。前端发出的每条命令都要经过 Rust 中转成 JSONL。进程数量多，跨进程的状态需要逐一对齐，资源占用也随任务数线性增长。

## 决策

1. **一个 Harness Host 进程**承载全部会话。它用 Bun 编译成单文件 `pid-harness.exe`，随安装包放在 `resources/harness/`，构建方式与现有的 `prepare-sidebar-host.mjs` 相同：先用 esbuild 打包，再用 `bun build --compile` 编译。
2. **每个会话是一个 cordis 子作用域**。会话里注册的工具、提示词片段、监听器和子进程，都在会话释放时随 fiber 一起回收。子 agent 也是子作用域，由父会话持有。
3. **Rust 负责托管 Host**：
   - 启动参数为 `--data-dir <dir> --port 0 --page-origin <origin>... --exit-with-stdin`。
   - Host 开始监听后，在 stdout 打印一行 `{"port": n}`，之后 stdout 不再输出其他内容，日志一律写 stderr。
   - 鉴权 token 由 Rust 生成（32 字节随机数，base64url 编码），通过环境变量 `PID_HARNESS_TOKEN` 传给 Host，不放在命令行参数里，避免被进程列表看到。
   - 前端通过 Tauri 命令 `harness_endpoint` 获取 `{ baseUrl, token }`。
   - 托管期间 Rust 持有 Host 的 stdin。Rust 退出时 stdin 关闭，Host 随之退出，所以 Rust 崩溃也不会留下孤儿进程。
   - 崩溃重启策略为指数退避（0.5 s、1 s、2 s、4 s、8 s）。60 秒内崩溃满 5 次后停止重启，并通知前端显示错误。
4. **合并 better-sidebar sidecar**：P1 把 `sidecar/better-sidebar-host` 并入 Host，它注入的 `webServer`、`sessions`、`tools`、`webRuntime` 改由 Host 原生提供。
5. **Rust 保留的能力**：窗口与托盘、Host 托管、PTY 终端、Git、computer-use 原生助手、密钥存储（Windows DPAPI）。Host 需要密钥时，通过 Rust 暴露的本机接口按 provider 获取，不把密钥写进 Host 自己的配置文件。

## 后果

- 进程数从“1 + 任务数 + 子 agent 数”降到 2（Tauri 和 Host），子 agent、定时任务和 side chat 都变成进程内调用。
- 某个会话里的未捕获异常可能拖垮整个 Host。对策有三条：工具执行和 LLM 流都包在会话级的 try 与 AbortSignal 边界内；事件逐条落盘；Host 由 Rust 自动重启后，前端按 seq 重新订阅（见 0002）。
- 打包体积约等于一个 Bun 运行时，比现在的 Pi 运行时加 sidecar 两份运行时更小。

## 备选方案

- **每个会话一个 Host 进程**：隔离更强，但进程开销和跨进程同步的问题与现在一样，否决。
- **Node SEA**：需要另搭打包链路，体积更大，否决（决策 D5）。
- **在 Rust 里写 loop**：cordis 生态是 TypeScript，插件作者也以 TypeScript 为主，否决。
