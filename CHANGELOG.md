# Changelog

Notable user-facing changes are documented in this file.

## Unreleased

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
