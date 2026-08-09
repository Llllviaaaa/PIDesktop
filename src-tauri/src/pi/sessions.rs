use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub file: String,
    pub session_id: String,
    pub cwd: String,
    pub name: Option<String>,
    pub first_message: Option<String>,
    pub message_count: usize,
    pub created_at: Option<String>,
    pub updated_at: Option<u64>,
}

pub fn default_sessions_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".pi").join("agent").join("sessions"))
}

pub fn resolve_sessions_root(configured: &str) -> Option<PathBuf> {
    if configured.trim().is_empty() {
        return default_sessions_root();
    }

    let value = configured.trim();
    if value == "~" {
        return dirs::home_dir();
    }
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return dirs::home_dir().map(|home| home.join(rest));
    }
    Some(PathBuf::from(value))
}

pub fn list_sessions(configured_root: &str) -> Vec<SessionInfo> {
    let Some(root) = resolve_sessions_root(configured_root) else {
        return Vec::new();
    };

    let mut files = Vec::new();
    collect_jsonl_files(&root, &mut files, 0);
    let mut sessions: Vec<_> = files
        .iter()
        .filter_map(|path| parse_session_file(path))
        .collect();

    sessions.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.created_at.cmp(&a.created_at))
            .then_with(|| b.file.cmp(&a.file))
    });
    sessions
}

fn collect_jsonl_files(root: &Path, files: &mut Vec<PathBuf>, depth: usize) {
    if depth > 5 || root.file_name().and_then(|value| value.to_str()) == Some(".trash") {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, files, depth + 1);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

/// Move a session into a local trash directory after validating that it belongs
/// to the configured Pi session root. This keeps deletion recoverable.
pub fn trash_session(configured_root: &str, file: &str) -> Result<(), String> {
    let root = resolve_sessions_root(configured_root)
        .ok_or_else(|| "could not resolve the Pi session directory".to_string())?;
    let root = fs::canonicalize(&root)
        .map_err(|err| format!("failed to resolve session directory: {err}"))?;
    let source = validate_session_path(configured_root, file)?;

    let trash = root.join(".trash");
    fs::create_dir_all(&trash).map_err(|err| format!("failed to create session trash: {err}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("session.jsonl");
    let target = trash.join(format!("{stamp}-{name}"));
    fs::rename(&source, &target).map_err(|err| format!("failed to move session to trash: {err}"))
}

pub fn validate_session_path(configured_root: &str, file: &str) -> Result<PathBuf, String> {
    let root = resolve_sessions_root(configured_root)
        .ok_or_else(|| "could not resolve the Pi session directory".to_string())?;
    let root = fs::canonicalize(&root)
        .map_err(|err| format!("failed to resolve session directory: {err}"))?;
    let source =
        fs::canonicalize(file).map_err(|err| format!("failed to resolve session file: {err}"))?;
    if !source.starts_with(&root)
        || source.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
    {
        return Err("refusing to access a file outside the Pi session directory".to_string());
    }
    Ok(source)
}

pub fn parse_session_file(path: &Path) -> Option<SessionInfo> {
    let file = fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);

    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut created_at: Option<String> = None;
    let mut name: Option<String> = None;
    let mut first_message: Option<String> = None;
    let mut message_count = 0usize;

    for line in reader.lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match entry.get("type").and_then(Value::as_str).unwrap_or("") {
            "session" => {
                session_id = entry
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                cwd = entry
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                created_at = entry
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
            }
            "session_info" => {
                name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
            }
            "message" => {
                message_count += 1;
                if first_message.is_none()
                    && entry.pointer("/message/role").and_then(Value::as_str) == Some("user")
                {
                    first_message = extract_message_text(entry.get("message"));
                }
            }
            _ => {}
        }
    }

    let updated_at = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);

    Some(SessionInfo {
        file: path.to_string_lossy().to_string(),
        session_id,
        cwd,
        name,
        first_message,
        message_count,
        created_at,
        updated_at,
    })
}

fn extract_message_text(message: Option<&Value>) -> Option<String> {
    let message = message?;
    let text = match message.get("content")? {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => return None,
    };
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.chars().take(160).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("pid-desktop-{name}-{nonce}"))
    }

    #[test]
    fn parses_camel_case_session_metadata() {
        let root = temporary_directory("parse");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("session.jsonl");
        fs::write(
            &file,
            concat!(
                "{\"type\":\"session\",\"version\":3,\"id\":\"session-1\",\"timestamp\":\"2026-08-09T00:00:00Z\",\"cwd\":\"D:\\\\repo\"}\n",
                "{\"type\":\"message\",\"id\":\"a\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"Build the app\"}}\n",
                "{\"type\":\"session_info\",\"id\":\"b\",\"parentId\":\"a\",\"name\":\"Desktop work\"}\n"
            ),
        )
        .unwrap();

        let sessions = list_sessions(root.to_str().unwrap());
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "session-1");
        assert_eq!(sessions[0].cwd, "D:\\repo");
        assert_eq!(sessions[0].name.as_deref(), Some("Desktop work"));
        assert_eq!(sessions[0].first_message.as_deref(), Some("Build the app"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deletion_moves_session_to_recoverable_trash() {
        let root = temporary_directory("trash");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("session.jsonl");
        fs::write(&file, "{}\n").unwrap();

        trash_session(root.to_str().unwrap(), file.to_str().unwrap()).unwrap();
        assert!(!file.exists());
        assert_eq!(fs::read_dir(root.join(".trash")).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
