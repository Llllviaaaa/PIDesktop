# Release process

Pi Desktop is a Windows desktop application with security-sensitive local capabilities. A release should be reproducible from a clean checkout and should not rely on an already-running development build.

## Preconditions

- The worktree is clean and the release commit is pushed.
- A project license is present in `LICENSE` and package metadata matches it.
- `CHANGELOG.md` describes the release.
- CI, secret scanning, dependency review, and Rust advisory scanning pass.
- Any bundled visual or media asset has documented redistribution rights.
- `THIRD_PARTY_NOTICES.md` matches what the installer redistributes (the Harness Host executable compiled with the pinned Bun).

## Version consistency

Update the same version in:

- `package.json` and the root package in `package-lock.json`;
- `src-tauri/Cargo.toml` and the `pid-desktop` package in `src-tauri/Cargo.lock`;
- `src-tauri/tauri.conf.json`;
- bundled MCP client metadata in `src-tauri/resources/pidesktop-mcp.ts`.

Do not replace an existing release while keeping the same version number.

## Verification

```powershell
npm ci
npm run scan:secrets
npm audit --audit-level=high
npm run test:unit
npm run build
npm run prepare:harness-host

Set-Location src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cargo audit --file Cargo.lock
Set-Location ..

npm run tauri -- build
```

Verify the executable product version and calculate SHA-256 hashes for the executable, MSI, and NSIS installer. Publish hashes with the release notes.

Extract or administratively expand one installer and check `harness/build-manifest.json` against the commit being released, then start the desktop with a sanitized `PATH`: it must reach the bundled Harness Host (`harness/pid-harness.exe`) without Node.js or Bun on the machine.

## Signing

Public Windows binaries should be Authenticode-signed with a protected signing identity. Sign both `pid-desktop.exe` and the generated `harness/pid-harness.exe` before producing the signed installer. Keep signing credentials outside the repository and CI logs. Configure CI signing only through encrypted repository or environment secrets with restricted release permissions.

Unsigned development builds may be shared for testing only when clearly labeled as unsigned.

## Artifacts

Tauri writes artifacts under the active Cargo target directory. Publish only artifacts produced from the release commit. Do not commit `dist`, `src-tauri/target`, installers, local logs, session files, or credentials to the source repository.
