# 0003 插件模型与扩展点词汇

- 状态：已接受
- 日期：2026-10-28

## 背景

现在仓库里并存三套扩展机制：Pi 扩展（`src-tauri/resources/pidesktop-*`）、cordis 插件（移植来的 DSH UI 和 better-sidebar）、Rust 命令。V2 统一用 cordis，并参考 DeepSeek Harness（DSH）的做法：拆分接口包和实现包，所有 loop 逻辑集中在一个包里，扩展点用事件语义来表达。

## 决策

### 插件形态

插件就是 cordis 插件：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'pid-permissions'
export const inject = ['tools', 'settings']          // 必需的服务
export interface Config { mode: 'ask' | 'read-only' | 'workspace-write' | 'full-access' }
export const Config: Schema<Config> = Schema.object({ /* … */ })

export function apply(ctx: Context, config: Config) {
  ctx.on('tools/pre-execute', (call) => { /* … */ })
}
```

- 有状态的能力写成 `Service` 子类，用 `declare module '@deepseek-ai/cordis' { interface Context { … } }` 扩充类型。
- 所有副作用（监听器、定时器、子进程、文件句柄）都必须挂在 `ctx.effect()` 或 `ctx.on()` 上，这样插件卸载时会自动清理。不允许出现脱离 fiber 的全局状态。
- 配置用 schemastery 声明。Host 按配置装载插件，配置文件为 `~/.pid/harness.json` 和项目内的 `.pid/harness.json`。项目级插件和配置必须经过用户显式信任后才会加载。

### 接口与实现分离

- **接口包**（`@pid/llm`、`@pid/tools`、`@pid/session`、`@pid/agent`、`@pid/system-prompt`）只包含类型、抽象服务和事件声明，不含具体策略。
- **实现包**（`@pid/llm-openai`、`@pid/tool-fs`、`@pid/session-jsonl` 等）只依赖接口包。
- **只有 `@pid/agent-loop` 包含 loop 逻辑**。新增的行为一律写成挂在扩展点上的插件，不去改 loop。

### 事件语义

cordis 事件有五种分发方式，每个扩展点只能选其中一种，并在接口包里写明：

| 方式 | 语义 | 适用场景 |
|---|---|---|
| `waterfall` | 依次改写同一个值 | 改写 LLM 请求、改写工具参数和结果、组装提示词 |
| `bail` | 第一个返回非 `undefined` 的监听器决定结果 | 权限放行、拒绝或询问 |
| `serial` | 依次 await，前一个完成再执行下一个 | 有顺序要求的生命周期钩子 |
| `parallel` | 并发 await | 落盘、索引等互不依赖的工作 |
| `emit` | 只观察，不等待 | 指标、通知、UI 推送 |

### 命名

事件名采用 `<域>/<名称>` 格式，名称用 kebab-case。服务键用 camelCase 名词，如 `llm`、`tools`、`sessions`、`agents`、`systemPrompt`、`ui`、`commands`、`settings`、`storage`。

### v1 扩展点词汇表

| 事件或服务方法 | 方式 | 说明 |
|---|---|---|
| `llm.registerAdapter(providers, adapter)` | 服务 | 注册模型适配器，随插件卸载而注销 |
| `llm/request` | waterfall | 发送前改写请求，如注入缓存标记、裁剪上下文 |
| `llm/response` | emit | 一次调用结束，带用量和费用 |
| `tools.register(def)` | 服务 | 注册工具。在会话作用域里注册的只对该会话可见 |
| `tools/pre-execute` | bail | 返回 `{ allow }`、`{ deny, reason }` 或 `{ ask, prompt }` |
| `tools/execute` | waterfall | 包裹执行过程，如 checkpoint、超时、输出截断 |
| `tools/result` | emit | 观察工具结果 |
| `systemPrompt.section(id, render)` | 服务 | 提供提示词片段，按 `order` 排序 |
| `agent/before-start` | serial | 一轮开始前，可以注入上下文消息 |
| `agent/turn-start`, `agent/turn-end` | serial | 每一轮的开始和结束 |
| `agent/settled` | parallel | 队列清空、agent 进入空闲 |
| `session/created`, `session/disposed` | emit | 会话生命周期 |
| `session/event` | emit | 每条持久化事件提交后触发 |
| `session/flush` | parallel | 落盘检查点 |
| `ui.confirm / select / input / editor / notify` | 服务 | 向前端发起交互，见 0002 |
| `commands.register(def)` | 服务 | 注册斜杠命令 |

事件的参数类型在落地时写进对应的接口包。表中没有列出的事件，必须先补 ADR 再新增。

## 后果

- 每一项现有能力都能找到明确的落点：
  - 权限和规则挂在 `tools/pre-execute`；
  - checkpoint 挂在 `tools/execute`；
  - 计划和记忆用 `systemPrompt.section` 加工具；
  - hooks 订阅 `agent/*` 和 `tools/*`；
  - 子 agent 是一个子作用域。
- 插件之间只通过服务和事件通信，可以单独测试，也可以单独替换。
- 事件词汇是公开 API，改动需要走 ADR，速度上会慢一些，换来的是第三方插件的稳定性。

## 备选方案

- **直接依赖 `@deepseek-ai/dsh-*`**：这些包目前都是 rc 版本，接口仍在变动，许可证也是 MIT 和 BSD-3 混合。我们只借鉴设计，不直接依赖（决策 D1）。
- **自造一套插件系统**：cordis 已经提供依赖注入、作用域和生命周期，前端也已经在用，没有必要重造。
