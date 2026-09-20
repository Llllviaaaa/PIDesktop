//! Session listing, history, archiving and deletion.
//!
//! Sessions are JSONL files Pi owns; these commands read and move them, so they
//! all run off the main thread.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::pi::session_display::collapse_unchanged_session_forks;
use crate::pi::sessions::{
    list_sessions, parse_session_file, session_history, session_message_timings, session_messages,
    trash_session, validate_session_path, SessionHistory, SessionInfo, SessionMessageTiming,
};
use crate::{paths_equal, save_settings, AppState};

#[tauri::command(async)]
pub(crate) fn list_sessions_cmd(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .clone();
    let (ephemeral_sessions, active_primary_sessions) = {
        let runtimes = state
            .runtimes
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        let ephemeral = runtimes
            .values()
            .filter(|runtime| runtime.isolated)
            .filter_map(|runtime| runtime.session_file.clone())
            .collect::<Vec<_>>();
        let primary = runtimes
            .values()
            .filter(|runtime| !runtime.isolated)
            .filter_map(|runtime| runtime.session_file.clone())
            .collect::<Vec<_>>();
        (ephemeral, primary)
    };
    let archived = &settings.archived_sessions;
    let sessions = list_sessions(&settings.session_dir)
        .into_iter()
        .filter(|session| !archived.iter().any(|file| file == &session.file))
        .filter(|session| {
            !ephemeral_sessions
                .iter()
                .any(|file| paths_equal(file, &session.file))
        })
        .collect();
    Ok(collapse_unchanged_session_forks(
        &settings.session_dir,
        sessions,
        &active_primary_sessions,
    ))
}

#[tauri::command(async)]
pub(crate) fn session_message_timings_cmd(
    state: State<'_, AppState>,
    file: String,
) -> Result<Vec<SessionMessageTiming>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    session_message_timings(&settings.session_dir, &file)
}

#[tauri::command(async)]
pub(crate) fn session_messages_cmd(
    state: State<'_, AppState>,
    file: String,
) -> Result<Vec<serde_json::Value>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    session_messages(&settings.session_dir, &file)
}

#[tauri::command(async)]
pub(crate) fn session_history_cmd(
    state: State<'_, AppState>,
    file: String,
) -> Result<SessionHistory, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    session_history(&settings.session_dir, &file)
}

pub(crate) fn session_message_markdown(message: &serde_json::Value) -> Option<(String, String)> {
    let role = message.get("role")?.as_str()?;
    let heading = match role {
        "user" => "User",
        "assistant" => "Assistant",
        _ => return None,
    };
    let content = message.get("content")?;
    let text = match content {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(serde_json::Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    (!text.trim().is_empty()).then(|| (heading.to_string(), text.trim().to_string()))
}

pub(crate) fn session_history_markdown(history: &SessionHistory) -> String {
    let mut output = String::from("# PIDesktop conversation\n\n");
    for message in &history.messages {
        let Some((heading, text)) = session_message_markdown(message) else {
            continue;
        };
        output.push_str(&format!("## {heading}\n\n{text}\n\n"));
    }
    output
}

#[tauri::command(async)]
pub(crate) fn export_session_markdown(
    state: State<'_, AppState>,
    file: String,
    destination: String,
) -> Result<String, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .clone();
    let history = session_history(&settings.session_dir, &file)?;
    let destination = PathBuf::from(destination.trim());
    if destination.as_os_str().is_empty() {
        return Err("conversation export path is required".to_string());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create conversation export directory: {err}"))?;
    }
    fs::write(&destination, session_history_markdown(&history))
        .map_err(|err| format!("failed to export conversation: {err}"))?;
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command(async)]
pub(crate) fn list_archived_sessions_cmd(
    state: State<'_, AppState>,
) -> Result<Vec<SessionInfo>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    Ok(settings
        .archived_sessions
        .iter()
        .filter_map(|file| parse_session_file(Path::new(file)))
        .collect())
}

#[tauri::command(async)]
pub(crate) fn archive_session_cmd(state: State<'_, AppState>, file: String) -> Result<(), String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    validate_session_path(&settings.session_dir, &file)?;
    let normalized = file;
    if !settings.archived_sessions.contains(&normalized) {
        settings.archived_sessions.push(normalized);
        save_settings(&settings)?;
    }
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn restore_session_cmd(state: State<'_, AppState>, file: String) -> Result<(), String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    settings.archived_sessions.retain(|entry| entry != &file);
    save_settings(&settings)
}

#[tauri::command(async)]
pub(crate) fn delete_session_cmd(state: State<'_, AppState>, file: String) -> Result<(), String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    trash_session(&settings.session_dir, &file)
}
