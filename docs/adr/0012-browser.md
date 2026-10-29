# 0012 能力迁移（四）：内置浏览器

- 状态：已接受
- 日期：2026-10-29

## 背景

这是 P4 的最后一批：迁移 `pidesktop-browser`，即通过 Chrome DevTools 协议（CDP）驱动 Edge、Chrome 或 Chromium 的浏览器工具。前三批见 0009、0010、0011。

## 决策

### 驱动代码复制，只改三处输入

`driver.ts` 是从 Pi 扩展里复制过来的 CDP 驱动：包括 `CdpClient`、`BrowserSession`、启动和关闭浏览器、页面快照、元素引用、按键映射等。

Pi 版有三个输入读的是环境变量：持久 profile 目录、浏览器可执行文件、工作区根目录。一个 Host 要服务位于不同目录的会话，所以这三个输入改为 `BrowserSession` 的构造选项和函数参数。除此之外只补了 `export`。P6 之前，两份代码要保持一致。

### 每个 agent 会话一个浏览器

- Pi 是一个任务一个进程，每个进程一个浏览器。Host 改为每个 agent 会话一个浏览器：
  - 首次使用时才启动；
  - 上传、下载限制在该会话的目录内；
  - 连续 10 分钟没有调用（`idleMinutes` 可配置）或 Host 停止时关闭。
- 这样一个会话的标签页、Cookie 和登录状态不会泄露到另一个会话，同时对话结束后也不会遗留 Chrome 进程。
- 配置了持久 profile（`profileDir`）时，同一时间只能有一个会话使用它，与 Pi 版的 profile 锁行为相同：第二个会话会得到“正在使用”的错误。

### 规则不变

- 交互类操作在只读会话中一律拒绝：点击、输入、按键、选择、上传，以及标签页的新建、切换、关闭。
- 交互类操作需要先通过 `ui.confirm` 确认，除非会话是完全访问，或配置关闭了 `confirmActions`。
- 导航同样需要确认。在只读会话中，导航本来就会被权限插件拦下。
- 页面内容一律视为不可信内容。
- 原来的状态栏提示改为 `{ type: "browser", url, title }` 实时增量。
- `/browser-diagnose` 命令要等 commands 服务出现后再加。

### 配置

`harness.json` 的 `browser` 段：`{ enabled, headless, confirmActions, profileDir, executable, idleMinutes }`。

## 后果

- P4 的全部能力至此都已迁成 Harness 插件。P5 会把前端切换到 Harness 引擎，并把 Rust 现在通过环境变量传给 Pi 的设置改为写入 `harness.json`。
- 同时打开多个会话并使用浏览器时，会有多个浏览器进程，比 Pi 版多占内存，空闲回收可以缓解。

## 备选方案

- **整个 Host 共用一个浏览器**：多个会话共用标签页和登录状态，一个会话的操作会干扰另一个，上传目录也没法限定到会话。否决。
- **会话一结束就关闭浏览器**：用户接着对话时，页面状态就丢了。否决，改为空闲一段时间后关闭。
