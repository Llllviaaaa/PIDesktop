# Dependency security baseline

This document records known dependency-audit findings that are not currently classified as exploitable vulnerabilities.

## RustSec baseline

`cargo-audit 0.22.2` reports no vulnerabilities for `src-tauri/Cargo.lock` as of 2026-08-27. It reports 17 allowed warnings:

- GTK3/GLib maintenance and soundness advisories are present in the cross-platform Tauri lockfile but do not enter the `x86_64-pc-windows-msvc` dependency tree.
- `proc-macro-error 1.0.4` is present only outside the Windows target tree.
- five unmaintained `unic-* 0.9.0` crates enter the Windows build through `urlpattern -> tauri-utils`; replacement depends on upstream Tauri dependencies.

CI runs `cargo audit` so new vulnerabilities fail the job. Maintenance warnings remain visible and should be re-evaluated whenever Tauri or its URL-pattern dependencies change.

### GLib `VariantStrIter` advisory

GitHub advisory `GHSA-wrw7-89jp-8q8g` / RustSec `RUSTSEC-2024-0429` affects
`glib >=0.15.0, <0.20.0`. The lockfile contains `glib 0.18.5` through Tauri's
Linux-only `gtk 0.18.2` dependency graph. Pi Desktop is a Windows application,
and the vulnerable crate is absent from the `x86_64-pc-windows-msvc` graph.

The Windows CI job checks that `cargo tree` contains no `glib` package for the
Windows target. The GitHub alert is classified as vulnerable code not used.
Remove that classification and this target guard when Tauri completes its GTK4
migration, or before adding a Linux release target; then require `glib >=0.20.0`.

To inspect target reachability:

```powershell
Set-Location src-tauri
cargo tree --locked --target x86_64-pc-windows-msvc -i <crate-name>
```

Do not add advisory ignores without documenting the affected target, dependency path, impact assessment, and removal condition here.

## License baseline

The 0.2.9 dependency graph was reviewed before the repository was made public. npm dependencies use permissive MIT, Apache, BSD/0BSD, BlueOak, ISC, or CC-BY licenses. Cargo dependencies are primarily MIT/Apache/BSD/ISC/Unicode/Zlib, with five MPL-2.0 packages and no dependency whose selected license expression requires GPL or AGPL distribution terms.

Re-run both ecosystem license inventories whenever a direct dependency is added or a lockfile changes substantially. Binary releases must continue to preserve all third-party copyright and license notices required by their selected dependency licenses.
