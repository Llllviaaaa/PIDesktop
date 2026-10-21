# Dependency security baseline

This document records known dependency-audit findings that are not currently classified as exploitable vulnerabilities.

## RustSec baseline

`cargo-audit 0.22.2` reports no vulnerabilities for `src-tauri/Cargo.lock` as of 2026-08-27. It reports 17 allowed warnings:

- GTK3/GLib maintenance and soundness advisories are present in the cross-platform Tauri lockfile but do not enter the `x86_64-pc-windows-msvc` dependency tree.
- `proc-macro-error 1.0.4` is present only outside the Windows target tree.
- five unmaintained `unic-* 0.9.0` crates enter the Windows build through `urlpattern -> tauri-utils`; replacement depends on upstream Tauri dependencies.

CI runs `cargo audit` so new vulnerabilities fail the job. Maintenance warnings remain visible and should be re-evaluated whenever Tauri or its URL-pattern dependencies change.

### TLS root and certificate verification advisories

`RUSTSEC-2026-0382` / `CVE-2026-111943` affects `rustls-webpki <0.103.16`.
`RUSTSEC-2026-0381` affects `webpki-roots <1.0.10`, including the `0.26.11`
compatibility crate. Both entered through `ureq 2.12.1` and `rustls 0.23.46`.

`ureq 2.12.1` has no later 2.x release and requires `webpki-roots ^0.26`. That
crate only re-exports `TLS_SERVER_ROOTS`, which is the only symbol `ureq` reads.
`src-tauri/Cargo.toml` pins `rustls-webpki` to `0.103.16` and `webpki-roots` 1.x
to `1.0.10`. crates.io has no patched 0.26 release, so `[patch.crates-io]`
replaces that package with `vendor/webpki-roots-compat`, which keeps the
required name and version and re-exports the patched 1.0.10 roots. `cargo audit`
ignores the local path package and sees only `webpki-roots 1.0.10`. Remove the
pin and patch when `ureq` depends on a patched release directly. Do not ignore
either advisory: the patched crates are on the Windows request path used by the
package marketplace and model discovery.

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
