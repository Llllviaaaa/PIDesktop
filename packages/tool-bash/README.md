# @qianji/tool-bash

shell 工具：在会话的 cwd 中执行命令，返回合并后的 stdout 和 stderr（只保留最后 2000 行或 50 KB）。

- 工具名是 `bash`。Windows 上使用 Git Bash，不会选中 WSL 的 `System32\bash.exe`；其他平台使用 `/bin/bash`。
- Windows 上找不到 Git Bash 时，改为注册 `powershell` 工具（[ADR 0021](../../docs/adr/0021-powershell-fallback.md)）：
  - 有 PowerShell 7（`pwsh.exe`）就用它，否则用 Windows 自带的 PowerShell 5.1。
  - 命令以 `-EncodedCommand` 传入，不受引号转义影响；脚本前加一行，让 PowerShell 用 UTF-8 输出。
  - 5.1 上，原生命令的 stderr 被重定向后会被当成失败；末尾追加的退出码修正会把这种情况按成功处理。
  - 工具描述会告诉模型这台机器上没有 bash，要用 PowerShell 语法。
  - 两种 shell 共用同一套实现：超时、Job Object、环境变量清理和自杀命令检查都一样。权限规则和沙箱检查也把 `powershell` 当作 shell。
- 用哪种 shell 在插件加载时决定。之后才装上 Git Bash 的话，要重新加载插件才会换回 `bash`。
- 超时（默认 120 秒，上限由 `maxTimeoutSeconds` 控制，默认 600 秒）或运行中止时，会结束整个进程树。

配置：`{ shell?, maxTimeoutSeconds?, sandbox? }`。`shell` 指向 `pwsh.exe` 或 `powershell.exe` 时，同样注册 `powershell` 工具。
