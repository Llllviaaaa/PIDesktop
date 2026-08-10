# Pi Desktop

Pi Desktop is a Codex-style Windows desktop client for the local [Pi coding agent](https://pi.dev). It uses Pi's JSONL RPC mode as the execution engine and adds a project-oriented desktop workflow around it. The UI and local workflow deliberately follow Codex Desktop, while Pi remains the model and tool runtime.

## Current capabilities

- Local workspaces with cross-repository session history, search, rename, archive/restore, recoverable deletion, clone, checkpoint fork, compaction, and HTML export
- Streaming text, reasoning, tool calls, tool output, retries, queue status, context usage, and cost/token metadata
- Runtime model and thinking-level selection
- Image inputs and local file references
- Pi slash commands, skills, prompt templates, and extension commands discovered through RPC
- Isolated Edge/Chrome browser automation for page inspection, interaction, and screenshots
- Extension UI requests: confirmation, selection, text input, editor input, notifications, status, and widgets
- Codex-style permission modes backed by a Pi tool-interception extension
- Git working-tree summary, unified diff review pane, inline/new-chat review delivery, and configurable Git instructions
- Managed Git worktrees and worktree-scoped new chats
- Integrated Pi terminal with streaming output and optional exclusion from model context
- Native completion/approval notifications, prevent-sleep support, local token/cost usage aggregation, and custom instructions
- Full-screen settings center for appearance, notifications, personalization, shortcuts, archives, usage, models, Pi resources/packages, permissions, terminal, Git, worktrees, and advanced configuration
- Persisted process, appearance, behavior, provider, permission, Git, notification, and session settings

See [CODEX_PARITY.md](CODEX_PARITY.md) for the feature-by-feature boundary. UI parity does not turn Pi into OpenAI's hosted Codex platform: cloud environments, first-class MCP, OS-wide computer-use, automations, and OS sandboxing need additional runtimes rather than settings-page placeholders.

## Architecture

```text
React UI + Zustand state
        | Tauri invoke/events
Rust desktop bridge
        | JSONL stdin/stdout
pi --mode rpc
```

The Rust layer owns process lifetime, settings, session discovery, attachments, Git inspection, and event forwarding. The frontend owns RPC correlation and the conversation/UI state machine.

## Development

Prerequisites:

- Node.js and npm
- Rust stable with the MSVC toolchain
- WebView2
- Pi available on `PATH`, or an absolute Pi executable configured in Settings

```powershell
npm install
npm run tauri -- dev
```

Frontend-only checks:

```powershell
npm run build
```

Desktop build:

```powershell
npm run tauri -- build
```

Rust tests:

```powershell
Set-Location src-tauri
cargo test
```

## Security model

Pi does not provide a built-in operating-system sandbox. Pi Desktop's `read-only`, `ask`, and `workspace-write` modes load a bundled Pi extension that blocks or confirms model-initiated tools, and project-local Pi resources require an explicit trust response through the desktop UI.

These approval gates are not an isolation boundary. Run untrusted or unattended work inside a container, VM, Windows Sandbox, or another policy-controlled environment. `full-access` gives Pi the permissions of the desktop user.

## Important files

- `src/App.tsx` - desktop workspace composition
- `src/store.ts` - Pi protocol and conversation state machine
- `src/lib/pi.ts` - typed Tauri/RPC client
- `src/components/` - chat, composer, sessions, review, terminal, settings, and permission UI
- `src-tauri/src/lib.rs` - Tauri commands and persisted settings
- `src-tauri/src/pi/rpc.rs` - Pi process and JSONL transport
- `src-tauri/src/pi/sessions.rs` - session metadata and recoverable deletion
- `src-tauri/resources/pidesktop-guard.ts` - project trust and permission gates

## Known platform boundary

The implemented scope covers the core local Codex-style coding workflow, including managed worktrees and isolated browser automation. Cross-device handoff, true OS sandbox enforcement, remote/cloud execution, scheduled automations, OS-wide computer-use, and first-class MCP hosting require separate platform backends rather than UI-only emulation.
