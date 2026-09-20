//! Tauri command handlers, grouped by the domain they act on.
//!
//! `lib.rs` owns process state and the Tauri builder; each module here owns one
//! slice of the command surface and the helpers only that slice needs.

pub(crate) mod git;
pub(crate) mod memory;
pub(crate) mod project;
