//! Tauri command handlers, grouped by the domain they act on.
//!
//! `lib.rs` owns process state and the Tauri builder; each module here owns one
//! slice of the command surface and the helpers only that slice needs.

pub(crate) mod desktop;
pub(crate) mod git;
pub(crate) mod memory;
pub(crate) mod packages;
pub(crate) mod project;
pub(crate) mod provider;
pub(crate) mod pull_request;
pub(crate) mod runtime;
pub(crate) mod schedule;
pub(crate) mod session;
pub(crate) mod settings;
pub(crate) mod usage;
pub(crate) mod workspace;
