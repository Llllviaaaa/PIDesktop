# Local agent parity audit

Assessed on 2026-08-23 against the current public documentation for [OpenAI Codex](https://developers.openai.com/codex/), [Claude Code](https://code.claude.com/docs/en/features-overview), [Cursor](https://docs.cursor.com/chat/overview), [Gemini CLI](https://geminicli.com/docs/), and [GitHub Copilot coding agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent).

Pi Desktop is a local Pi client. “Parity” below means the local coding workflow is genuinely wired end to end; it does not mean reproducing cloud hosting, account systems, or vendor-specific services.

| Capability | Status | Pi Desktop evidence and boundary |
| --- | --- | --- |
| Projects, task history, search, rename, archive and recoverable delete | Complete | Real Pi JSONL sessions grouped by workspace; archive and trash operations are local |
| Multiple concurrent tasks | Complete | Independent live Pi runtimes, background completion/approval notifications, task restore, and task switching |
| Worktree isolation | Complete | Create/list/open worktrees and start a task in an isolated checkout |
| Streaming answer, reasoning and tool progress | Complete | RPC message deltas keep answer text, thinking, tool state, retries and duration separate |
| Models and thinking levels | Complete | Runtime-backed provider/model selection and all Pi reasoning levels |
| Execute, Plan and Ask modes | Complete | Per-task runtime mode switching; Plan/Ask impose a read-only hard cap |
| Persistent plans and todos | Complete | Bundled `update_plan` tool stores branch-local step state and restores its desktop widget |
| Steering and follow-up queues | Complete | Immediate steering plus a managed follow-up queue with inspect, reorder, delete and promote-to-steer actions |
| Edit an earlier message | Complete | Rewinds the Pi session branch and Git workspace checkpoint, then resends from that point |
| Workspace checkpoints | Complete | Captures worktree and index separately without mutating the real index; ignored files remain untouched; refs retain the newest 250 snapshots |
| Conversation forks and checkpoints | Complete | Clone, fork, tree inspection and continue-from-node use Pi session primitives |
| Conversation export | Complete | Readable Markdown and Pi HTML export |
| Git review loop | Complete | Index/worktree diff, stage, unstage, revert, line feedback, review prompt and PR workflow |
| Integrated terminal | Complete | Multiple real PTY tabs, streaming output, abort and optional context exclusion |
| Browser automation | Complete (local) | Isolated Chromium/Edge profile, inspect/click/type/screenshot and approval controls |
| Computer use | Complete (Windows) | Native screenshot/window/mouse/keyboard bridge with approval and UIPI boundary |
| Skills, prompts, extensions and packages | Complete | Local/project discovery plus npm, Git and local package lifecycle |
| Lifecycle hooks | Complete | Six lifecycle events, JSON stdin, timeout, filtered environment and optional pre-tool blocking |
| Local subagents | Complete | Bundled `delegate_task` runs isolated Pi contexts for exploration, planning, review and workers; up to 8 tasks with 1-4 concurrency and cancellation |
| Fine-grained permissions | Complete as an approval layer | Read-only/ask/workspace/full modes, ordered allow/confirm/block rules, glob tool matching and optional command/path scopes |
| Local memory | Complete | User CRUD/export/delete plus approval-gated `desktop_memory`; only explicit durable preferences should be stored |
| MCP tools/resources/prompts | Complete for core protocol | STDIO and Streamable HTTP, pagination, cancellation, images/resources/prompts, encrypted credentials and diagnostics |
| MCP resource subscriptions | Complete | Explicit subscribe/unsubscribe tools, STDIO notifications, Streamable HTTP SSE reconnect, live resource refresh and resource/prompt/tool list-change notices |
| MCP OAuth and protocol tasks | Partial | Static protected headers/tokens work; automatic OAuth discovery and experimental task flows are not implemented |
| Scheduled tasks | Complete while app is running | Native SQLite schedule/history, safe permission snapshots, pause and run-now; it does not run while the computer/app is off |
| IDE integration | Partial | Open files/workspaces in supported editors; no editor-extension channel for live selection/diagnostics |
| OS sandbox | External boundary | Approval rules are not an OS sandbox. Use a worktree plus a container, VM or Windows Sandbox for hostile code |
| Remote/cloud agents and cross-device handoff | Product boundary | Deliberately excluded from this local-only product; local runtimes, clones and worktrees are the replacement |
| Vendor accounts, billing, enterprise policy and hosted connectors | Product boundary | Deliberately excluded; provider credentials and all Pi Desktop state remain local |
| Voice, hosted image generation and hosted Sites deployment | Product boundary | Not part of the local coding-agent loop; browser and local preview workflows remain available |

## Acceptance coverage

Automated coverage includes permission/mode rules, message rewind, workspace checkpoint capture/restore/retention, managed queue ordering, plan validation, hooks validation, subagent task validation, memory updates, session trees, Git diff/index behavior, conversation history/export, scheduler behavior, model switching, runtime disconnects, navigation, pull requests and secret redaction.

Desktop browser QA covers the composer, permission menu, managed queue and Settings pages at 1280x720 and 390x844. Rust library tests cover the native scheduler, sessions, Git, settings, MCP credential handling, provider configuration, Markdown export and Windows helper logic.

## Honest residual risks

- The permission layer intercepts Pi tools but cannot contain an already-compromised executable. Strong isolation requires an OS/container boundary.
- MCP servers are third-party programs or services with their own authority. “Trusted read-only” is a user assertion, not verification.
- Child agents share the same physical workspace when granted `workspace-write`; use worktrees for parallel write-heavy tasks.
- A checkpoint excludes ignored files by design, so editing an ignored generated or secret file is not rewound.
