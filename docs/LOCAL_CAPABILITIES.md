# Pi Desktop 本地能力边界

这份清单是后续开发的范围基线。目标不是复制 Codex 的云平台，而是用 Pi runtime 做出同等级的本地编码 Agent 工作流。所有“已完成”项都必须从界面连接到真实本机后端。

## 必须具备的本地能力

| 能力域 | 当前状态 | 产品要求 |
| --- | --- | --- |
| 多任务 Agent | 已完成 | 每个任务独立 Pi RPC runtime；后台继续流式执行；切换任务不丢状态 |
| 会话与上下文 | 已完成 | 本地历史、搜索、重命名、归档、恢复、删除、clone、fork、tree、compact、export |
| 模型与提供商 | 已完成 | 本地配置 provider/model；会话内切换模型与思考等级并真正下发到 runtime |
| 工作区与 Worktree | 已完成 | 本地或 worktree 新任务、创建/打开 worktree、工作区信任、资源管理器打开 |
| 权限与审批 | 已完成（非沙箱） | read-only/ask/workspace-write/full-access；规则持久化；写越界和危险操作审批 |
| Git Review | 已完成 | index/worktree 状态、diff、file stage/unstage/revert、行评回灌当前会话 |
| 本地终端 | 已完成 | 真实 PTY、多 tab、流式输出、进程状态、关闭、新建、可不进入模型上下文 |
| 本地定时任务 | 已完成 | 创建、暂停、立即运行、安全权限快照、SQLite 历史、结果会话；仅 App 与电脑运行时触发 |
| Pi 资源中心 | 核心已完成 | 首页发现扩展/技能/提示词/主题/包；npm、Git、本地源安装、更新、移除；新任务加载 |
| Browser / Computer | 已完成 | 可关闭的本机扩展；页面/桌面截图与状态进 Inspector；交互动作受审批控制 |
| MCP | 本地核心已完成 | STDIO/HTTP、动态工具、资源 list/read、提示词 list/get、状态诊断、凭据保护与审批 |
| 设置与可观测性 | 已完成 | 本地设置、通知、wake lock、token/cost、工具状态、日志与错误可见 |

## 下一批仍要做的本地增强

按价值与依赖排序：

1. **资源启停与过滤 UI**：把 Pi `config` 里的 package/resource filters 做成非交互桌面控制，并准确展示继承、禁用和项目覆盖状态。
2. **本地 Memory 2.0**：用户与项目 Markdown 编辑、选择性注入、导出和删除；继续使用 Pi context files，不创建云画像。
3. **MCP 动态刷新**：处理 tools/resources/prompts 的 list-changed 通知、资源订阅与重连；OAuth 平台不是主线。
4. **终端增强**：搜索、复制全部、清屏、shell profile、尺寸/退出码细节；保持终端输出默认不自动塞入模型。
5. **Review 精细化**：hunk 级 stage/revert、批量行评草稿、二进制/重命名 diff 的专门状态。
6. **本机隔离启动向导**：可选容器或 Windows Sandbox 启动说明/向导；不得把审批门宣传成 OS 沙箱。
7. **按需工作台**：有真实需求后再做本地 artifacts 预览、读取 `PLAN.md`/`TODO.md` 的计划面板、基于本机 `gh` 的 PR 评论闭环。

## 明确不做

- 云端执行环境、远程 worker、云任务队列
- OpenAI/ChatGPT 账号、套餐、计费、组织 RBAC 和企业策略
- 跨设备云同步与 handoff
- 自建插件审核/托管平台；资源中心只管理 Pi packages 和本地资源
- 在没有隔离后端时宣称“已提供 OS 沙箱”
- 只有外观、没有真实本机能力的 Codex 页面空壳

## 验收原则

- 数据与运行记录可指出明确本机路径。
- 断网时已有会话、Git、终端和本地 provider 仍可工作或给出诚实错误。
- Browser、Computer、MCP 等扩展关闭后，核心 Pi 对话仍可用。
- 新功能必须有真实后端、失败状态和最小针对性测试，才能标记已完成。
