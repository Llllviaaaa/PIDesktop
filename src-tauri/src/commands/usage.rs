//! Token and cost usage aggregated from session files.

use crate::*;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageSummary {
    pub(crate) sessions: u64,
    pub(crate) messages: u64,
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) reasoning_tokens: u64,
    pub(crate) cache_read_tokens: u64,
    pub(crate) cache_write_tokens: u64,
    pub(crate) total_tokens: u64,
    pub(crate) total_cost: f64,
}

// Scans every session file (seconds on large histories); run off the UI thread.
#[tauri::command(async)]
pub(crate) fn usage_summary(state: State<'_, AppState>) -> Result<UsageSummary, AppError> {
    use std::io::BufRead;

    // Copy what the scan needs; holding the settings lock here would stall chat starts and saves.
    let session_dir = state
        .settings
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?
        .session_dir
        .clone();
    let sessions = list_sessions(&session_dir);
    let mut summary = UsageSummary {
        sessions: sessions.len() as u64,
        ..UsageSummary::default()
    };
    for session in sessions {
        let Ok(file) = fs::File::open(session.file) else {
            continue;
        };
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if entry.get("type").and_then(|value| value.as_str()) != Some("message") {
                continue;
            }
            summary.messages += 1;
            if entry
                .pointer("/message/role")
                .and_then(|value| value.as_str())
                != Some("assistant")
            {
                continue;
            }
            let usage = entry.pointer("/message/usage");
            let tokens = |name: &str| {
                usage
                    .and_then(|value| value.get(name))
                    .and_then(|value| value.as_u64())
                    .unwrap_or(0)
            };
            summary.input_tokens += tokens("input");
            summary.output_tokens += tokens("output");
            summary.reasoning_tokens += tokens("reasoning");
            summary.cache_read_tokens += tokens("cacheRead");
            summary.cache_write_tokens += tokens("cacheWrite");
            summary.total_tokens += tokens("totalTokens");
            summary.total_cost += usage
                .and_then(|value| value.pointer("/cost/total"))
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0);
        }
    }
    Ok(summary)
}
