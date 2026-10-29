# @pid/prompt-context

内置的系统提示词片段：

- 身份和行为准则；
- 上下文文件：先是 `<dataDir>/AGENTS.md`，然后从根目录一路到 cwd，每层目录取 `AGENTS.md`，没有时取 `CLAUDE.md`；
- skills：`<dataDir>/skills`、`<cwd>/.pid/skills`、`<cwd>/.agents/skills` 下的 `*/SKILL.md`，只列出名称、描述和路径，由模型按需用 `read` 读取。同名时靠后的目录生效。没有 `read` 工具时不列出；
- 环境信息：cwd、平台、日期。

配置：`{ dataDir }`。
