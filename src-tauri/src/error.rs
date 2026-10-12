//! The error type commands hand back to the frontend.
//!
//! Commands used to return `Result<T, String>`, which gave the UI nothing to
//! branch on: a network timeout, a rejected path and a poisoned lock all
//! arrived as prose and all produced the same toast. `AppError` keeps the
//! message but adds a machine-readable kind, so the renderer can retry a
//! network failure, point at Settings for a permission problem, or refresh a
//! stale list.
//!
//! Serialised shape, which `src/lib/errors.ts` mirrors:
//!
//! ```json
//! { "kind": "git", "message": "not a git repository" }
//! ```
//!
//! Every command returns `AppError`, and each failure is classified where it
//! happens. `From<String>` still exists for the few internal helpers that keep
//! string errors (the native computer helper's protocol, workspace search);
//! a caller that lets one of those through with `?` gets [`AppError::Other`],
//! so map it to a real kind at the call site instead.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, Clone, thiserror::Error)]
pub(crate) enum AppError {
    /// A file or directory could not be read or written.
    #[error("{0}")]
    Io(String),
    /// The workspace, session, branch or record asked for does not exist.
    #[error("{0}")]
    NotFound(String),
    /// Arguments failed validation before any work started.
    #[error("{0}")]
    InvalidInput(String),
    /// Shared state was poisoned by a panic in another thread.
    #[error("{0}")]
    Locked(String),
    /// `git` or `gh` exited non-zero, or could not be launched.
    #[error("{0}")]
    Git(String),
    /// An HTTP request failed, timed out, or returned an error status.
    #[error("{0}")]
    Network(String),
    /// A child process could not be started or died unexpectedly.
    #[error("{0}")]
    Process(String),
    /// The user or a newer request cancelled the work. An expected outcome, not a fault.
    #[error("{0}")]
    Cancelled(String),
    /// Not yet classified. See the module docs.
    #[error("{0}")]
    Other(String),
}

impl AppError {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Io(_) => "io",
            Self::NotFound(_) => "notFound",
            Self::InvalidInput(_) => "invalidInput",
            Self::Locked(_) => "locked",
            Self::Git(_) => "git",
            Self::Network(_) => "network",
            Self::Process(_) => "process",
            Self::Cancelled(_) => "cancelled",
            Self::Other(_) => "other",
        }
    }

    /// Shared state was poisoned; the message names which lock it was.
    pub(crate) fn locked(what: &str) -> Self {
        Self::Locked(format!("{what} state lock poisoned"))
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        Self::Other(message.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        match error.kind() {
            std::io::ErrorKind::NotFound => Self::NotFound(error.to_string()),
            _ => Self::Io(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_kind_and_message_for_the_frontend() {
        let json = serde_json::to_string(&AppError::Git("not a git repository".into())).unwrap();
        assert_eq!(
            json, r#"{"kind":"git","message":"not a git repository"}"#,
            "src/lib/errors.ts parses exactly this shape"
        );
    }

    #[test]
    fn every_variant_has_a_distinct_kind() {
        let variants = [
            AppError::Io(String::new()),
            AppError::NotFound(String::new()),
            AppError::InvalidInput(String::new()),
            AppError::Locked(String::new()),
            AppError::Git(String::new()),
            AppError::Network(String::new()),
            AppError::Process(String::new()),
            AppError::Cancelled(String::new()),
            AppError::Other(String::new()),
        ];
        let kinds: std::collections::HashSet<_> = variants.iter().map(AppError::kind).collect();
        assert_eq!(kinds.len(), variants.len(), "kinds must round-trip 1:1");
    }

    #[test]
    fn a_missing_file_is_not_a_generic_io_failure() {
        let missing = std::io::Error::new(std::io::ErrorKind::NotFound, "no such file");
        assert_eq!(AppError::from(missing).kind(), "notFound");
        let denied = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        assert_eq!(AppError::from(denied).kind(), "io");
    }

    #[test]
    fn unconverted_string_errors_stay_visible_as_other() {
        assert_eq!(AppError::from("legacy".to_string()).kind(), "other");
    }

    #[test]
    fn locked_names_the_lock() {
        let error = AppError::locked("project");
        assert_eq!(error.kind(), "locked");
        assert_eq!(error.to_string(), "project state lock poisoned");
    }
}
