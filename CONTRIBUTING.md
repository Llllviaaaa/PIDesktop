# Contributing to Pi Desktop

Thank you for helping improve Pi Desktop. Keep changes focused, explain behavioral tradeoffs, and add tests in proportion to risk.

## Development setup

Pi Desktop currently targets Windows. You need:

- Node.js 22 or later and npm;
- a stable Rust MSVC toolchain;
- WebView2;
- Pi on `PATH`, or an absolute Pi executable configured in the app.

Install dependencies and run the desktop app:

```powershell
npm ci
npm run tauri -- dev
```

## Required checks

Run these before opening a pull request:

```powershell
npm run scan:secrets
npm audit --audit-level=high
npm run typecheck
npm run lint
npm run test:unit
npm run build

Set-Location src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

Changes to Tauri commands, permission rules, credential handling, browser/computer automation, MCP hosting, scheduling, or workspace mutation should include targeted regression tests.

## Language and user-facing copy

The application interface is Chinese. Code, comments, commit messages,
documentation and issues are English. There is no locale switcher and no
translation layer: about 1,360 user-facing strings are written inline, so
adding a second language is a product decision with real work behind it, not a
configuration change. Write new interface copy in Chinese, inline, the way the
surrounding code does.

Copy currently lives in three layers, which is worth knowing before adding
more:

| Layer | Strings | Notes |
| --- | --- | --- |
| Renderer (`src/**/*.tsx`) | ~1,220 | Where interface copy belongs. |
| Tauri commands (`src-tauri/src/**`) | ~62 | Error text the renderer shows verbatim. |
| Pi extensions (`src-tauri/resources/pidesktop-*.ts`) | ~81 | Approval prompts and tool output. |

Prefer keeping new copy in the renderer. A command that needs to explain a
failure should return the right `AppError` kind (see `src-tauri/src/error.rs`)
and let the renderer decide the wording; that keeps presentation in one layer
and is also the step that would make a second locale tractable later.

## Pull requests

- Describe the user-visible behavior and why the change is needed.
- Keep unrelated formatting and refactors out of the change.
- Include screenshots only for UI owned by this project or assets you have permission to redistribute.
- Do not commit real credentials, user data, local session files, private repository content, or machine-specific configuration.
- Update `README.md`, `SECURITY.md`, or the relevant document when a public contract changes.
- Note tests that were not run and explain why.

## Security issues

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md).
