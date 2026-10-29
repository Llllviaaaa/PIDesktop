# 0013 桌面端设置、密钥与热重载

- 状态：已接受
- 日期：2026-10-29

## 背景

P5 要把桌面端切换到 Harness 引擎（见 [V2 重构方案](../REFACTOR_V2_PLAN.md) 的 P5 一行，以及 P5 细化方案 `docs/REFACTOR_V2_P5.md`）。这一步需要满足三件事：

- 桌面端的设置能传到 Host 并生效；
- Host 能用上 DPAPI 加密保存的 key；
- 改设置时不必重启 Host。

P5 方案已经确认了以下几点：

- **P5-1**：由 Host 自己解密密钥；
- **P5-2**：设置热重载；
- **数据目录**：改用 `~/.pid`（决策 D4）。

本 ADR 记录具体做法，其中一处改动了 P5 方案原来的设计。

## 决策

### 设置怎么从桌面端传到 Host

- **控制通道就是 Host 的 stdin。** stdin 只由桌面端持有，Host 本来就靠它检测桌面端是否退出。现在桌面端在里面每行写一个 JSON 命令：
  - `{"desktop": {...}}`：Host 启动后立即发一次，之后每次 `set_settings` 都再发一次，内容是：
    - 公开设置：`without_mcp_secrets`，不含 MCP 密钥；
    - 桌面端配置目录：`memory.md`、`mcp-secrets.dat`、`browser-profile` 都在这里；
    - Pi 的 agent 目录：用于导入 `models.json`；
    - 桌面端可执行文件：它同时是 computer use 的 helper。
  - `{"reload": true}`：按磁盘上的文件重新加载。RPC 方法 `config.reload` 的作用相同。
- **设置到 `harness.json` 的映射放在 Host 里**，用 TypeScript 实现（`desktop-settings.ts`），而不是 P5 方案里写的 Rust `harness_config()`。这样字段映射可以在本地逐字段测试，而 Rust 的改动只在 CI 上才能编译验证。Rust 只负责发送上面这行消息。映射规则与 `pi/launch.rs` 给 Pi 设置环境变量的方式一一对应：
  - Pi 的记忆开关同时关闭上下文文件（`--no-context-files`），因此新增 `contextFiles` 段；
  - personality 和自定义说明合并为 `prompt.instructions`，作为一个系统提示词片段；
  - 记忆文件仍然用桌面端的 `memory.md`；
  - Pi 的 thinking 等级映射为 effort：`minimal` 视为 `low`，`xhigh` 视为 `high`。
- Host 收到设置后，把结果写入 `harness.json` 并重新加载。这样 headless 运行和 Host 重启都会沿用桌面端最后一次发来的设置。

### 密钥

- **格式与 Rust 的 `secret_store` 相同**：对 JSON 字节调用 `CryptProtectData`，不加额外熵。Host 通过 Bun FFI 调用 `crypt32` 的加密和解密函数（`secrets.ts`），密钥不经过环境变量，也不会传给子进程。
- **两个密钥文件**：
  - `<dataDir>/secrets.dat` 属于 Host，`providers.json` 里的 `{ secret: id }` 引用的就是它。它注册为 `credentials` 的密钥存储，每次查找都重新读取文件，因此修改后立即生效。
  - 桌面端的 `mcp-secrets.dat` 由 Host 直接读取解密，在内存中合并进 MCP 服务器的 `env` 和 `headers`，不写入 `harness.json`，也不经过 stdin。
- **非 Windows 平台和 Node 测试环境**：没有 DPAPI，因此不注册密钥存储。导入时遇到明文 key 只能丢弃（只保留 provider 本身），并记录提示，绝不会把 key 明文写进文件。

### `models.json` 一次性导入

- `providers.json` 不存在时，从 Pi 的 `models.json` 导入一次（`pi-import.ts`）：
  - `openai-completions` 映射为 `openai-compat`，`anthropic-messages` 映射为 `anthropic`；
  - 明文 key 移入 `secrets.dat`，引用为 `provider/<id>`；
  - 单纯的 `$VAR` 或 `${VAR}` 写法转换为 `{ env }`。
- 无法转换的条目不靠猜测处理，只记入日志：
  - 其他 API（Google、Bedrock 等）；
  - `!命令` 形式的 key，因为 Host 不执行命令；
  - 不合法的 id。
- 之后每次收到设置，只把桌面端选定的 provider 和 model 写入 `defaultModel`。

### 热重载

- **两部分插件**：
  - 核心插件（会话、工具、loop 等）只在启动时加载一次；
  - 功能插件按 key 交给 `ReloadablePlugins` 管理（`reloadable.ts`）：providers、permissions、prompt-context、plan、memory、subagents、mcp、computer、browser、hooks、schedule。
- **只重载有变化的插件**：每次重新加载时比较各插件的配置，只卸载并重新加载配置变了的那些。配置没变的插件不受影响，例如 MCP 连接和已经打开的浏览器。不再需要的插件会被卸载。正在运行的会话不受影响，被重载的插件只是替换了它注册的工具和监听器。
- **如何检测 `providers.json` 的改动**：把文件内容本身作为 providers 插件配置的一部分，文件一改，比较时就会判定为有变化。
- **默认模型改为读取函数**：`session.create` 和定时任务每次需要时都重新读取默认模型，所以修改默认模型不会导致这两个插件被重载，也就不会打断正在执行的定时任务。
- **权限检查的顺序**：权限插件以 prepend 方式注册 `tools/pre-execute` 监听器，即使被重载后排到最后加载，仍然先于 hooks 做出决定。

### 数据目录

- Rust 改为把 `~/.pid` 传给 Host（决策 D4），取代 Tauri 的 `app_data_dir`。
- better-sidebar 的设置文件在 Host 第一次启动时从原位置复制一份过来。

## 后果

- 设置映射只有一份实现，是 TypeScript 的纯函数，测试逐字段覆盖。Rust 的改动很小：确定数据目录、发送一行消息、迁移一个文件。
- 编译后的 exe 冒烟测试验证了两件事：
  - 用 PowerShell `ProtectedData` 写入的 DPAPI 密钥文件，Host 能自己解密，并带着这个 key 访问 provider；
  - 通过 stdin 发送的设置，不重启 Host 就能生效。
- `engine=pi` 时 Host 同样会收到设置，但前端不使用它，没有副作用。P5b 起，前端在 `engine=harness` 时使用这些设置。

## 备选方案

- **用 Rust 实现 `harness_config()`（P5 方案原来的设计）**：映射有几十个字段，在 Rust 里写和测试的成本高，而且 Rust 改动在本地无法编译验证。否决。
- **由 Rust 解密密钥后，通过 stdin 交给 Host**：每次修改 key 都要重新发送，而且 key 会长期留在 Host 的内存里。这正是 P5-1 否决的方案。否决。
- **每次修改设置都重启 Host**：会打断正在运行的任务。这正是 P5-2 否决的方案。否决。
