use std::collections::HashMap;
use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
struct SessionEntryKind {
    #[serde(rename = "type")]
    entry_type: String,
}

#[derive(Clone)]
struct SessionCacheEntry {
    len: u64,
    modified: Option<SystemTime>,
    session: SessionInfo,
}

static SESSION_CACHE: OnceLock<Mutex<HashMap<PathBuf, SessionCacheEntry>>> = OnceLock::new();

fn session_cache() -> &'static Mutex<HashMap<PathBuf, SessionCacheEntry>> {
    SESSION_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessageTiming {
    pub role: String,
    pub message_timestamp: u64,
    pub entry_timestamp: String,
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

pub fn session_message_timings(
    configured_root: &str,
    file: &str,
) -> Result<Vec<SessionMessageTiming>, String> {
    let source = validate_session_path(configured_root, file)?;
    let file = fs::File::open(source)
        .map_err(|err| format!("failed to open session file: {err}"))?;
    let reader = std::io::BufReader::new(file);
    let mut timings = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(role @ ("user" | "assistant")) =
            entry.pointer("/message/role").and_then(Value::as_str)
        else {
            continue;
        };
        let Some(message_timestamp) = entry
            .pointer("/message/timestamp")
            .and_then(Value::as_u64)
        else {
            continue;
        };
        let Some(entry_timestamp) = entry.get("timestamp").and_then(Value::as_str) else {
            continue;
        };
        timings.push(SessionMessageTiming {
            role: role.to_string(),
            message_timestamp,
            entry_timestamp: entry_timestamp.to_string(),
        });
    }

    Ok(timings)
}

pub fn session_messages(configured_root: &str, file: &str) -> Result<Vec<Value>, String> {
    let source = validate_session_path(configured_root, file)?;
    let file = fs::File::open(source)
        .map_err(|err| format!("failed to open session file: {err}"))?;
    let reader = std::io::BufReader::new(file);
    let mut messages = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        if let Some(message) = entry.get("message") {
            messages.push(message.clone());
        }
    }

    Ok(messages)
}

pub fn parse_session_file(path: &Path) -> Option<SessionInfo> {
    let metadata = fs::metadata(path).ok()?;
    let len = metadata.len();
    let modified = metadata.modified().ok();
    if let Ok(cache) = session_cache().lock() {
        if let Some(cached) = cache.get(path) {
            if cached.len == len && cached.modified == modified {
                return Some(cached.session.clone());
            }
        }
    }

    let file = fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);

    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut created_at: Option<String> = None;
    let mut name: Option<String> = None;
    let mut first_message: Option<String> = None;
    let mut message_count = 0usize;

    let mut line = String::new();
    loop {
        line.clear();
        let Ok(read) = reader.read_line(&mut line) else {
            break;
        };
        if read == 0 {
            break;
        }
        let Ok(kind) = serde_json::from_str::<SessionEntryKind>(&line) else {
            continue;
        };
        match kind.entry_type.as_str() {
            "session" => {
                let Ok(entry) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
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
                let Ok(entry) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
            }
            "message" => {
                message_count += 1;
                if first_message.is_none() {
                    let Ok(entry) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if entry.pointer("/message/role").and_then(Value::as_str) == Some("user") {
                        first_message = extract_message_text(entry.get("message"));
                    }
                }
            }
            _ => {}
        }
    }

    let updated_at = modified
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);

    let session = SessionInfo {
        file: path.to_string_lossy().to_string(),
        session_id,
        cwd,
        name,
        first_message,
        message_count,
        created_at,
        updated_at,
    };
    if let Ok(mut cache) = session_cache().lock() {
        cache.insert(
            path.to_path_buf(),
            SessionCacheEntry {
                len,
                modified,
                session: session.clone(),
            },
        );
    }
    Some(session)
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
        assert_eq!(sessions[0].message_count, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalidates_cached_metadata_when_session_grows() {
        let root = temporary_directory("cache");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("session.jsonl");
        fs::write(
            &file,
            concat!(
                "{\"type\":\"session\",\"id\":\"session-1\",\"cwd\":\"D:\\\\repo\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"First\"}}\n"
            ),
        )
        .unwrap();
        assert_eq!(parse_session_file(&file).unwrap().message_count, 1);

        use std::io::Write;
        writeln!(
            fs::OpenOptions::new().append(true).open(&file).unwrap(),
            "{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"content\":\"Second\"}}}}"
        )
        .unwrap();
        assert_eq!(parse_session_file(&file).unwrap().message_count, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_outer_timestamps_for_message_duration() {
        let root = temporary_directory("timings");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("session.jsonl");
        fs::write(
            &file,
            concat!(
                "{\"type\":\"message\",\"timestamp\":\"2026-08-17T01:00:00.000Z\",\"message\":{\"role\":\"user\",\"timestamp\":10}}\n",
                "{\"type\":\"message\",\"timestamp\":\"2026-08-17T01:00:13.000Z\",\"message\":{\"role\":\"assistant\",\"timestamp\":11}}\n",
                "{\"type\":\"message\",\"timestamp\":\"2026-08-17T01:00:14.000Z\",\"message\":{\"role\":\"toolResult\",\"timestamp\":12}}\n"
            ),
        )
        .unwrap();

        let timings = session_message_timings(root.to_str().unwrap(), file.to_str().unwrap()).unwrap();
        assert_eq!(timings.len(), 2);
        assert_eq!(timings[0].role, "user");
        assert_eq!(timings[1].message_timestamp, 11);
        assert_eq!(timings[1].entry_timestamp, "2026-08-17T01:00:13.000Z");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_messages_directly_for_fast_history_preview() {
        let root = temporary_directory("messages");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("session.jsonl");
        fs::write(
            &file,
            concat!(
                "{\"type\":\"session\",\"id\":\"session-1\",\"cwd\":\"D:\\\\repo\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"First\",\"timestamp\":10}}\n",
                "{\"type\":\"custom\",\"customType\":\"status\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Second\"}],\"timestamp\":11}}\n"
            ),
        )
        .unwrap();

        let messages = session_messages(root.to_str().unwrap(), file.to_str().unwrap()).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].get("role").and_then(Value::as_str), Some("user"));
        assert_eq!(messages[1].pointer("/content/0/text").and_then(Value::as_str), Some("Second"));
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
