# 0006 better-sidebar 宿主端并入 Host（边界例外）

- 状态：已接受
- 日期：2026-10-28

## 背景

ADR 0005 规定 `packages/*` 不能引用 `src/`。better-sidebar（MIT，上游 DSH-better-sidebar）的客户端和宿主端放在同一个目录 `src/better-sidebar` 下，并保持上游的目录结构：客户端由前端加载，宿主端以前由 `sidecar/better-sidebar-host` 单独运行。P1 把宿主端并入 Harness Host（ADR 0001 第 4 条），所以 `@pid/host` 必须加载 `src/better-sidebar/index.ts`。

## 决策

- 只允许 `packages/host/src/better-sidebar/` 通过 `dsh-better-sidebar/*` 这个说明符引用 `src/better-sidebar`，其他包仍遵守 ADR 0005。
- 解析方式与前端保持一致：
  - esbuild 打包（`scripts/prepare-harness-host.mjs`）和 vitest（`dsh-aliases.ts`）都把这个说明符映射到真实源码。
  - 类型检查（`tsconfig.packages.json`）只读取 `packages/host/types/better-sidebar.d.ts` 里声明的那部分接口，不深入上游源码，因为上游源码是按 DSH 自己的宿主类型做类型检查的。
- 上游宿主端引用的 DSH 宿主包（`@deepseek-ai/dsh-tools`、`dsh-settings`、`dsh-llm`、`dsh-agent`、`dsh-subagent`）映射到 `packages/host/src/better-sidebar/shims/`。打包和测试使用同一份映射，这样插件里 `instanceof SettingsConflictError` 判断时拿到的是同一个类。
- `sessions` 和 `tools` 暂时由适配插件提供空实现。P3 有了真正的 `sessions` 和 `tools` 服务后，删掉这两个空实现，better-sidebar 直接注入 Host 的服务。

## 后果

- 原来的 sidecar 进程、它的打包产物和 Rust 端的托管代码都去掉了，侧边栏的路由由 Host 提供，地址仍通过 `sidebar_host_base` 获取，前端不用改。
- 侧边栏的设置文件位置不变，仍是 `<app data>/better-sidebar/settings.json`。
- 升级上游 better-sidebar 时，需要核对 `types/better-sidebar.d.ts` 和 shims 是否仍然匹配。`packages/host/test/better-sidebar.test.ts` 和 `scripts/test-harness-host.mjs` 会验证插件能加载并响应请求。

## 备选方案

- **把宿主端源码搬进 `packages/`**：这会打乱上游的目录结构，以后同步上游会更难，否决。
- **继续保留独立的 sidecar 进程**：与 ADR 0001“单个 Host”的决策相悖，否决。
