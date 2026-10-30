# Pi Desktop

Pi Desktop is a **local-only**, Codex-style Windows desktop coding agent. Its engine is the **Harness Host**, a local process built from the `packages/` in this repository: one host serves every task, with the agent loop, tools, permissions, sessions, MCP, browser, computer use and scheduling as plugins. The UI may follow Codex Desktop patterns; it is not a cloud agent platform.

Pi Desktop began as a desktop client for the [Pi coding agent](https://pi.dev). Since 0.3 (the V2 refactor, [docs/REFACTOR_V2_PLAN.md](docs/REFACTOR_V2_PLAN.md)) it no longer runs or bundles Pi; Pi's providers, keys, skills, themes, pets and past tasks are imported once.

Pi Desktop is an independent community project. It is not affiliated with or endorsed by OpenAI. References to Codex describe interaction patterns and compatibility goals, not product ownership.

Roadmap under these constraints: [PRODUCT_PLAN.md](./PRODUCT_PLAN.md). Feature boundary vs Codex-style workflow: [CODEX_PARITY.md](./CODEX_PARITY.md).

## Current capabilities

- Local workspaces with cross-repository session history, search, rename, archive/restore, recoverable deletion, clone/fork, compaction, Markdown/HTML export, and message rewind with Git workspace restore
- Execute/Plan/Ask modes, persistent step tracking, editable follow-up queues, lifecycle Hooks, and bounded local subagents
- Ordered allow/confirm/block tool rules plus explicit local memory CRUD and approval-gated agent memory updates
- Streaming text, reasoning, tool calls, tool output, retries, queue status, context usage, and cost/token metadata
- Runtime model and thinking-level selection
- Image inputs and local file references
- Skills (`SKILL.md`) from `~/.pid/skills`, a project's `.pid/skills` and `.agents/skills`
- Grok-style browser control (`browser_navigate`, `browser_inspect`, `browser_click`, …) over a local Chromium session with inspect refs, screenshots, and approval gates
- Grok-style Windows computer use (`computer_start`, `computer_screenshot`, `computer_click`, …) with observe/control sessions, screen/window sources, and approval-gated input
- MCP hosting for local STDIO and remote Streamable HTTP servers with dynamic tools, live resource subscriptions, prompt templates, diagnostics, and approval gates
- Extension UI requests: confirmation, selection, text input, editor input, notifications, status, and widgets
- Codex-style permission modes enforced by the host's permissions plugin
- Git index/worktree summary, unified diff review, file stage/unstage/revert, line feedback into chat, and configurable Git instructions
- Managed Git worktrees and worktree-scoped new chats
- Multi-tab local PTY terminal with streaming output, lifecycle status, and optional exclusion from model context
- Local scheduled tasks with permission snapshots, pause/run-now controls, run history, and links back to generated sessions
- A one-time import of Pi's providers, API keys, skills, themes, pets and past tasks
- Native completion/approval notifications, prevent-sleep support, local token/cost usage aggregation, and custom instructions
- Full-screen settings center for appearance, notifications, personalization, shortcuts, archives, usage, models, skills, permissions, terminal, Git, worktrees, and advanced configuration
- Persisted process, appearance, behavior, provider, permission, Git, notification, and session settings

See [CODEX_PARITY.md](CODEX_PARITY.md) for the feature-by-feature boundary and [PRODUCT_PLAN.md](PRODUCT_PLAN.md) for what we will fill in locally. UI parity does **not** include cloud environments, account/billing, or a built-in OS sandbox; those stay out of scope or optional user isolation.

## Architecture

```text
React UI + Zustand state
        | JSON-RPC 2.0 over WebSocket (ADR 0002)      | Tauri invoke
Harness Host (pid-harness.exe, packages/host)    Rust desktop shell
        | cordis plugins: agent loop, tools, sessions, permissions, MCP, ...
```

The Rust shell owns the window, settings, secrets at rest, Git, terminals, the workspace file browser and the Host's process; it hands the Host its settings on stdin. The frontend talks to the Host directly for everything an agent does. Sessions are append-only JSONL logs under `~/.pid/sessions` (ADR 0004). Windows installers include the Host as one executable compiled with Bun, so end users need no Node.js. Design records: [docs/adr](docs/adr/README.md).

## Development

Prerequisites:

- Node.js 22 or later and npm
- Rust stable with the MSVC toolchain
- WebView2

`npm ci` installs the Host's packages and the pinned Bun compiler. Tauri dev/build commands build the Host executable automatically (`npm run prepare:harness-host`).

```powershell
npm ci
npm run tauri -- dev
```

Required checks:

```powershell
npm run scan:secrets
npm audit --audit-level=high
npm run typecheck
npm run lint
npm run test:unit
npm run build
```

Unit suites run under Vitest (`npm test`, or `npm run test:watch` while
working, `npm run test:coverage` for a report). `npm run test:unit` adds the
repository and Harness Host executable checks that CI also runs.

Desktop build:

```powershell
npm run tauri -- build
```

Rust tests:

```powershell
Set-Location src-tauri
cargo test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements, [docs/DEPENDENCY_SECURITY.md](docs/DEPENDENCY_SECURITY.md) for the current audit baseline, and [docs/RELEASING.md](docs/RELEASING.md) for the release checklist.

## Security model

Pi Desktop does not provide an operating-system sandbox. Its `read-only`, `ask`, and `workspace-write` modes are enforced by the host's permissions plugin, which blocks or confirms model-initiated tools before they run.

These approval gates are not an isolation boundary. Run untrusted or unattended work inside a container, VM, Windows Sandbox, or another policy-controlled environment. `full-access` gives the agent the permissions of the desktop user.

The bundled Grok-style `computer_*` tools use a native helper in the Pi Desktop executable. Observation (`computer_sources`, `computer_screenshot`, `computer_inspect`) is read-only. Interactive input requires `computer_start` in control mode, uses a separate approval gate by default, and is blocked by `read-only` mode. Windows UIPI still prevents input into higher-integrity or protected windows, and Pi Desktop does not attempt to bypass it. Desktop screenshots can contain sensitive information.

The bundled MCP host supports newline-framed STDIO servers and Streamable HTTP servers using the current stable MCP protocol revision. Discovered server tools become first-class agent tools. Servers that only expose resources or prompts are supported too; the agent can list/read and subscribe to resources, receive STDIO or HTTP SSE change notifications, and list/resolve prompt templates, while users can inspect them with `/mcp-resources`, `/mcp-read`, and `/mcp-prompts`. STDIO inherits a credential-filtered environment by default, HTTP supports explicit request headers, and MCP calls can require approval. Server commands, environment values, and HTTP headers are stored locally; use a restricted account or external secret manager for higher-assurance deployments.

Scheduled tasks are intentionally local. The Harness Host runs them only while the computer and Pi Desktop are running, never accepts silent `full-access`, and stores tasks and runs in `~/.pid/schedules.json` and `~/.pid/schedule-runs.jsonl`.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not include credentials, private workspace content, or exploit details in public issues.

## Important files

- `src/App.tsx` - desktop workspace composition
- `src/store/` - app state in four slices (runtime, sessions, transcript, ui) with their actions; `selectors.ts` reads them by slice
- `src/lib/harnessRuntime.ts` - the frontend's link to the Harness Host's sessions (ADR 0014)
- `src/lib/agent.ts` - typed client for the Rust shell and the Host
- `src/lib/transcript.ts` - the conversation from the Host's session events
- `src/components/` - chat, composer, sessions, review, terminal, settings, and permission UI
- `src-tauri/src/lib.rs` - Tauri commands and persisted settings
- `src-tauri/src/harness_host.rs` - starting the Harness Host and handing it the settings
- `src-tauri/src/computer.rs` - native Windows screenshot, window, mouse, and keyboard bridge
- `packages/host` - the Harness Host process: RPC, plugin wiring, settings and imports
- `packages/agent-loop`, `packages/session`, `packages/llm*` - the agent loop, session logs and model adapters
- `packages/permissions`, `packages/browser`, `packages/computer`, `packages/mcp` - permission gates, browser_*, computer_* and MCP
- `scripts/prepare-harness-host.mjs` - builds the Host executable

## Known platform boundary

The implemented scope covers the core local Codex-style coding workflow, including managed worktrees, local scheduling, multi-tab terminal sessions, Grok-style browser control, approval-gated Windows computer use, and MCP tools/resources/prompts/subscriptions. Cross-device handoff, true OS sandbox enforcement, remote/cloud execution, account/billing features, MCP OAuth discovery, and experimental MCP task flows remain out of scope or optional follow-up work. See [docs/LOCAL_CAPABILITIES.md](docs/LOCAL_CAPABILITIES.md) for the complete local boundary.

## License

Pi Desktop is licensed under the [Apache License 2.0](LICENSE).
