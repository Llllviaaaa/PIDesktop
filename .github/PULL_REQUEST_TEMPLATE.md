## Summary

Describe the user-visible change and the reason for it.

## Risk

Describe affected security boundaries, data formats, runtime behavior, or compatibility concerns.

## Verification

- [ ] `npm run scan:secrets`
- [ ] `npm run test:unit`
- [ ] `npm run build`
- [ ] `cargo fmt --all -- --check` in `src-tauri`
- [ ] `cargo clippy --all-targets --locked -- -D warnings` in `src-tauri`
- [ ] `cargo test --locked` in `src-tauri`
- [ ] UI behavior was checked when applicable

List any check that was not run and explain why.

## Assets and data

- [ ] No credentials, private user data, machine-specific configuration, or unlicensed third-party assets are included.
