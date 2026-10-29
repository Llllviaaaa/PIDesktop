# @pid/testkit

harness 各包的测试工具：

- `ScriptedProvider`：按脚本逐次回复的 LLM 适配器，并记录每次请求。`textReply`、`toolReply`、`errorReply` 用来写回复。
- `useScriptedProvider(ctx, provider)`：注册到 `llm` 服务。
- `goldenLog(session)`：去掉时间戳的 JSONL，用于黄金文件。
