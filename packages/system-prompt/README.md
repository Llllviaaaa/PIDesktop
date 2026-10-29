# @pid/system-prompt

系统提示词由多个片段组成，见 [ADR 0003](../../docs/adr/0003-plugin-model-and-events.md)。

| 键 | 类 | 说明 |
|---|---|---|
| `systemPrompt` | `SystemPrompt` | `section(id, render, { order })` 返回 disposer；`build(env)` 按 order 拼接，空片段跳过，出错的片段跳过并记录警告 |

`SectionOrder` 给出约定的位置：identity 0、guidelines 100、contextFiles 500、skills 600、environment 900。loop 在每次模型调用前都会重新 `build`。
