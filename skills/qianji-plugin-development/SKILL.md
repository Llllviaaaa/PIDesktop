---
name: qianji-plugin-development
description: Develop, verify, and hot-reload Qianji Desktop plugins (Host tools, JSON-RPC methods, `<PluginSlot>` React UI extensions, file viewers, appearance themes, and desktop pets). Use when extending Qianji, building or debugging plugins, or customizing themes and pets.
---

# Qianji Plugin Development

Qianji uses a dual-plane `@deepseek-ai/cordis` microkernel:
- **Host plane** (`index.ts`, Node/Bun): agent tools, JSON-RPC methods, slash commands, prompt sections, HTTP routes.
- **Client plane** (`client.tsx`, React 19): fault-isolated UI inside `<PluginSlot>` points via `@qianji/client` and `--qj-*` tokens.

## 1. Capability Routing (Decide Before Coding)

| User Goal | Mechanism |
| :--- | :--- |
| One-off interactive calculator, chart, dashboard, or form inside the current chat | Call **`render_ui`** directly. Do **not** scaffold a plugin. |
| Persistent workbench tab, status widget, message action, custom tool card, file viewer, slash command, or Host tool | Build a **Qianji Plugin** (`package.json` + `index.ts` and/or `client.tsx`). |
| Settings page or settings card, menu command (menubar, thread "…", project menu, session or file right-click), global shortcut, or custom Markdown fence renderer | Build a **Qianji Plugin** with `registerSettingsPage` / `registerSettingsSection` / `registerMenuItem` / `registerKeybinding` / `registerCodeBlockRenderer`. |
| Custom color theme / skin or desktop pet sprite pack | Build an **Appearance Extension** ([references/appearance-and-pets.md](references/appearance-and-pets.md)). |

## 2. Mandatory 5-Step Workflow

1. **Inspect live contracts & activate `plugin_dev` first** (`readOnly`, zero prompts in Plan/Ask/Agent):
   Call `qianji_inspect` (`topic: "all"` or `"services" | "client_slots" | "shared_modules" | "theme_tokens" | "plugins"`) and `activate_tools(names: ["plugin_dev"])` to unlock `plugin_manager`. Never guess service names, slot props, or CSS tokens.
2. **Scaffold in a writable folder**:
   Call `plugin_manager(action: "scaffold", id: "<kebab-id>", template: "tool-only" | "ui-slot-widget" | "fullstack-panel")`. Never edit bundled skill templates in place.
3. **Pre-flight verify before installing** (zero prompts):
   Call `plugin_manager(action: "verify", dir: "<plugin-dir>")`. Fix all manifest, Host bundler, and Client TSX/CSS errors until `ok: true`.
4. **Link-install with live HMR**:
   Call `plugin_manager(action: "install_local", dir: "<plugin-dir>", link: true, watch: true)`.
5. **Check live status & `clientError`**:
   Call `qianji_inspect(topic: "plugins", pluginId: "<kebab-id>")`. Confirm `status === "active"`, `error === undefined`, and `clientError === undefined`. If `clientError` appears (`phase: "load" | "render"`), inspect its stack, fix `client.tsx` (HMR updates `clientEtag` and clears `clientError`), or call `plugin_manager(action: "reload", id: "<kebab-id>")`.

## 3. Architecture Guardrails

- **Allowed Client Imports**: Only shared externals (`react`, `react/jsx-runtime`, `lucide-react`, `@deepseek-ai/cordis`, `@qianji/client`, `@qianji/protocol`, `dsh-better-sidebar`) and relative files inside the plugin directory. Never import internal `src/*` modules, Zustand stores, or `..` paths escaping the plugin folder.
- **Scoped CSS & `--qj-*` Tokens**: Use `ctx.styles.inject(css)` or `import "./styles.css"` (auto-wrapped in `@layer plugin-ui { @scope ([data-qj-plugin="<id>"]) { ... } }`). Use `--qj-*` variables (`--qj-bg-surface`, `--qj-text-primary`, `--qj-border-default`, `--qj-brand-primary`) for automatic light/dark/skin support.
- **Overlay Pointer Safety**: `.plugin-overlays-host` sets `pointer-events: none`. Set `pointer-events: auto` only on visible floating cards, never on full-screen wrappers.
- **Fiber Cleanup**: Built-in registries auto-dispose on unload. Wrap custom timers or watchers in `ctx.effect(() => () => cleanup())`.

## 4. Read Next

| Topic | Path |
| :--- | :--- |
| Manifest, `configSchema`, Host tools/RPC/commands | [references/manifest-and-host.md](references/manifest-and-host.md) |
| All 22 contribution APIs & `@qianji/client` SDK | [references/client-slots-and-sdk.md](references/client-slots-and-sdk.md) |
| `@layer` + `@scope` rules & `--qj-*` tokens | [references/styling-and-tokens.md](references/styling-and-tokens.md) |
| Custom themes & desktop pet overlays | [references/appearance-and-pets.md](references/appearance-and-pets.md) |
| Host tool template | [templates/tool-only/package.json](templates/tool-only/package.json), [templates/tool-only/index.ts](templates/tool-only/index.ts) |
| UI slot widget template | [templates/ui-slot-widget/package.json](templates/ui-slot-widget/package.json), [templates/ui-slot-widget/client.tsx](templates/ui-slot-widget/client.tsx) |
| Fullstack panel template | [templates/fullstack-panel/package.json](templates/fullstack-panel/package.json), [templates/fullstack-panel/index.ts](templates/fullstack-panel/index.ts), [templates/fullstack-panel/client.tsx](templates/fullstack-panel/client.tsx) |
