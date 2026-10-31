# Changelog

Notable user-facing changes are documented in this file.

## Unreleased

## 0.3.0

Tasks now run on Pi Desktop's own Harness Host instead of the bundled Pi. See `docs/RELEASE_0.3.0.md` for what moves where when upgrading from 0.2.x, and for the release checklist.

- Pi is no longer bundled. Sessions, model providers, keys, scheduled tasks and logs live under `~/.pid`; keys are encrypted with DPAPI in `~/.pid/secrets.dat`. Pi's own folder is only read, never changed.
- On first launch, custom providers from Pi's `models.json`, API keys from Pi's `auth.json`, your skills, themes and pets, and the desktop's scheduled tasks move over once. Pi's past tasks can be imported from the offer on first launch or later from 设置 › 已归档 › 导入到 Harness.
- OAuth sign-ins (subscription logins) are not supported: add an API key, or a `$VARIABLE` reference, for those providers in 设置 › 模型与连接. The page no longer shows a sign-in option.
- Fix: a provider without a key had no way to enter one in 设置 › 模型与连接, and a saved key could not be replaced or removed there.
- 检查连接 asks the provider for its model list instead of sending a prompt, so it costs nothing.
- If the Harness Host crashes, the app restarts it and reconnects, catching up on what the tasks logged meanwhile; a turn the crash cut off is marked as interrupted. A banner shows while reconnecting, and offers to start the Host again after repeated crashes.
- Idle tasks leave memory after ten minutes and load again when opened.
- The Host and the desktop log to `~/.pid/logs` (kept for a week, secrets redacted). 设置 › 调试 opens that folder and exports a diagnostics zip of the logs, versions and configuration for a bug report.
- The desktop no longer carries an HTTP client: `ureq`, `rustls`, `rusqlite`, `json5` and the vendored `webpki-roots` patch are gone from `src-tauri`.

## 0.2.29 - 2026-10-12

- Fix a model picked right after opening the app or starting a new task falling back to the default model once the first message was sent. The pick, and the thinking level, now stay with the task until its first message, including when sending moves the task to a worktree, quick chat or another project; a pick made while a saved session is still opening is applied to that session.
- Keep add-ons installed for the terminal `pi` out of desktop tasks. With 设置 → 高级 → 独立的 Pi 配置 turned on, Pi runs on PIDesktop's own config directory (`%APPDATA%/pid-desktop/pi-agent`) instead of `~/.pi/agent`, so the terminal's extensions, packages and skills are no longer loaded; they can add seconds to a task's first message and tens of kilobytes of tool definitions to every request. Turning it on for the first time copies your model providers, keys, trust decisions, themes and pets; from then on the two are maintained separately, and packages installed from the app stay in the app. Task history is unaffected. Off by default, and it applies to workspaces connected afterwards.
- Update the bundled Pi runtime from 0.84.0 to 1.1.0, which clears high-severity advisories in its `undici` and `brace-expansion` dependencies. Pi 1.x renamed the built-in Azure provider from `azure-openai-responses` to `azure`: an Azure sign-in saved under the old name needs `/login` again (custom providers using the `azure-openai-responses` API are unaffected). A provider saved without a model is no longer passed to Pi, which now rejects it.
- Commit and push without asking the agent. A Git button in the topbar reads 提交 while there are changes, then 推送 (with the number of commits ahead) or 发布分支 for a branch without an upstream; its menu shows the branch and how far it is ahead of or behind its remote. Review's 提交或推送 menu and the summary's 提交 row open the same dialog.
- The commit dialog commits what is staged when anything is; otherwise it lists every changed file to check or uncheck. Leave the message empty, or press 生成, and Pi drafts one from the diff in the repository's recent commit style (a one-shot prompt with no tools or session). On the default branch it offers to commit to a new branch instead, and 提交后推送 pushes right after. A failing hook shows its output in the dialog and leaves the index as it was.
- Pushing publishes a branch that has no upstream and never waits on a hidden terminal prompt; a push rejected because the remote moved says to pull first.
- The topbar's right side shows what changed instead of a second way into the sidebar. A `+N −M` count (or the number of changed files, for new files only) opens Review. The task-summary button is gone; the summary stays a sidebar tab and in 视图 → 任务摘要. The in-chat change count above the conversation moved up here.
- The open-in button names the editor it opens (the name is hidden when the sidebar is open or the window is narrow), is available on the new-task page, and opens the project with Ctrl+Shift+O or 文件 → 在 … 中打开. Ctrl+O still switches transcript density.
- The terminal button shows a dot while terminals keep running behind a hidden panel. The dot turns the accent color when a hidden terminal printed something (or exited) since you last looked, and the terminal tab that printed is marked the same way.
- The sidebar's focus button moved from the topbar into the sidebar's own tab strip, next to close.
- A side chat no longer shows up as an extra conversation after the app was closed abruptly (an installer upgrade, Task Manager, a crash). Side chats now keep their forked session outside Pi's session folder and remove it when they end; anything an earlier run left behind is cleared at startup.
- The plan no longer trails every later turn as a full card at the bottom of the chat. While a turn runs, its plan is one line above the composer (第 X/Y 步 and the current step) that expands upward; once the turn ends, the plan folds into that turn as a single row that expands in place.
- Rebuild the composer model picker: search, models grouped by provider, and a 思考等级 row that opens the reasoning levels. The level control is hidden for models that cannot reason, and a level chosen on the new-task page is applied once the task starts.
- Integrated terminals keep running when the terminal panel is hidden, the right sidebar switches tools, or you switch threads; only closing a tab ends its shell. The terminal now has one home, the bottom panel (Ctrl+J or Ctrl+`).
- Terminal tabs can use any installed shell (PowerShell, PowerShell 7, Command Prompt, Git Bash, WSL), search their output (Ctrl+F), copy and paste, open localhost links in the built-in browser, send the selection or recent output to the composer, and restart an exited shell with Enter. ANSI colors stay readable on light themes.
- Fix Ctrl+C doing nothing in the terminal when the app inherited "ignore Ctrl+C" from whatever launched it, CJK output garbled where it crossed a read boundary, the WSL shell setting starting PowerShell, and Git Bash resolving to WSL's bash.
- The right sidebar is a tab strip (摘要, 审查, 浏览器, 文件, 侧边聊天) instead of a launcher list, and every tool keeps its state when you switch.
- The task summary is a docked sidebar tab instead of a popover that closed on any click. Changes, the last turn and branch comparisons open in Review rather than in a second, read-only diff view.
- Review can stage, unstage or discard a single hunk, adds a 上一轮 scope that shows only what the latest agent turn changed (from Pi's turn checkpoints), and collects line comments so they are sent to Pi together.
- Review, the file tree and the file preview show CJK file names instead of Git's octal escapes, and their diffs load.
- Open in detects Zed, Sublime Text, Notepad++, Visual Studio and JetBrains IDEs alongside VS Code, Cursor, Windsurf and Antigravity, remembers the editor per project, opens files at a line, and opens the workspace in Windows Terminal, PowerShell, Command Prompt or Git Bash.
- Right-click a file path in chat, tool calls, Review, the file tree or the preview to preview it, open it in any detected editor at that line, reveal it in Explorer or copy its path; Ctrl+click opens it in the project's editor.
- The file preview shows line numbers and syntax highlighting and scrolls to the requested line.
- The built-in browser gains developer tools, a button that asks Pi to verify the page, reloading local pages after each agent turn, and an opt-in automatic verification after turns that changed files.

## 0.2.28 - 2026-09-23

- Run every filesystem, git, npm and HTTP command off the UI thread. 54 of 72 Tauri commands were synchronous, so a slow git repository, an unreachable model endpoint or an npm install could stall the window.
- Command failures now carry a kind (io, notFound, invalidInput, locked, git, network, process) instead of a bare string, so the interface can tell a retryable network problem from a rejected path.
- Type-check the bundled Pi extensions and the test suites, which previously shipped unchecked. This found a rewind checkpoint lookup calling a method Pi does not expose, a dropped error cause on MCP HTTP timeouts, and dead code left over from the move to the browser_* tools.
- Settings no longer shows a loading spinner forever when the archive or resource list fails to load.
- The file tree's refresh button now also reloads folders that are expanded, and reopening a panel shows its last contents immediately while refreshing.
- A diagram that appears more than once in a conversation is rendered once.
- Rebuild Settings → 模型 as a provider workspace: every Pi provider is listed with its connection status, subscriptions sign in through Pi's own login flow, API keys are saved to Pi's auth.json, and custom providers can fetch and pick models from their API, with context size and reasoning/image support filled in from Pi's model catalog or the model name.
- Move the default model and reasoning level onto the Models page, and let each model be shown or hidden in the composer model picker.
- Keep Settings responsive while usage statistics are calculated.
- Replace the bundled `computer` and `browser` tools with Grok-style `computer_*` and `browser_*` APIs, including observe/control sessions and inspect-ref page actions.

## 0.2.27 - 2026-09-04

- Refine chat messages, Markdown, code blocks, tables, and actions with a quieter DEEIX-inspired presentation across desktop layouts.
- Add validated rich-content panels for metrics, callouts, steps, comparisons, progress, bars, and curated links in interactive chats.
- Add provider model catalog discovery for supported APIs while preserving manually configured model metadata.

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
