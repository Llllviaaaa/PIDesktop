//! Primary-runtime reuse. Side chats never enter this function.
//!
//! The four lookups are the ones `pi_start` used to inline. Order matters:
//! an exact session wins over an idle empty runtime, and a streaming runtime
//! is never claimed.

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeSnapshot {
    pub(crate) runtime_id: String,
    pub(crate) cwd: String,
    pub(crate) session_file: Option<String>,
    pub(crate) is_streaming: bool,
    pub(crate) has_pending_extension: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Claimed {
    pub(crate) runtime_id: String,
    pub(crate) session_loaded: bool,
}

pub(crate) fn claim_primary(
    runtimes: &[RuntimeSnapshot],
    cwd: &str,
    session_file: Option<&str>,
) -> Option<Claimed> {
    let same_cwd = |runtime: &&RuntimeSnapshot| paths_equal(&runtime.cwd, cwd);
    let idle = |runtime: &&RuntimeSnapshot| !runtime.is_streaming && !runtime.has_pending_extension;

    if let Some(requested) = session_file {
        if let Some(runtime) = runtimes
            .iter()
            .find(|runtime| same_cwd(runtime) && runtime.session_file.as_deref() == Some(requested))
        {
            return Some(Claimed {
                runtime_id: runtime.runtime_id.clone(),
                session_loaded: true,
            });
        }
        if let Some(runtime) = runtimes
            .iter()
            .find(|runtime| same_cwd(runtime) && runtime.session_file.is_none() && idle(runtime))
        {
            return Some(Claimed {
                runtime_id: runtime.runtime_id.clone(),
                session_loaded: false,
            });
        }
        if let Some(runtime) = runtimes
            .iter()
            .find(|runtime| same_cwd(runtime) && idle(runtime))
        {
            return Some(Claimed {
                runtime_id: runtime.runtime_id.clone(),
                session_loaded: false,
            });
        }
        return None;
    }

    runtimes
        .iter()
        .find(|runtime| same_cwd(runtime) && runtime.session_file.is_none() && idle(runtime))
        .map(|runtime| Claimed {
            runtime_id: runtime.runtime_id.clone(),
            session_loaded: false,
        })
}

/// Empty idle runtimes that a newer warmup made redundant.
/// The current primary and the runtime just started are kept.
#[allow(dead_code)]
pub(crate) fn stale_warmups<'a>(
    runtimes: &'a [RuntimeSnapshot],
    started_runtime_id: &str,
    current_runtime_id: Option<&str>,
) -> Vec<&'a RuntimeSnapshot> {
    runtimes
        .iter()
        .filter(|runtime| {
            runtime.runtime_id != started_runtime_id
                && Some(runtime.runtime_id.as_str()) != current_runtime_id
                && runtime.session_file.is_none()
                && !runtime.is_streaming
                && !runtime.has_pending_extension
        })
        .collect()
}

fn paths_equal(left: &str, right: &str) -> bool {
    let normalize = |value: &str| value.trim_end_matches(['/', '\\']).to_lowercase();
    normalize(left) == normalize(right)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(
        id: &str,
        cwd: &str,
        session: Option<&str>,
        streaming: bool,
        pending: bool,
    ) -> RuntimeSnapshot {
        RuntimeSnapshot {
            runtime_id: id.to_string(),
            cwd: cwd.to_string(),
            session_file: session.map(str::to_string),
            is_streaming: streaming,
            has_pending_extension: pending,
        }
    }

    #[test]
    fn same_session_is_reused() {
        let runtimes = vec![runtime("a", "/work", Some("session.jsonl"), true, false)];
        let claimed = claim_primary(&runtimes, "/work/", Some("session.jsonl")).expect("hit");
        assert_eq!(claimed.runtime_id, "a");
        assert!(claimed.session_loaded);
    }

    #[test]
    fn requested_session_takes_over_an_idle_empty_runtime() {
        let runtimes = vec![
            runtime("busy", "/work", None, true, false),
            runtime("empty", "/work", None, false, false),
        ];
        let claimed = claim_primary(&runtimes, "/work", Some("next.jsonl")).expect("hit");
        assert_eq!(claimed.runtime_id, "empty");
        assert!(!claimed.session_loaded);
    }

    #[test]
    fn streaming_runtime_is_not_claimed_for_a_new_session() {
        let runtimes = vec![runtime("busy", "/work", Some("old.jsonl"), true, false)];
        assert!(claim_primary(&runtimes, "/work", Some("next.jsonl")).is_none());
    }

    #[test]
    fn bare_start_only_claims_an_idle_empty_runtime() {
        let runtimes = vec![
            runtime("loaded", "/work", Some("old.jsonl"), false, false),
            runtime("empty", "/work", None, false, false),
        ];
        let claimed = claim_primary(&runtimes, "/work", None).expect("hit");
        assert_eq!(claimed.runtime_id, "empty");
    }

    #[test]
    fn pending_extension_blocks_takeover() {
        let runtimes = vec![runtime("asking", "/work", None, false, true)];
        assert!(claim_primary(&runtimes, "/work", Some("next.jsonl")).is_none());
        assert!(claim_primary(&runtimes, "/work", None).is_none());
    }

    #[test]
    fn stale_warmups_keep_the_current_and_just_started_runtime() {
        let runtimes = vec![
            runtime("current", "/old", None, false, false),
            runtime("started", "/new", None, false, false),
            runtime("stale", "/other", None, false, false),
            runtime("live", "/other", Some("s.jsonl"), false, false),
            runtime("streaming", "/other", None, true, false),
        ];
        let stale = stale_warmups(&runtimes, "started", Some("current"));
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].runtime_id, "stale");
    }
}
