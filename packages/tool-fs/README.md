# @pid/tool-fs

内置文件工具：`read`、`write`、`edit`、`ls`、`find`、`grep`。

- 路径相对于会话的 cwd 解析，`~` 指用户主目录。
- 输出有上限（2000 行或 50 KB），超出时提示如何继续读取。
- `edit` 只做精确替换，每段 `oldText` 必须在文件中唯一出现；多处修改要么全部生效，要么都不生效。CRLF 文件保持 CRLF。
- `find`、`grep` 跳过 `.git` 和 `node_modules`，`grep` 跳过二进制文件和 2 MB 以上的文件。

本包不做权限检查，权限由 `tools/pre-execute` 上的插件负责（P4）。
