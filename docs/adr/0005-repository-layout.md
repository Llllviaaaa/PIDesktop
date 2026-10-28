# 0005 仓库布局与包约定

- 状态：已接受
- 日期：2026-10-28

## 背景

Harness 由一组接口包和实现包组成（见 0003），前端也要共用协议包。代码需要一个结构，让包的边界清楚，同时不拖慢现有的构建和测试。

## 决策

### 布局

```text
packages/
  protocol/        @pid/protocol      前端与 Host 共用的协议（0002）
  host/            @pid/host          cordis 根、插件装载、进程入口
  <接口>/          @pid/llm、@pid/tools、@pid/session、@pid/agent …
  <实现>/          @pid/llm-openai、@pid/tool-fs、@pid/session-jsonl …
  testkit/         @pid/testkit       mock LLM、loop 黄金测试工具
src/               前端（不动）
src-tauri/         Rust（逐步瘦身）
```

- 使用 npm workspaces（`"workspaces": ["packages/*"]`），所有包都是 `private: true`。包不单独发版，版本号固定为 `0.0.0`，这样发版时不必逐个改动。
- 目录名去掉 `@pid/` 前缀，与包名一一对应。

### 包约定

- **只发布源码**：`exports` 直接指向 `./src/index.ts`，不做单包构建。Host 的可执行文件由 esbuild 打包、`bun build --compile` 编译（0001）；前端由 Vite 直接消费 `@pid/protocol` 的源码。
- 包内结构：

  ```text
  src/index.ts    公开入口，只从这里导出
  src/**          实现
  test/*.test.ts  测试，由根目录的 vitest 统一运行
  README.md       职责、服务、事件、配置
  ```

- 每个包的 `package.json` 都要在 `dependencies` 里列全它导入的包，包括 workspace 内的 `@pid/*`，写成 `"*"`。
- 运行时只依赖 Node 和 Bun 都支持的 API。只有 Bun 才有的能力（如 `bun:sqlite`）必须封装在实现包里，并在 README 中注明。

### 边界规则

| 从 → 到 | 允许 |
|---|---|
| `src/`（前端） → `@pid/protocol` | 是 |
| `src/` → 其他 `@pid/*` | 否，前端只通过协议与 Host 通信 |
| `packages/*` → `src/`、`src-tauri/` | 否 |
| 实现包 → 接口包 | 是 |
| 接口包 → 实现包 | 否 |
| 任意包 → `@pid/agent-loop` | 否，只有 `@pid/host` 负责装载它 |

这些规则先靠评审保证，P1 起用 ESLint 的 `no-restricted-imports` 落实。

### 类型检查与测试

- `packages/` 使用独立的 `tsconfig.packages.json`，**不继承**前端 `tsconfig.json` 里对 `@deepseek-ai/cordis` 的 paths 映射（那个映射指向前端精简过的声明文件），而是直接使用 cordis 的真实类型。
- `npm run typecheck` 同时检查前端、工具脚本和 packages。`vitest` 的 include 增加 `packages/*/test/**/*.test.ts`，CI 无需修改。

## 后果

- 新增一个包只需要建目录、写 `package.json`，再执行一次 `npm install`。
- 只发布源码，省去每个包的构建步骤；代价是包不能单独发布到 npm。将来要对外发布插件 SDK 时再补构建。

## 备选方案

- **pnpm、yarn workspaces**：仓库已经是 npm 加 lockfile，CI 也基于 npm，没有必要换工具。
- **每个包单独 `tsc` 构建，用 project references**：在只发布源码的前提下收益不大，配置成本却高。
