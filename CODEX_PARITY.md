# Codex parity map

This file is the product contract for Pi Desktop. A feature is only marked **Implemented** when a real frontend action reaches a real local backend; visual placeholders do not count.

| Area | Status | Pi Desktop behavior |
| --- | --- | --- |
| Project workspace and conversation UI | Implemented | Codex-style sidebar, project grouping, chat stream, composer, inspector, terminal, and settings center |
| Streaming agent runtime | Implemented | Pi JSONL RPC events for text, reasoning, tools, tool output, retries, queue state, tokens, and cost |
| Parallel local tasks | Implemented | Per-task Pi runtimes keep chats running in the background, preserve task-specific streaming and approval state, and allow instant task switching |
| Task continuity | Implemented | Frontend reloads rediscover live runtimes and pending approvals; full app restarts reopen the last saved Pi session when task restore is enabled |
| Sessions | Implemented | Search, resume, rename, clone, checkpoint fork, compact, export, archive/restore, and recoverable delete |
| Models and reasoning | Implemented | Provider/model/thinking selection backed by Pi runtime commands and persisted defaults |
| Attachments and references | Implemented | Image attachment plus local file reference insertion |
| Skills, prompts, and extensions | Implemented | Runtime discovery, inventory, and Pi package install/update/remove |
| Extension UI bridge | Implemented | Confirm, select, input, editor, notify, status, and widget requests |
| Local instructions and memory control | Implemented | Personality, custom system instructions, suggested prompts, and Pi context-file enable/disable |
| Git changes and review | Implemented | Status, unified diff, inline/new-chat review delivery, and configurable review/Git instructions |
| Git worktrees | Implemented | List, create, open, and start worktree-scoped chats |
| Notifications and wake lock | Implemented | Native completion/approval notifications and Windows prevent-sleep behavior |
| Usage | Implemented | Local Pi session aggregation for message count, tokens, and recorded cost |
| Settings | Implemented | Searchable multi-page center covering personal, integration, coding, and advanced areas |
| Permissions | Partial | Pi tool interception provides read-only/ask/workspace-write/full-access modes, but is not an OS isolation boundary |
| Terminal | Partial | Integrated streaming shell exists; Codex's full terminal profile and policy integration is not reproduced |
| Handoff | Partial | Chats can be cloned/forked and worktrees can be opened, but there is no cross-device or cloud handoff service |
| MCP | Platform gap | Pi has no first-class MCP host; implementing this requires a separate protocol host and tool bridge |
| Browser and computer-use | Platform gap | Requires a browser automation/computer-control runtime and permission layer |
| Cloud environments | Platform gap | Requires remote workers, secrets, repositories, images, logs, and lifecycle APIs |
| Scheduled automations | Platform gap | Requires a durable scheduler and unattended execution service |
| OS sandbox | Platform gap | Approval gates are implemented; process/filesystem/network isolation requires Windows Sandbox, a VM, or containers |
| Account, billing, and organization policy | Platform gap | These are OpenAI service capabilities and are not Pi runtime features |

## Product rule

New Codex-like pages must be wired to a real capability before they are presented as supported. Platform gaps should remain explicit until the necessary backend exists.
