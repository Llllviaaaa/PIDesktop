# @pid/session-jsonl

把会话日志存成 JSONL 文件：`<dir>/<YYYY-MM>/<sessionId>.jsonl`，第一行是头部，之后每行一条事件（[ADR 0004](../../docs/adr/0004-session-format.md)）。

- 追加是同步的，事件广播前已经写入。`flush` 时 fsync。
- 读取时跳过未知类型、序号不连续的行和崩溃时写了一半的最后一行，并记录警告。更高主版本的文件拒绝打开。

配置：`{ dir }`，Host 传入 `<dataDir>/sessions`。
