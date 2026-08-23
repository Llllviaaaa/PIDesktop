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
npm run test:unit
npm run build

Set-Location src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

Changes to Tauri commands, permission rules, credential handling, browser/computer automation, MCP hosting, scheduling, or workspace mutation should include targeted regression tests.

## Pull requests

- Describe the user-visible behavior and why the change is needed.
- Keep unrelated formatting and refactors out of the change.
- Include screenshots only for UI owned by this project or assets you have permission to redistribute.
- Do not commit real credentials, user data, local session files, private repository content, or machine-specific configuration.
- Update `README.md`, `SECURITY.md`, or the relevant document when a public contract changes.
- Note tests that were not run and explain why.

## Security issues

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md).
