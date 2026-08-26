# Changelog

Notable user-facing changes are documented in this file.

## Unreleased

## 0.2.22 - 2026-08-26

- Rebuild the Windows distribution from the current Review workspace implementation and bundled Pi Runtime.

## 0.2.21 - 2026-08-26

- Rebuild Review as a Codex-style Git workspace with uncommitted, staged, unstaged, branch, and commit sources, persistent file navigation, diff controls, and working stage/unstage/revert actions.
- Add separate model review actions for uncommitted changes and base-branch comparisons, plus parsed inline `code-comment` findings that link review feedback to exact files and lines.

## 0.2.20 - 2026-08-26

- Rebuild side chat as a full Pi conversation with attachments, model and thinking controls, permission and work modes, tool output, and context usage.
- Keep temporary side chats alive while the right panel is hidden, support multiple side chats per task, and expose their real status in the task summary.
- Filter side-chat sessions out of normal task history and clean their recoverable session files when a side chat closes or the app exits.
- Add explicit starting, failed, and expired states while preserving parent-task context without changing the main conversation.

## 0.2.19 - 2026-08-26

- Keep side chat available when its parent session file has been moved or removed by opening an independent temporary conversation instead.
- Track and clean up every temporary side-chat session, including sessions that were not forked from a parent conversation.
- Align the MCP client handshake version with the desktop release version.

## 0.2.15 - 2026-08-25

- Count and display only real `delegate_task` child agents in the inspector, with per-task queued, running, completed, and failed states.
- Replace placeholder inspector rows with a real task summary for plans, outputs, background processes, sources, and workspace tool navigation.

## 0.2.14 - 2026-08-25

- Replace the application icon with a compact geometric Pi and terminal-cursor mark that remains legible at Windows taskbar sizes.

## 0.2.13 - 2026-08-24

- Bundle Pi 0.84.0 as a validated standalone runtime so core desktop workflows no longer require a global Node.js or Pi installation.
- Keep explicit Pi executable settings as an advanced override and publish bundled runtime license metadata.

## 0.2.12 - 2026-08-24

- Keep the model selector in the right-side action group, directly beside the send button.

## 0.2.11 - 2026-08-24

- Keep the model selector next to the task mode and permission controls while the send button remains right-aligned.

## 0.2.10 - 2026-08-24

- Keep long conversations responsive by isolating message subscriptions and rendering bounded history windows.
- Harden Pi process shutdown, scheduled runs, permission rules, secret redaction, and workspace file search.
- Fix local Markdown file links and split shared Pi RPC/tool routing into independently tested modules.
- Rebuild Windows installers in the project target directory so release artifacts cannot be confused with stale packages.

## 0.2.9 - 2026-08-23

- Prepare repository governance, CI, dependency review, and security documentation for a public release.
- Remove redistributed third-party UI reference images while preserving upstream source links.
- Add a restrictive Tauri content security policy for the main application WebView.
- Use a stable reverse-domain bundle identifier for future public releases.

## 0.2.8 - 2026-08-23

- Edit user messages in place before rewinding and resending the conversation.
- Keep the active sidebar and header session titles consistent.
- Add local agent plans, hooks, memory, subagents, managed follow-ups, checkpoints, and expanded MCP support.
