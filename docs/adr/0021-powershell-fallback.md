# 0021 Windows 上没有 Git Bash 时改用 PowerShell

- 状态：已接受
- 日期：2026-11-12

## 背景

`bash` 工具在 Windows 上依赖 Git Bash。没装 Git 的机器上，每次调用都只会返回 “No bash found”，agent 实际上没有可用的 shell。千机是 Windows 优先的桌面应用，这类用户不在少数。Pi（`powershell.ts`）和 DSH（`tool-pwsh`）都提供了 PowerShell 工具。

## 决策

- **另起工具名 `powershell`**，不沿用 `bash`：
  - 让模型从工具名就知道该写 PowerShell 语法；工具描述里也写明这台机器上没有 bash。
  - 只在 Windows 上、并且找不到 Git Bash 时注册，替代 `bash`。两个工具不会同时出现，免得模型挑错。
  - `Config.shell` 指向 `pwsh.exe` 或 `powershell.exe` 时，同样注册 `powershell`。
- **可执行文件**：优先使用 PATH 上的 `pwsh.exe`，其次是 `%ProgramFiles%\PowerShell\7\pwsh.exe`，最后是 Windows 自带的 `powershell.exe`（5.1）。
- **调用方式**：`-NoLogo -NoProfile -NonInteractive -EncodedCommand <UTF-16LE base64>`。
  - 用编码命令，是为了避开 Node 传命令行给 PowerShell 时的引号转义问题。
  - 脚本开头把 `[Console]::OutputEncoding` 设为 UTF-8。
  - 5.1 上，原生命令的 stderr 被重定向后会让 `$?` 变成 false，比如 `git push 2>&1` 明明成功了却被报成失败。脚本末尾的修正处理这种情况：最后一个错误只是这类记录、而原生命令本身退出码为 0 时，按成功退出。思路来自 Pi 的 PowerShell 工具。
- **执行路径与 `bash` 共用**：超时、进程树清理、Job Object、环境变量清理、自杀命令检查都一样。`timeoutMs: 0`，时限由工具自己的 `timeout` 参数控制（[0020](0020-tool-guards.md)）。
- **安全规则一并覆盖**：
  - 权限规则判断“是否为 shell 调用”时加入 `powershell`，因此在 `ask` 和 `workspace-write` 模式下，执行命令前同样需要确认；
  - 沙箱检查同样拦截 `powershell` 的命令。
  - 测试逐个模式核对 `powershell` 和 `bash` 的权限结论完全一致。
- 前端把 `powershell` 归入 shell 一类展示。

## 后果

- 没装 Git 的 Windows 机器上，agent 也能执行命令。
- 模型要写 PowerShell，部分模型对它不如对 bash 熟练。工具描述里给了几个常用写法作为提示。
- 用哪种 shell 在插件加载时决定。之后才装上 Git，需要重新加载插件才会换回 `bash`。
- 以后新增 shell 类工具，同样要加进权限规则里的 shell 判断；`bash` 和 `powershell` 的一致性测试就是为了守住这一点。

## 备选方案

- **仍叫 `bash`，背后改用 PowerShell 执行**：模型会照着工具名写 bash 语法，命令大量失败。否决。
- **两个工具都注册**：模型要多看一份工具定义，也可能在有 bash 的机器上选 PowerShell。否决。
- **通过 stdin 传入命令（`-Command -`）**：多行语句在交互模式下的解析与脚本不同。否决。
