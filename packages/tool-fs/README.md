# @qianji/tool-fs

内置文件工具：`read`、`write`、`edit`、`ls`、`find`、`grep`。

- 路径相对于会话的 cwd 解析，`~` 指用户主目录。
- 输出有上限（2000 行或 50 KB），超出时提示如何继续读取。
- `edit` 先按原文精确查找，每段 `oldText` 必须在文件中唯一出现；多处修改要么全部生效，要么都不生效。CRLF 文件保持 CRLF。
- 精确查找失败时，`edit` 会再用宽松规则查一次（`tolerantPattern`）：弯引号和直引号、各种 Unicode 破折号和空格、行尾空白、CRLF 与 LF 之间的差异都不计较，缩进和其他字符仍须一致。宽松匹配同样要求唯一。用上宽松匹配时，结果里会注明是哪几段，文件的其余部分保持原样。
- `find`、`grep` 跳过 `.git` 和 `node_modules`，`grep` 跳过二进制文件和 2 MB 以上的文件。

本包不做权限检查，权限由 `tools/pre-execute` 上的插件负责（P4）。
