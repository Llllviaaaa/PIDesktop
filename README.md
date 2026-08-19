# Pi Desktop

Pi Desktop is a **local-only**, Codex-style Windows desktop client for the [Pi coding agent](https://pi.dev). It uses Pi's JSONL RPC mode as the execution engine and adds a project-oriented desktop workflow around it. The UI may follow Codex Desktop patterns; **Pi remains the runtime**, and extra capabilities ship as bundled or user extensions/skills/packages—not a cloud agent platform.

Roadmap under these constraints: [PRODUCT_PLAN.md](./PRODUCT_PLAN.md). Feature boundary vs Codex-style workflow: [CODEX_PARITY.md](./CODEX_PARITY.md).

## Current capabilities

- Local workspaces with cross-repository session history, search, rename, archive/restore, recoverable deletion, clone, checkpoint fork, compaction, and HTML export
- Streaming text, reasoning, tool calls, tool output, retries, queue status, context usage, and cost/token metadata
- Runtime model and thinking-level selection
- Image inputs and local file references
- Pi slash commands, skills, prompt templates, and extension commands discovered through RPC
- Isolated Edge/Chrome browser automation for page inspection, interaction, and screenshots
- Native Windows computer use for desktop screenshots, visible-window discovery, focus, mouse clicks, text input, and key combinations
- MCP tool hosting for local STDIO and remote Streamable HTTP servers with dynamic tool discovery and approval gates
- Extension UI requests: confirmation, selection, text input, editor input, notifications, status, and widgets
- Codex-style permission modes backed by a Pi tool-interception extension
- Git working-tree summary, unified diff review pane, inline/new-chat review delivery, and configurable Git instructions
- Managed Git worktrees and worktree-scoped new chats
- Integrated Pi terminal with streaming output and optional exclusion from model context
- Native completion/approval notifications, prevent-sleep support, local token/cost usage aggregation, and custom instructions
- Full-screen settings center for appearance, notifications, personalization, shortcuts, archives, usage, models, Pi resources/packages, permissions, terminal, Git, worktrees, and advanced configuration
- Persisted process, appearance, behavior, provider, permission, Git, notification, and session settings

See [CODEX_PARITY.md](CODEX_PARITY.md) for the feature-by-feature boundary and [PRODUCT_PLAN.md](PRODUCT_PLAN.md) for what we will fill in locally. UI parity does **not** include cloud environments, account/billing, or a built-in OS sandbox; those stay out of scope or optional user isolation.

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

The bundled `computer` tool uses a native helper in the Pi Desktop executable. Screenshots and window listing are read-only; focusing windows, clicking, typing, and key presses use a separate approval gate by default and are blocked by `read-only` mode. Windows UIPI still prevents input into higher-integrity or protected windows, and Pi Desktop does not attempt to bypass it. Desktop screenshots can contain sensitive information.

The bundled MCP host supports newline-framed STDIO servers and Streamable HTTP servers using the current stable MCP protocol revision. Discovered server tools become first-class Pi tools. STDIO inherits a credential-filtered environment by default, HTTP supports explicit request headers, and all MCP calls can require approval. Server commands, environment values, and HTTP headers are stored in the local Pi Desktop settings file; use a restricted account or external secret manager for higher-assurance deployments.

## Important files

- `src/App.tsx` - desktop workspace composition
- `src/store.ts` - Pi protocol and conversation state machine
- `src/lib/pi.ts` - typed Tauri/RPC client
- `src/components/` - chat, composer, sessions, review, terminal, settings, and permission UI
- `src-tauri/src/lib.rs` - Tauri commands and persisted settings
- `src-tauri/src/pi/rpc.rs` - Pi process and JSONL transport
- `src-tauri/src/pi/sessions.rs` - session metadata and recoverable deletion
- `src-tauri/src/computer.rs` - native Windows screenshot, window, mouse, and keyboard bridge
- `src-tauri/resources/pidesktop-guard.ts` - project trust and permission gates
- `src-tauri/resources/pidesktop-computer.ts` - Pi computer tool and approval flow
- `src-tauri/resources/pidesktop-mcp.ts` - MCP lifecycle, transports, tool discovery, and Pi tool bridge

## Known platform boundary

The implemented scope covers the core local Codex-style coding workflow, including managed worktrees, isolated browser automation, approval-gated Windows computer use, and MCP tools. Cross-device handoff, true OS sandbox enforcement, remote/cloud execution, scheduled automations, MCP OAuth discovery, and richer MCP resources/prompts/tasks still require additional backends or protocol work.
