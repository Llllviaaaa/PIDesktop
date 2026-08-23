# UI parity plan (local Codex-style, not cloud)

**Direction chosen:** visual polish **and** workflow surfaces together.  
**Constraint:** pure local + Pi-native; no empty hubs.

## Status note (2026-08-11)

First visual pass was **not** tightly referenced against Codex screenshots. It added decorative chrome (avatar rails, tool timeline frames, panel heroes, gradients) that made the app feel busier and less like Codex’s restrained ChatGPT-family UI. That pass was **reverted** for Message/ToolCall/core styles; Sprint 1 functional pieces (Local/Worktree toggle, session tree, rules settings) remain with minimal styling.

Next UI work must start from real Codex reference frames (or user-provided screenshots), not invented decoration.

## Track A — Design system & shell

| ID | Surface | Goal |
| --- | --- | --- |
| U1 | Design tokens | Radius, spacing, elevation, type scale closer to Codex density |
| U2 | Sidebar threads | Status chips (running / approval), clearer project sections |
| U3 | Message stream | User bubble, assistant column, streaming/tool hierarchy |
| U4 | Tool cards | Timeline-like steps with clearer running/done/error |
| U5 | Composer | Stronger card, environment/permission controls as product chrome |

## Track B — Workflow panels (real local backends only)

| ID | Surface | Goal |
| --- | --- | --- |
| W1 | Review (Changes) | Productized file list + diff chrome (not raw pre dump only) |
| W2 | Terminal | Console chrome, clearer prompt/output |
| W3 | Browser / Computer | Preview frame + empty state that looks intentional |
| W4 | Session tree | Already present; match inspector visual language |

## Out of scope here

Cloud threads, artifacts cloud store, plugin marketplace, scheduled runner UI pretending to work.

## Exit criteria (this slice)

- [x] Tokens + shell density update in `styles.css`
- [x] Message / ToolCall / Sidebar / Composer class structure refined
- [x] Inspector changes/terminal/browser look like product panels
- [x] Release rebuild + launch (`pid-desktop.exe`)
