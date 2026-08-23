# Pi Desktop 补齐计划

> 状态：执行版 v2（Phase A/B 已落地，Phase C 核心已落地） · 约束：**纯本地** + **对齐 Pi 设计理念**
> 对照文档：[CODEX_PARITY.md](./CODEX_PARITY.md) · 运行时：[Pi](https://pi.dev)

本文是产品与工程的执行计划，不是功能愿望清单。  
**目标**：把 Pi Desktop 做成「本地 Pi 项目指挥中心」，UI 可借鉴 Codex 桌面工作流，语义与扩展模型必须是 Pi-native。

---

## 0. 产品宪法（所有决策先过这关）

### 0.1 我们是什么

```text
本机 Tauri 壳
  → 管理多个 pi --mode rpc 进程（runtime）
  → 管理本机会话 JSONL、设置、Git/worktree、审批 UI
  → 用 bundled / 用户 extensions · skills · packages 扩展能力
```

- **Pi** 负责：agent 循环、工具原语、会话树、compaction、模型调用  
- **Desktop** 负责：多任务编排、可观测 UI、本机 Git/终端、确认流、可选本机工具宿主  

### 0.2 我们不是什么

| 不做 | 原因 |
| --- | --- |
| 云端执行 / Cloud environments | 非本地 |
| 账号、计费、组织 RBAC、合规中枢 | 非 Pi 壳职责 |
| 跨设备云 handoff | 非本地 |
| 插件应用商店 + 上架审核 | 违背 Pi「npm/git package 自助」 |
| 把 Codex 每个页面做成空壳 | 违反 product rule |
| 改写 Pi 内核以塞入「超级应用」功能 | 违背 minimal harness |

### 0.3 新功能五问（全部为「是」才进主线）

1. 数据是否只落本机？（会话、设置、日志、产物）  
2. 执行是否只起本机进程？（`pi`、shell、浏览器、helper）  
3. 能否做成 extension / skill / package / 桌面桥，而不是改 agent 内核？  
4. 能否关闭且不影响核心编码循环？  
5. UI 是否接真实本地后端？（无则不做或标实验）

### 0.4 对齐 Pi 的扩展原则

| Pi 原则 | Desktop 落地 |
| --- | --- |
| 核心小，能力外置 | 新能力优先 `src-tauri/resources/pidesktop-*.ts` 或用户 package |
| Pi 核心不内置 MCP / 子 agent / plan / todo | Desktop 通过可关闭的 bundled extension 提供 MCP、持久计划、Hooks 与本地子 Agent，不改写 Pi agent loop |
| 无内置 OS sandbox | 审批走 extension；强隔离用本机容器/Sandbox，诚实标注 |
| 会话是本地 JSONL 树 | 桌面强化 tree：分支、回点、书签、export |
| 可观测，不藏后台 | 多 runtime / 终端 / 调度任务过程可见 |

### 0.5 与 Codex 的关系

- **可借**：布局、多任务体感、本地 Git/worktree、命令中心信息架构  
- **不借**：Cloud、账号体系、企业治理、超级应用功能堆砌  

---

## 1. 现状基线（已具备，不重复造）

| 域 | 状态 | 备注 |
| --- | --- | --- |
| 多 Pi runtime 并行 + 切换 + 恢复 | 已有 | 指挥中心骨架 |
| 流式对话 / tools / 会话生命周期 | 已有 | 接 Pi RPC |
| Skills / prompts / extensions / packages | 已有 | 首页资源中心支持发现与 npm/git/本地源管理 |
| Guard 权限模式 | 已有 | 审批门，非 OS 沙箱 |
| Browser / Computer / MCP tools | 已有 | bundled 可选扩展 |
| Git review、worktree、终端 | 已有 | stage/unstage/revert、行评、多 tab 已落地 |
| 本地 Scheduled | 已有 | App 运行期间触发，SQLite 记录，禁止静默 full-access |
| 设置中心、通知、用量 | 已有 | — |

**已知诚实缺口**（见 CODEX_PARITY）：权限不是 OS 隔离；MCP OAuth 与实验性 tasks 仍待协议稳定后补充；云/账号明确不做。

---

## 2. 补齐范围总览

### 2.1 要补（本地 + Pi-native）

| ID | 主题 | 用户价值 | 形态 |
| --- | --- | --- | --- |
| L1 | 会话树桌面化 | 分支/回点/继续，对齐 Pi session tree | UI + RPC |
| L2 | 权限 Rules v1 | 少打扰、可配置、仍走 extension | guard + 设置 |
| L3 | Worktree 任务默认 | 多任务隔离的正确默认 | UI + 已有 worktree API |
| L4 | Review 闭环 | diff 验收、hunk、行评回灌 | Git UI + chat |
| L5 | 本地 Scheduled | 到点起本机 Pi，结果可回看 | 本机调度器 |
| L6 | 资源中心 2.0 | 扩展/技能/包可发现可开关 | 设置/侧栏 |
| L7 | 终端可观测 | 多 tab、过程可见 | 终端 UI |
| L8 | MCP 可选增强 | resources/状态（仍可关） | mcp extension |
| L9 | Browser/Computer 打磨 | 预览与安全默认，保持可关 | extension + Inspector |
| L10 | 轻量本地 Memory | 偏好落文件，非云画像 | 文件 + 可选注入 |

### 2.2 不做 / 明确 Out of scope

| 主题 | 处理 |
| --- | --- |
| Cloud environments | 永久不做；parity 保持 Platform gap |
| 账号计费组织策略 | 永久不做 |
| 跨设备云 handoff | 不做；本地 clone/fork/worktree 足够 |
| 自建云插件商店与上架审核 | 不做；首页资源中心直接使用 Pi packages（npm/git/本地）与公开 npm 元数据 |
| Voice / 生图平台 / SaaS 全家桶 | 默认不做 |
| 企业级 OS sandbox 宣传成「已与 Codex 对等」 | 不做虚假对等；可选本机隔离另议 |

### 2.3 可后置（有需求再开）

- 本机 `gh` 轻量 PR 评论拉取（纯本地 CLI，非 GitHub 产品化）  
- 可选「在 Windows Sandbox / 容器中启动 Pi」向导  
- 更完整的计划面板（当前 `update_plan` 已通过桌面 widget 提供持久步骤）
- Artifacts：常见文本/图片/HTML 用系统或简易预览  

---

## 3. 分阶段计划

版本号为规划用标签，可随发布调整；**验收标准**比版本号更重要。

### Phase A — 本地 Pi 指挥中心夯实（约 2–3 周）

**目标**：日常编码路径「可分支、可隔离、可少打扰」。

| 项 | 交付 | 主要落点 | 完成定义 |
| --- | --- | --- | --- |
| **A1 会话树** | 查看 session tree、跳到节点继续、基础书签/标签展示 | `store` + RPC（`/tree` 等价能力）+ Sidebar/Inspector | 用户可不靠 CLI 完成 fork/回点 |
| **A2 Worktree 默认** | 新建任务可选 Local / Worktree；Worktree 创建→开聊一气呵成 | `App.tsx`、worktree commands、设置默认项 | 并行改同一仓库时默认不互相踩工作区 |
| **A3 Rules v1** | 可配置：shell 总是问 / 路径写保护 / 常用前缀允许 | `pidesktop-guard.ts`、Settings | 在 ask 模式下重复确认明显减少且可审计 |
| **A4 权限文案诚实化** | 设置与 README 统一：「审批门 ≠ OS 沙箱」 | 文案 + CODEX_PARITY | 用户不会误判安全边界 |
| **A5 Hub 去空壳** | Plugins→首页资源中心；Scheduled 只在接入真实本机调度后展示；Sites 不做空壳 | `App.tsx` | 无虚假「已支持」页 |

**Phase A 不做**：定时执行、OS 沙箱内核、云。

**出口标准**

- [x] 多任务 + worktree 路径文档化且可点通
- [x] 会话树至少支持：查看、回点继续、与现有 clone/fork 不冲突
- [x] Rules 有持久化配置并实际作用于 tool_call
- [x] 无新增占位冒充功能

---

### Phase B — 验收与本地自动化（约 3–4 周）

**目标**：改完能审、能定点跑本机任务（仍全本地）。

| 项 | 交付 | 主要落点 | 完成定义 |
| --- | --- | --- | --- |
| **B1 Review pane 2.0** | 文件列表 + hunk 展示；stage/unstage/revert（能做多少做多少，至少 file 级）；行评收集后发回当前 chat | Inspector/新组件 + `git` commands | 不靠外部 Git GUI 完成「看 diff → 反馈 Pi」 |
| **B2 本地 Scheduled v1** | 任务：prompt、cwd、cron/简单周期、Local|Worktree、权限模式快照；到点 spawn runtime；运行记录落盘 | 新模块 `scheduler`（Rust 或前端+后台）+ UI 收件箱 | 关机不跑（诚实）；开机且 App 运行时可触发；结果可打开会话 |
| **B3 调度安全默认** | 默认识别模式偏紧（如 ask 或 read-only+显式允许）；禁止静默 full-access | Settings + scheduler | 文档写清 unattended 风险 |
| **B4 资源中心 2.0** | 扩展/技能/提示词/包列表、启用状态、安装来源（npm/git/本地） | Settings + `list_resources` / package actions | 用户能完成发现→安装→用于对话 |
| **B5 终端多 tab** | ≥2 个本地 shell tab；输出流不丢；可选不进模型上下文 | Inspector 终端 | 可同时看 agent 与手动命令 |

**Phase B 不做**：云触发、远程机器调度、企业策略下发。

**出口标准**

- [x] Review：file 级 stage/unstage/revert + 行评回灌
- [x] Scheduled：创建 / 暂停 / 手动跑一次 / 历史列表全本地
- [x] 资源中心与 browser/computer/mcp 的开关、安全叙事一致
- [x] CODEX_PARITY：Scheduled 标记本地已实现并写清运行限制

---

### Phase C — 可选能力打磨（约 2–3 周）

**目标**：扩展能力好用、可关、不污染核心。

| 项 | 交付 | 完成定义 |
| --- | --- | --- |
| **C1 Browser 面板** | Inspector 固定最近 URL/截图/步骤 | 前端验收不必翻工具卡片 |
| **C2 Computer 安全默认** | 确认默认开；read-only 阻断交互；敏感操作文案 | 与现有 helper 行为一致且可配置 |
| **C3 MCP 增强（可选）** | resources 列表只读浏览；连接状态/错误可见；仍无 OAuth 平台 | 工具外能力可查；失败可诊断 |
| **C4 本地 Memory 文件** | 用户/项目 memory markdown；可选注入；可关 | 符合 context engineering，非云记忆 |
| **C5 本机隔离向导（可选）** | 文档 + 若可行：一键提示用容器/Sandbox 跑 | **不**宣称内置 OS sandbox 对等 Codex |

**出口标准**

- [x] browser/computer/mcp 均有「一键关闭且核心聊天仍可用」
- [x] Memory 可导出/删除（纯文件），并提供审批门保护的 agent 工具
- [x] parity 与 README 安全模型无矛盾

---

### Phase D — 按需（不排期，有证据再开）

| 项 | 触发条件 |
| --- | --- |
| `gh` PR 评论只读/修复闭环 | 团队日常强依赖 GitHub PR |
| 简易 Artifacts 预览 | 会话常产出 HTML/图片需内嵌 |
| 独立 Plan 检查器 | 当前 widget 不足以承载依赖关系或大型计划时 |
| 多仓库 project 视图 | 单窗管理多 cwd 成为痛点 |

---

## 4. 架构落点（实现时遵守）

```text
src/                     UI 状态机、会话树、Review、调度收件箱
src/lib/pi.ts            带 runtimeId 的 RPC / invoke
src/store.ts             多 runtime；禁止把云状态机塞进来
src-tauri/src/lib.rs     进程、设置、Git、worktree、调度持久化
src-tauri/src/pi/        RPC 桥、会话扫描（保持薄）
src-tauri/resources/     pidesktop-*.ts 可选能力（可关）
~/.pi/...                Pi 会话与用户资源（不搬进云）
%AppData%/pid-desktop/   Desktop 设置、扩展副本、调度任务、运行记录
```

**硬规则**

- 协议逻辑仍以 Pi JSONL 为准；Desktop 不复制 agent 循环  
- 新工具优先 extension，不优先「写死在 Rust 里的伪 agent」  
- 调度器只负责：**到点 → 起 runtime → 投递 prompt → 记结果**；思考与工具仍是 Pi  

---

## 5. 里程碑与建议顺序

```text
A1 会话树 ──┬── A2 Worktree 默认
            ├── A3 Rules v1
            └── A5 去空壳
                    │
                    ▼
            B1 Review 2.0 ──┬── B2/B3 Scheduled 本地
                            ├── B4 资源中心
                            └── B5 终端多 tab
                                    │
                                    ▼
                            C1–C5 可选打磨
```

依赖说明：

- **Scheduled（B2）依赖 A3 安全默认**；无 Rules/紧权限前不开放 unattended 默认  
- **Review（B1）不依赖 Scheduled**，可与 B2 并行  
- **C 阶段**不阻塞 A/B 发布  

---

## 6. 验收清单（产品级）

### 本地

- [ ] 断网时：已有会话、Git、终端、本地模型/已配 provider 的路径仍可解释（至少失败信息诚实）  
- [ ] 所有持久化路径在本机且可指出目录  
- [ ] 无强制登录、无云任务队列  

### Pi-native

- [ ] 关闭 bundled 扩展后，核心对话 + 基础工具仍可用  
- [ ] 用户可通过 Pi packages / 扩展机制加能力，而不改 Desktop 发版（理想）或仅需配置  
- [ ] 不引入「Desktop 自有 agent 协议」与 Pi 双轨  

### 诚实

- [ ] CODEX_PARITY 与 UI 文案一致  
- [ ] 安全边界写明审批门 vs 可选外部隔离  
- [ ] Scheduled 写明：需本机开机且（v1）App 在运行  

---

## 7. 文档同步任务（随 Phase 做）

| 文档 | 动作 |
| --- | --- |
| [README.md](./README.md) | 产品宪法三句话；链到本计划；安全模型与 Phase 进展同步 |
| [CODEX_PARITY.md](./CODEX_PARITY.md) | 前言改为「本地 Codex 风格工作流对照」；Scheduled/沙箱分类按实现更新 |
| 本文件 | 每完成一 Phase 勾选出口标准、记日期与版本 |

---

## 8. 首迭代建议（立刻可开干）

若只开 **一个** 工程迭代，建议：

### Sprint 1（Phase A 切片）— 已落地（2026-08-11）

1. **A5** Hub 去空壳 / 文案诚实 — Plugins→首页资源中心；Scheduled 接真实本机调度后展示；Sites 不做空壳
2. **A2** 新建任务 Local | Worktree 一等选择（Composer toggle + settings default + 首条消息前 create/connect）  
3. **A3** Rules v1：`alwaysConfirmShell`、`blockWriteOutsideWorkspace`、`shellAllowPrefixes` + guard/`pidesktop-rules.ts` + env 注入  
4. **A1** 会话树 Inspector + `get_tree` / `fork` 从此继续  

并行文档：README / CODEX_PARITY 产品宪法已存在。

---

## 9. 成功画像（3 个 Phase 后）

用户可以：

1. 在同一仓库用 **Worktree** 开多个本机 Pi 任务并行，不互相脏工作区  
2. 用 **会话树** 回退某次尝试再开分支，而不丢历史  
3. 用 **Rules** 让常规命令少打断，危险操作仍确认  
4. 在 **Review** 里看 diff、回批注给 Pi、处理完再继续聊  
5. 用 **本地 Scheduled** 在开机时段跑巡检/摘要类 prompt，记录落在本机会话  
6. 随时关闭 MCP/Browser/Computer，核心编码不受影响  

**仍然没有**：云端代跑、账号套餐、跨设备云同步——且这是有意的。

---

## 10. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| v1 | 2026-08-11 | 初稿：纯本地 + Pi-native 补齐计划 |
| v2 | 2026-08-21 | Phase A/B 落地；补齐 Review、Scheduled、安全权限、多 tab 终端、资源中心与 MCP resources/prompts；明确剩余本地范围 |
