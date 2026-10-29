# @pid/tool-bash

`bash` 工具：在会话的 cwd 中执行命令，返回合并后的 stdout 和 stderr（只保留最后 2000 行或 50 KB）。

- Windows 上使用 Git Bash，不会选中 WSL 的 `System32\bash.exe`。其他平台使用 `/bin/bash`。
- 超时（默认 120 秒，上限由 `maxTimeoutSeconds` 控制，默认 600 秒）或运行中止时，会结束整个进程树。

配置：`{ shell?, maxTimeoutSeconds? }`。
