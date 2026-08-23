# Codex parity map

This file is the product contract for Pi Desktop. A feature is only marked **Implemented** when a real frontend action reaches a real local backend; visual placeholders do not count.

**Product frame:** Pi Desktop is a **local-only** command center for the [Pi](https://pi.dev) coding agent. UI may follow Codex-style desktop workflow; semantics stay **Pi-native** (RPC runtime, extensions/skills/packages, no cloud execution). See [PRODUCT_PLAN.md](./PRODUCT_PLAN.md) for the fill-in roadmap under those constraints.

| Area | Status | Pi Desktop behavior |
| --- | --- | --- |
| Project workspace and conversation UI | Implemented | Codex-style sidebar, project grouping, chat stream, composer, inspector, terminal, and settings center |
| Streaming agent runtime | Implemented | Pi JSONL RPC events for text, reasoning, tools, tool output, retries, queue state, tokens, and cost |
| Parallel local tasks | Implemented | Per-task Pi runtimes keep chats running in the background, preserve task-specific streaming and approval state, and allow instant task switching |
| Task continuity | Implemented | Frontend reloads rediscover live runtimes and pending approvals; full app restarts reopen the last saved Pi session when task restore is enabled |
| Sessions | Implemented | Search, resume, rename, clone, checkpoint fork, compact, Markdown/HTML export, archive/restore, recoverable delete, and edit-and-rewind with workspace restore |
| Models and reasoning | Implemented | Provider/model/thinking selection backed by Pi runtime commands and persisted defaults |
| Attachments and references | Implemented | Image attachment plus local file reference insertion |
| Skills, prompts, and extensions | Implemented | Home resource center discovers local resources and installs/updates/removes Pi packages from npm, Git, or local paths; granular package filters remain available through Pi config |
| Extension UI bridge | Implemented | Confirm, select, input, editor, notify, status, and widget requests |
| Local instructions and memory control | Implemented | Personality, custom instructions, context-file control, local memory CRUD/export/delete, and approval-gated agent memory updates |
| Agent modes and plans | Implemented | Execute/Plan/Ask switch at runtime; Plan and Ask are read-only; `update_plan` persists branch-local steps and restores the plan widget |
| Follow-up queue management | Implemented | Follow-ups can be inspected, reordered, deleted, or promoted to immediate steering; stop suppresses automatic queue draining |
| Workspace rewind checkpoints | Implemented | Each writable turn captures tracked/non-ignored files and the real index independently; message edit restores both without deleting the old conversation branch |
| Lifecycle hooks | Implemented | Configurable local commands for session/agent/tool events with JSON stdin, timeout, environment filtering, and pre-tool blocking |
| Local subagents | Implemented | Optional `delegate_task` extension runs isolated explorer/planner/reviewer/worker Pi contexts with bounded parallelism and permission gating |
| Git changes and review | Implemented | Index/worktree status, unified diff, file stage/unstage/revert, line feedback into the current chat, inline/new-chat review delivery, and configurable Git instructions |
| Git worktrees | Implemented | List, create, open, and start worktree-scoped chats |
| Browser automation | Implemented | Bundled Pi browser tool drives an isolated local Edge/Chrome session through CDP for page inspection, clicks, typing, and screenshots with approval gates |
| OS computer-use | Implemented | Native Windows helper captures the virtual desktop, lists/focuses visible windows, and sends approval-gated mouse, text, and key input; read-only mode blocks interactive actions and Windows UIPI remains enforced |
| MCP tools | Implemented | MCP 2025-11-25 lifecycle with local STDIO and remote Streamable HTTP transports, dynamic tool registration, pagination, images/embedded resource results, cancellation, environment filtering, and approval gates |
| Notifications and wake lock | Implemented | Native completion/approval notifications and Windows prevent-sleep behavior |
| Usage | Implemented | Local Pi session aggregation for message count, tokens, and recorded cost |
| Settings | Implemented | Searchable multi-page center covering personal, integration, coding, and advanced areas |
| Permissions | Partial | Pi tool interception provides read-only/ask/workspace-write/full-access modes, but is not an OS isolation boundary |
| Terminal | Implemented (local) | Multiple real PTY tabs, streaming output, active/exited status, close/new-tab interactions, and optional exclusion from model context |
| Handoff | Partial (local only) | Local clone/fork/worktree only; cross-device or cloud handoff is intentionally out of scope |
| MCP resources and prompts | Implemented (local core) | Capability-aware servers may expose no tools; Pi tools and slash commands list/read resources and list/resolve prompts with pagination and approval gates |
| MCP resource subscriptions | Implemented | `resources/subscribe` / `unsubscribe`, STDIO notifications, Streamable HTTP SSE reconnect, subscribed-resource refresh, and list-change notices |
| MCP OAuth and tasks | Partial | Automatic OAuth discovery and experimental MCP task flows remain optional protocol work |
| Session tree UX | Implemented | Inspector 会话树 loads Pi `get_tree`; 从此继续 issues `fork` for the selected entry id; clear error if runtime lacks `get_tree` |
| Configurable tool rules | Implemented | Ordered allow/confirm/block rules with tool globs and optional command/path scopes, plus shell defaults and outside-workspace protection |
| Review pane depth | Implemented | File-level stage/unstage/revert, index/worktree separation, diff navigation, and line comments back into the current chat |
| Scheduled automations | Implemented (local) | Native in-app scheduler spawns non-interactive Pi locally, stores SQLite history, supports pause/run-now, links results to sessions, snapshots safe permissions, and runs only while the app/computer is running |
| Cloud environments | Out of scope | Remote workers and hosted agent fleets are not part of this product |
| OS sandbox | Out of scope as built-in | Pi has no OS sandbox in core; Desktop provides approval gates. Strong isolation remains the user's container/VM/Windows Sandbox (optional local wizard later) |
| Account, billing, and organization policy | Out of scope | OpenAI/ChatGPT service capabilities; not Pi Desktop features |

## Product rule

New Codex-like pages must be wired to a real capability before they are presented as supported. **Out of scope** items stay explicit and must not ship as empty hubs. Local **Planned** items land only with a real backend (see PRODUCT_PLAN.md).
