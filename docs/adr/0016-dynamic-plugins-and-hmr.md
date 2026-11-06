# 0016 动态插件内核、分层覆盖与全栈热重载

- 状态：已接受
- 日期：2026-11-04

## 背景

在 [ADR 0003](0003-plugin-model-and-events.md) 和 [ADR 0013](0013-desktop-settings-and-secrets.md) 落地后，Host 的功能虽然全部写成了 Cordis 插件，但仍存在四个根本限制：

1. **安装包静态固化，升级即重置**：Host 侧的 11 个功能插件与 `better-sidebar` 由 `esbuild` 和 `bun build --compile` 静态编译进 `pid-harness.exe`，前端侧插件也由 Vite 构建期打包进 `dist/`。用户无法在不重编应用的前提下新增、定制或单独升级某个插件；即使手动改动安装目录资源，重新安装新版本安装包后也会被覆盖回默认状态。
2. **缺少用户态补丁层**：每次桌面端保存设置时，控制通道都会全量重写 `<dataDir>/harness.json`。若把用户的外部插件启停和配置直接塞进 `harness.json`，桌面端设置同步就会冲掉插件配置。
3. **缺少前后端动态模块共享桥**：`pid-harness.exe` 是 Bun 单文件可执行程序，外部插件不能各自携带一份 `@deepseek-ai/cordis` 或 `@pid/*`，否则会出现多份 Context / Service 实例导致依赖注入失效；前端也缺少动态脚本挂载与无刷新 Fiber 热替换通路。
4. **工作区安全边界未闭环**：[ADR 0003](0003-plugin-model-and-events.md) 明确要求“项目级插件和配置必须经过用户显式信任后才会加载”，但此前尚无信任清单与门禁实现。

借鉴 DeepSeek Harness（`dsh`）将“底座与用户 Profile 分离、补丁配置叠加、客户端模块按需分发与 Fiber 级 HMR”的设计思想，本 ADR 定义 PI-Desktop 的原生全栈动态插件体系及 `dsh.client` 轻量兼容层。

## 决策

### 1. 三级分层来源与“用户覆盖优先”

插件按优先级从低到高分为三层，合并后同一个插件 `id` 只激活最高优先级的一份实现：

1. **内置默认层（`builtin`）**：随安装包编译进 `pid-harness.exe` 和前端产物的默认插件，作为兜底（Fallback），保证开箱即用。
2. **用户全局层（`user`，位于 `<dataDir>/plugins/<dir>/`）**：用户通过本地目录、离线归档包（`.tgz` / `.zip`）、Git 仓库或 npm 安装的插件。**当外部插件声明的 `id` 与内置插件相同时，自动覆盖内置默认版本**；升级桌面端安装包只更新内置层，永不触碰 `<dataDir>/plugins/`。停用或移除该用户覆盖后，自动回退至内置默认插件。
3. **工作区项目层（`workspace`，位于 `<workspace>/.pid/plugins/<dir>/`）**：随代码仓库共享的项目专属插件。**仅当 `<workspace>` 规范化真实路径存在于 `<dataDir>/trusted-workspaces.json` 受信任列表时才参与发现与加载**；未受信任的工作区一律忽略其中的可执行插件与项目级配置，撤销信任时立即卸载对应插件。

用户的插件启停覆盖、安装来源元数据、`watch` 开关与自定义配置独立保存在 `<dataDir>/plugins.json` 中（类似 `dsh` 的 `cordis.patch.yml`），与 `desktop-settings.ts` 管理的 `harness.json` 完全解耦，互不覆盖。

### 2. 插件清单约定与 `dsh.client` 兼容层

外部插件目录以 `package.json` 作为清单文件，兼容以下三种声明形态：

- **PI-Desktop 原生字段 `pid`（推荐）**：
  ```json
  {
    "name": "@scope/my-plugin",
    "version": "0.1.0",
    "description": "示例全栈插件",
    "pid": {
      "id": "my-plugin",
      "name": "示例插件",
      "host": "./src/index.ts",
      "client": "./src/client.tsx",
      "assets": "./assets",
      "permissions": ["tools", "ui"]
    }
  }
  ```
- **标准 `exports` 映射**：`.`（或 `main` / `module`）识别为 Host 入口，`./client` 识别为前端入口。
- **DSH 社区插件兼容（方案 A）**：识别 `dsh.client`（或 `exports["./client"]`），使 `dsh-better-sidebar` 生态下的纯前端标签页与文件预览插件（如 Office/音视频预览、提交图等）无需修改构建脚本即可在 PI-Desktop 客户端加载；Host 端不强行模拟上游频繁变动的 `dsh-*` 私有后端服务。

插件可只包含 `host` 入口、只包含 `client` 入口，或同时包含前后端入口（全栈插件）。

### 3. Host 模块共享桥与故障熔断

- **宿主内存单例零拷贝共享**：Host 启动时注册模块解析桥（在编译后的 `pid-harness.exe` 中使用 `Bun.plugin` 的 `build.module(specifier, ...)`，在 Node 22+ 开发与测试环境中使用 `node:module` 的 `registerHooks`），将以下说明符直接映射到当前 Host 进程内存中的模块导出：
  - `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`
  - `@pid/protocol`、`@pid/llm`、`@pid/tools`、`@pid/session`、`@pid/agent`、`@pid/system-prompt`、`@pid/ui`
  外部插件无需自行安装这些依赖，也不会产生重复的 Cordis Context 实例；在 Bun 运行时下，本地插件可直接编写 `.ts` 源码免预编译加载。
- **Fiber 级故障隔离与热重载回滚**：
  - 每个插件运行在独立的 Cordis 子 Fiber 中。首次加载抛错时，捕获异常并将该插件状态标为 `errored`（记录错误详情并下发通知），绝不阻断 Host 启动或其他插件运行。
  - 开启 `watch`（本地开发模式默认开启）或调用 `plugin.reload` 时，Host 使用带修订戳查询参数的动态 `import()` 重新装载模块：若新版本 `import()` 或 `apply()` 失败，保留旧 Fiber 继续工作并上报错误；成功后才替换旧 Fiber，正在进行的会话流式回复不受影响。

### 4. 客户端动态脚本分发、CSP 边界与无刷新 HMR

- **Host 打包与静态路由**：`WebServer` 提供两条同源/CORS 受控路由：
  - `GET /plugins/<encodeURIComponent(id)>/client.js`：输出包装为 `window.__ModuleLoader__.load({ id, factory: (require) => { ... } })` 的浏览器闭包脚本，带内容哈希 `ETag`、`Cache-Control: no-cache` 与 `If-None-Match` -> `304 Not Modified` 协商缓存。
    - 若插件产物已包含 `__ModuleLoader__.load(`（如社区预编译 DSH 插件），直接透传；
    - 若插件产物为裸 CommonJS 脚本，由 Host 自动包裹 `module` / `exports` 闭包；
    - 若插件入口为 `.ts` / `.tsx` / `.jsx` / ESM 源码，由 Host 即时打包转译（Bun 下调用内置 `Bun.build`，Node 测试下调用 `esbuild`）并将平台共享依赖保留为外部 `require` 调用。
  - `GET /plugins/<encodeURIComponent(id)>/assets/*`：按插件声明的静态目录（默认 `assets/`）安全提供图片、样式或 WASM 资源，严格校验真实路径防止目录穿越。
- **WebView CSP 安全加载**：桌面端主窗口 **不在** `script-src` 中放开任意 `http://127.0.0.1:*` 端口，以免本机其他未鉴权服务注入脚本；前端仅向已知且受信任的 Host 地址请求客户端脚本（或经鉴权 RPC 获取），校验后通过同源 `blob:` URL（附 `//# sourceURL=` 保留调试堆栈）注入 `<script>` 并立即释放对象 URL，`script-src` 仅需允许 `'self' blob: 'wasm-unsafe-eval'`。
- **前端 `ctx.modules` 与 Fiber 热替换**：前端 `dsh-host` 在根 Context 上暴露 `window.__ModuleLoader__` 与 `ctx.modules`（包含 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`cordis`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`dsh-better-sidebar/client`、`@pid/protocol`）。收到 `plugin/changed` 通知后，仅卸载变动插件的客户端 Fiber 并按最新 `ETag` 重挂载，不刷新页面、不中断集成终端与当前会话。

### 5. 多渠道安装与内嵌 Bun 包管理

Host 内置统一的插件安装与更新器，覆盖四种渠道：

1. **`local`**：关联本地开发目录（默认开启 `watch` 实时热重载），或复制到 `<dataDir>/plugins/`；
2. **`archive`**：解压本地 `.tgz` / `.tar.gz` / `.zip` 包，解压前逐条校验归档路径，拒绝任何 `..` 越界或绝对路径（防 Zip Slip）；
3. **`git`**：调用本机 `git` 克隆或快进更新 Git 仓库（支持 `https://`、`git+https://`、`github:owner/repo#ref`）；
4. **`npm`**：复用 `pid-harness.exe` 内嵌的 Bun 运行时（设置环境变量 `BUN_BE_BUN=1` 调用自身执行 `install --ignore-scripts`），无需用户机器预装 Node.js 或 npm，默认禁用生命周期脚本以防供应链投毒。

### 6. 协议扩展（`@pid/protocol`）

保持主协议版本 `1.x` 向后兼容，补齐并扩展 [ADR 0002](0002-client-protocol.md) 预留的 `plugin` 域与工作区信任方法：

- 请求方法：`plugin.list`、`plugin.enable`、`plugin.disable`、`plugin.configure`、`plugin.reload`、`plugin.install`、`plugin.update`、`plugin.remove`、`plugin.clientBundle`、`workspace.trust.list`、`workspace.trust.set`。
- 服务端通知：`plugin/changed`（携带最新插件摘要列表或变更项）、`workspace/trustChanged`。

## 后果

- 应用安装包升级与用户插件生态彻底解耦：内置插件负责稳定底座，`<dataDir>/plugins/` 与 `<dataDir>/plugins.json` 承载用户的个性化定制、覆盖与第三方扩展。
- 本地全栈插件开发实现“零配置免构建热更新”：保存 `.ts` / `.tsx` 后百毫秒内完成 Host 工具/钩子与前端侧边栏 UI 的局部热替换。
- 既能直接复用 `dsh-better-sidebar` 社区的前端预览/标签页插件，又保持了 PI-Desktop Host 自身小巧稳定的公开扩展词汇表。

## 备选方案

- **在 Host 端完整模拟 DSH 的全部后端服务（方案 B）**：上游 `@deepseek-ai/dsh-*` 仍处于快速演进阶段，私有服务接口频繁变更，强行全量模拟会导致极高的维护负担与脆弱性。否决，仅对稳定的客户端 UI 与 `betterSidebar` 扩展点提供兼容层。
- **要求用户在系统全局安装 Node.js / npm 才能安装插件**：破坏桌面应用开箱即用的体验；既然 `pid-harness.exe` 已经内嵌 Bun，通过 `BUN_BE_BUN=1` 复用其包管理器无需增加任何安装包体积。否决外部工具强依赖。
- **在 Tauri CSP `script-src` 中直接放开 `http://127.0.0.1:*`**：会让本机任意本地端口具备脚本源资格，削弱 WebView 隔离边界。改为仅从受控 Host 获取脚本并通过同源 `blob:` 执行。
