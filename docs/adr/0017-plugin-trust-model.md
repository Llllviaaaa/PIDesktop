# 0017 插件信任模型

- 状态：已接受（修订 [0016](0016-dynamic-plugins-and-hmr.md) 的清单字段与故障隔离表述）
- 日期：2026-11-12

## 背景

[ADR 0016](0016-dynamic-plugins-and-hmr.md) 的清单示例里有 `"permissions": ["tools", "ui"]`，读起来像是 Host 会按这项声明限制插件能用的服务。实际上 `packages/host/src/plugin-manifest.ts` 从来不解析这个字段，脚手架模板和 [`skills/qianji-plugin-development`](../../skills/qianji-plugin-development/SKILL.md) 也没有用到它。

另外，0016 中“Fiber 级故障隔离”“100% 隔离”之类的表述，容易让人以为插件之间、插件与 Host 之间存在运行时隔离。

这两处需要按真实的边界写清楚，免得插件作者和用户依赖一层并不存在的保护来判断风险。

## 决策

### 1. 启用的插件即完全信任

Host 插件与 Host 运行在同一个进程、同一个事件循环里。它们没有沙箱，不在 Worker 中运行，也没有能力白名单，所以 Host 能做的事插件都能做：

- 通过 `ctx` 取得任意服务（`inject`、`ctx.get(...)`），监听并改写 [0003](0003-plugin-model-and-events.md) 中的全部扩展点，包括 `llm/request` 和 `tools/pre-execute`；
- 直接使用 Node 和 Bun 的文件、网络、子进程 API；
- 以当前用户的身份读取 `<dataDir>/secrets.dat`，并调用 DPAPI 解密。[0013](0013-desktop-settings-and-secrets.md) 的 DPAPI 只能防住其他用户和离线拷贝，防不住同一用户下运行的代码。

客户端插件运行在主窗口的 WebView 里，与宿主页面同源。`@scope` 样式沙箱（0016 第 7 节）只约束 CSS，不约束脚本。

因此，信任以“插件来源”为单位，门禁只有两道：

1. 用户主动安装（`<dataDir>/plugins/`）或启用插件；
2. 工作区层的插件，要求工作区已登记在 `<dataDir>/trusted-workspaces.json` 中（0016 第 1 节）。

### 2. 清单中没有 `permissions` 字段

- `qianji` 清单字段（及旧名 `pid`）不包含 `permissions`。写了也会被忽略，不会带来任何限制。0016 中的示例以本文为准。
- 将来如果要限制插件能力，需要另写一条 ADR，并且要在加载路径上真正执行，例如把外部插件放进 Worker 或独立进程，而不能只停留在声明上。

### 3. 故障隔离的范围

能处理的情况：

- `apply()` 或热重载时抛出异常：插件标记为 `errored`，旧 Fiber 继续工作（0016 第 3 节）；
- 运行期未捕获的异常和 Promise 拒绝：按调用栈归因到具体插件，频繁出错时熔断（`packages/host/src/crash-guard.ts`）；
- 客户端插槽渲染时抛出异常：由 `<PluginSlot>` / `<SlotEntryHost>` 降级为错误卡片。

处理不了的情况：

- 同步死循环或长时间的同步计算：会阻塞整个 Host 的事件循环，所有会话的流式输出和 RPC 一起停住。Rust 侧只在 Host 进程退出时重启它（[0001](0001-harness-host-process.md)），不检测卡死，所以用户只能重启应用。卡顿结束后会在日志中留下记录（见“后果”），但不会被中止；
- 内存泄漏和资源耗尽；
- 插件代码本身有意的恶意行为。

## 后果

- 插件作者和用户都应按“装上就完全信任”来评估风险。插件管理界面和文档不应暗示存在权限隔离。
- 安装第三方插件的风险，与在本机安装一个程序相同。npm 渠道默认使用 `--ignore-scripts`，归档包会校验路径，但这些措施只保护安装过程，管不到插件运行时的代码。
- 卡顿可观测：Host 启动后会运行 `packages/host/src/stall-watch.ts` 中的一个计时器，每 500 ms 触发一次，测量它比预定时间晚了多少。晚 2 s 以上就算一次卡顿，在 Host 日志里记一条 `event loop blocked for <n>ms`，这条日志也会进入诊断包。
  - 计时器在事件循环被阻塞期间无法运行，所以只能在卡顿结束后上报；永远不结束的死循环不会被记录。
  - 超过 5 分钟的间隔按系统休眠处理，不上报。
  - 这里不用 `monitorEventLoopDelay`，因为不确定 Bun 编译出的可执行文件是否完整支持它；计时器方案在 Node 和 Bun 上行为一致。
- 以下加固可以单独评估，不在本文范围内：
  - 由 Rust 定期探测 Host 是否存活，长时间无响应就结束进程，交给现有的重启和按 seq 续订流程处理（会中断进行中的流式回复）；
  - 给插件的 `apply()` 和单次工具执行设置超时（只对异步挂起有效）；
  - 把外部插件放进 Worker 或独立进程，实现真正的隔离。代价是服务调用要变成跨线程消息，还需要重新设计共享模块桥。

## 备选方案

- **保留 `permissions` 作为“声明”，暂不执行**：一项不生效的声明会被当成保护，这比没有声明更糟。否决。
- **现在就按声明过滤 `ctx` 可见的服务**：插件与 Host 共享进程和模块单例，过滤只能拦住 `ctx.get`，拦不住 `node:fs`、`node:child_process` 和 DPAPI，挡不住真正的越权。否决，留待决定是否做 Worker 或进程级隔离时再议。
