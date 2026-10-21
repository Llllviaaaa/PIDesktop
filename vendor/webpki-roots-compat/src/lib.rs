//! ureq 2.12.1 requires `webpki-roots ^0.26` and reads only `TLS_SERVER_ROOTS`.
//! 0.26.11 re-exports that symbol from `webpki-roots ^1`. This crate keeps the
//! package name and version Cargo expects, while the real roots come from the
//! patched 1.0.10 release (RUSTSEC-2026-0381).
pub use webpki_roots::TLS_SERVER_ROOTS;
