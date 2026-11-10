# 千机（Qianji）本地能力边界

这份清单是后续开发的范围基线。目标是用本地的 Harness Host 打造融合 Agent 工作台、自主 Bot 与 IDE 的全能本地创造环境。所有“已完成”项都必须从界面连接到真实本机后端。

## 必须具备的本地能力

| 能力域 | 当前状态 | 产品要求 |
| --- | --- | --- |
| 多任务 Agent | 已完成 | 一个 Harness Host 同时承载所有任务的会话；后台继续流式执行；切换任务不丢状态 |
| 动态插件系统 | 已完成 | `~/.qianji/plugins` 与 `plugins.json` 独立于安装包持久化；支持本地目录/归档/Git/npm 安装更新、文件监听热重载（HMR）、前端动态 UI 加载与工作区插件信任门禁 |
| 会话与上下文 | 已完成 | 本地历史、`~/.qianji/index.sqlite` FTS5 全文搜索、`/` 快捷斜杠指令菜单、重命名、归档、恢复、删除、clone、fork、tree、compact、export |
| 模型与提供商 | 已完成 | 原生支持 Anthropic、OpenAI Chat、OpenAI Responses（`/v1/responses`）与 Google Gemini（`streamGenerateContent`）；会话内切换模型与思考等级并下发到 runtime |
| 成本与可观测性 | 已完成 | 采集 `reasoningTokens`，基于 `@qianji/pricing` 本地单价表估算会话与累计成本（支持自定义覆盖），日志与错误可见 |
| 工作区与 Worktree | 已完成 | 本地或 worktree 新任务、创建/打开 worktree、工作区信任门禁、资源管理器与外部编辑器打开 |
| 权限与轻量沙箱 | 已完成 | `read-only`/`ask`/`workspace-write`/`full-access` 审批策略；实验性 Windows 轻量沙箱（环境变量脱敏、`.qianji/sandbox-tmp` 重定向、Windows Job Object 进程数限制与高危系统命令拦截）及 `.wsb` / Dev Container 外部强隔离配置导出 |
| 本地长期记忆与技能 | 已完成 | 双层 Memory 2.0（`~/.qianji/memory.md` 全局 + `<repo>/.qianji/memory.md` 项目独立开关、双标签编辑、Agent 写入统一 Diff 审批）；应用内技能中心（新建/编辑/启停/删除并实时同步 `/skill:<name>`） |
| Git Review 与 PR 闭环 | 已完成 | index/worktree 状态、hunk 级 stage/revert、二进制/纯重命名/超大 diff 专门状态卡片；基于本机 `gh` 的桌面端 PR 创建（AI 生成标题与正文，遵守 `pullRequestInstructions`）及 PR 审查评论/CI 失败一键回灌对话修复 |
| 本地终端 | 已完成 | 真实 PTY、多 tab、自定义 Shell 启动参数（`terminalShellArgs`）、退出码徽章、选区或最近输出一键发送到对话，默认不自动污染模型上下文 |
| 本地定时任务 | 已完成 | 创建、暂停、立即运行、安全权限快照、运行记录、结果会话；仅 App 与电脑运行时触发 |
| Browser / Computer | 已完成 | `browser_*` / `computer_*` 本机扩展；页面/桌面截图与状态可见；控制会话与交互动作受审批控制 |
| MCP | 已完成 | STDIO/HTTP、动态工具与 `list_changed` 热刷新、指数退避与手动一键重连、Resources/Prompts 浏览面板、DPAPI 凭据保护与审批 |

## 持续演进方向

按真实工程需求按需迭代：

1. **插件生态模板与脚手架**：沉淀更多全栈插件示例（自定义侧栏面板 + Host 工具 + 斜杠命令）。
2. **终端进阶交互**：按需评估终端内搜索高亮与多分屏布局，继续保持终端输出不自动塞入模型上下文。
3. **跨平台强隔离向导**：在现有 Windows Sandbox（`.wsb`）与 Dev Container 模板基础上，按需补充容器自动检测与一键拉起体验。

## 明确不做

- 云端执行环境、远程 worker、云任务队列
- OpenAI/ChatGPT 账号、套餐、计费、组织 RBAC 和企业策略
- 跨设备云同步与 handoff
- 自建插件审核/托管平台；只管理本机的插件、技能和外观资源
- 把纯权限审批或进程级轻量沙箱夸大宣称为内核级/Hyper-V 级完整 OS 虚拟化沙箱（强隔离请使用导出的 `.wsb` 或 Dev Container）
- 只有外观、没有真实本机能力的页面空壳

## 验收原则

- 数据与运行记录可指出明确本机路径。
- 断网时已有会话、Git、终端和本地 provider 仍可工作或给出诚实错误。
- Browser、Computer、MCP、轻量沙箱等能力关闭后，核心对话仍可用。
- 新功能必须有真实后端、失败状态和最小针对性测试，才能标记已完成。
