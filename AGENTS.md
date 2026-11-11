# Qianji (千机) — Repository Engineering & Agent Guidelines

This document defines the architectural invariants, extension workflows, frontend UI/CSS rules, and verification gates for contributors and coding agents working inside this repository.

---

## 1. Three-Plane Architecture & Module Boundaries ([ADR 0005](docs/adr/0005-repository-layout.md))

Qianji runs across three strictly separated planes that do **not** share memory or module graphs:

1. **Desktop Shell (`src-tauri/`)**: Tauri 2 Rust process managing native windows, WebView guards ([`webview_guard.rs`](src-tauri/src/webview_guard.rs)), OS keychain secrets, and `settings.json` persistence ([`config.rs`](src-tauri/src/config.rs)).
2. **Harness Host (`packages/*`)**: Bun-compiled sidecar (`qianji-harness`) running Cordis services (`@qianji/tools`, `@qianji/commands`, `@qianji/permissions`, `@qianji/prompt-context`, `@qianji/system-prompt`, `@qianji/session`, `@qianji/agent`, `@qianji/host`).
3. **React 19 Renderer (`src/`)**: Vite webview UI communicating with Harness Host over JSON-RPC / WebSocket.

**Hard Import Invariant (enforced by [`eslint.config.js`](eslint.config.js))**:
- Code under `src/` may **only** import `@qianji/protocol` from `@qianji/*` and must **never** import `packages/*` by path.
- Host packages under `packages/*` must never import `src/*`.

---

## 2. Prefer Plugins First & Agent Closed-Loop Workflow ([ADR 0016](docs/adr/0016-dynamic-plugins-and-hmr.md))

Before editing core workbench components, check whether the capability belongs in a hot-pluggable plugin or a one-off `render_ui` widget:

- **Ephemeral turn visualization / interactive form**: Use `render_ui`.
- **Persistent workbench tab, file viewer, message action/card, status bar item, slash command, or custom tool**: Build a Qianji plugin following [`skills/qianji-plugin-development/SKILL.md`](skills/qianji-plugin-development/SKILL.md).
- **5-Step Agent Plugin Loop**:
  1. Read [`skills/qianji-plugin-development/SKILL.md`](skills/qianji-plugin-development/SKILL.md) (plus targeted files in [`skills/qianji-plugin-development/references/`](skills/qianji-plugin-development/references/client-slots-and-sdk.md)).
  2. Call `qianji_inspect` (`readOnly: true`) to query live `services`, `client_slots`, `theme_tokens`, `shared_modules`, `rpc_methods`, or `plugins`.
  3. Activate `plugin_manager` (`activate_tools`) and `scaffold` from `tool-only`, `ui-slot-widget`, or `fullstack-panel`.
  4. Run `plugin_manager(action: "verify")` (validates manifest, Host imports, and `ClientBundleRegistry.compile` with zero config side effects) and `tsc --noEmit` against generated `plugin-types/`.
  5. Run `plugin_manager(action: "install_local")` (`link: true, watch: true`) and inspect `qianji_inspect(topic: "plugins")` to confirm `clientError` and `error` are empty.

**Strict Internal vs. External Decoupling**:
- **Host-internal UI (`src/components/ui/`)**: Internal primitives (`Button`, `Dialog`, `Tabs`, `Select`, `Switch`, `Input`, `Badge`, `Tooltip`) for host screens only. Feel free to refactor props internally.
- **External Plugin SDK ([`src/sdk/index.ts`](src/sdk/index.ts) / `@qianji/client`)**: SemVer-stable contract for plugins (`useActiveSession`, `useActiveWorkspace`, `useAppearanceTheme`, `usePluginConfig`, `useHostRpcQuery`, `callHostRpc`, `openWorkbenchTab`, `openWorkspaceFile`, `sendChatPrompt`, `showToast`). Never expose raw internal Zustand slices to new plugins; when changing `src/sdk/index.ts`, update [`scripts/generate-plugin-types.mjs`](scripts/generate-plugin-types.mjs) and run `node scripts/generate-plugin-types.mjs`.

---

## 3. Frontend UI, CSS Cascade & React Rules

1. **CSS `@layer` Order & Legacy Watermark ([`src/styles/index.css`](src/styles/index.css))**:
   - Authoritative cascade order: `@layer theme, base, plugin-ui, legacy, skin, components, utilities;`.
   - `plugin-ui` intentionally sits **below** `legacy`, `skin`, `components`, and `utilities`, and plugin styles injected via `ctx.styles.inject()` or `import "./style.css"` are wrapped in `@layer plugin-ui { @scope ([data-qj-plugin="<id>"]) { ... } }` so plugin CSS can never pollute host chrome.
   - `overlays` slot root enforces `pointer-events: none` so floating widgets/pets never block the main window; interactive children opt in with `pointer-events: auto`.
   - **Never add new rules to [`src/styles.css`](src/styles.css)** (locked by a monotonically non-increasing line watermark in [`tests/test-architecture-guardrails.test.ts`](tests/test-architecture-guardrails.test.ts)). Author new host styles in `@layer components` using `--qj-*` semantic tokens from [`src/styles/tokens.css`](src/styles/tokens.css).
2. **Fault-Isolated Slot Rendering**:
   - **Never** call `entry.render(ctx)` directly in JSX (forbidden by `eslint.config.js`). Always mount plugin contributions through [`<PluginSlot>`](src/components/common/PluginSlot.tsx) or [`<SlotEntryHost>`](src/components/common/ErrorBoundary.tsx) so synchronous throws and React Hooks stay isolated inside a dedicated child Fiber with one-click Reload/Disable recovery.
3. **Component Size Budgets**:
   - The 7 top-level shell/panel entry files (`src/App.tsx`, `PluginsSettingsPanel.tsx`, `ModelsPage.tsx`, `IntelligentUiCard.tsx`, `Sidebar.tsx`, `Message.tsx`, `Composer.tsx`) must remain **`<= 350` physical lines** each.
   - Modular subdirectories (`src/components/{ui,plugins,models,shell,intelligent-ui,sidebar,message,composer}/**`) enforce ESLint **`max-lines: 400`** (excluding blank lines and comments).
4. **React Hooks & TypeScript Hygiene (`eslint.config.js`)**:
   - Zero `!` non-null assertions (`@typescript-eslint/no-non-null-assertion: "error"`).
   - Strict `===` equality (`eqeqeq: ["error", "always", { null: "ignore" }]`).
   - Never call `setState` synchronously inside `useEffect` (`react-hooks/set-state-in-effect: "error"`): use TanStack Query ([`src/lib/queries.ts`](src/lib/queries.ts)) for async backend state and [`useSyncOnChange`](src/hooks/useSyncOnChange.ts) when local state tracks a prop change.
   - Do not return `RefObject` instances inside composite state objects from custom hooks; declare DOM refs in the component and pass them into hooks to satisfy `react-hooks/refs`.

---

## 4. Tri-End `AppSettings` Modification Checklist

Whenever adding or renaming a desktop setting, update **all five** locations together (verified by [`tests/test-appsettings-alignment.test.ts`](tests/test-appsettings-alignment.test.ts)):

1. [`packages/protocol/src/app-settings.ts`](packages/protocol/src/app-settings.ts) — Add field to `AppSettings` interface, `DEFAULT_APP_SETTINGS`, and `APP_SETTINGS_KEYS`.
2. [`src-tauri/src/config.rs`](src-tauri/src/config.rs) — Add corresponding `#[serde(default = "...")]` field to `pub struct AppSettings` and `impl Default for AppSettings` under `#[serde(rename_all = "camelCase")]` so Rust never silently drops the field on save.
3. [`packages/host/src/desktop-settings.ts`](packages/host/src/desktop-settings.ts) — Wire runtime synchronization into `harness.json` / Host state if the Host consumes the setting.
4. [`src/components/SettingsModal.tsx`](src/components/SettingsModal.tsx) (and [`src/types.ts`](src/types.ts) re-exports) — Expose or preserve the field in `DEFAULT_SETTINGS` and settings UI.
5. [`tests/test-appsettings-alignment.test.ts`](tests/test-appsettings-alignment.test.ts) — Run Vitest to confirm 1:1 camelCase ↔ snake_case key parity across Protocol, Rust, and React.

---

## 5. Verification Commands

Run these checks before completing changes:

```bash
node scripts/generate-plugin-types.mjs   # Refresh offline plugin .d.ts declarations when SDK/protocol changes
npm run typecheck                        # Workspace-wide TypeScript check
npm run lint                             # ESLint (ADR 0005 boundaries, slot .render() gate, max-lines, React Hooks)
npm test                                 # Full Vitest suite (unit, fault-isolation, CSS @scope, guardrails)
npm run test:doc-links                   # Verify all local Markdown links resolve
npm run test:public-hygiene              # Version, CSP, and bundle resource hygiene checks
```
