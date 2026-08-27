use std::fs;
use std::io::BufRead;

use super::sessions::{session_messages, SessionInfo};

fn session_path_key(value: &str) -> String {
    #[cfg(windows)]
    {
        let normalized = value
            .trim()
            .trim_end_matches(['/', '\\'])
            .replace('/', "\\")
            .to_lowercase();
        if let Some(path) = normalized.strip_prefix(r"\\?\unc\") {
            return format!(r"\\{path}");
        }
        return normalized
            .strip_prefix(r"\\?\")
            .unwrap_or(&normalized)
            .to_string();
    }

    #[cfg(not(windows))]
    value.trim().trim_end_matches('/').to_string()
}

fn session_parent_file(file: &str) -> Option<String> {
    let file = fs::File::open(file).ok()?;
    for line in std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .take(8)
    {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if entry.get("type").and_then(serde_json::Value::as_str) != Some("session") {
            continue;
        }
        return entry
            .get("parentSession")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned);
    }
    None
}

pub fn collapse_unchanged_session_forks(
    configured_root: &str,
    sessions: Vec<SessionInfo>,
    active_primary_sessions: &[String],
) -> Vec<SessionInfo> {
    let mut duplicate_links = vec![Vec::<usize>::new(); sessions.len()];
    let mut has_equal_parent = vec![false; sessions.len()];

    for (child_index, child) in sessions.iter().enumerate() {
        let Some(parent_file) = session_parent_file(&child.file) else {
            continue;
        };
        let parent_key = session_path_key(&parent_file);
        let Some(parent_index) = sessions
            .iter()
            .position(|session| session_path_key(&session.file) == parent_key)
        else {
            continue;
        };
        let Ok(child_messages) = session_messages(configured_root, &child.file) else {
            continue;
        };
        let Ok(parent_messages) = session_messages(configured_root, &sessions[parent_index].file)
        else {
            continue;
        };
        if child_messages != parent_messages {
            continue;
        }
        duplicate_links[child_index].push(parent_index);
        duplicate_links[parent_index].push(child_index);
        has_equal_parent[child_index] = true;
    }

    let active_keys = active_primary_sessions
        .iter()
        .map(|file| session_path_key(file))
        .collect::<Vec<_>>();
    let mut visited = vec![false; sessions.len()];
    let mut hidden = vec![false; sessions.len()];

    for start in 0..sessions.len() {
        if visited[start] || duplicate_links[start].is_empty() {
            continue;
        }
        let mut component = Vec::new();
        let mut stack = vec![start];
        while let Some(index) = stack.pop() {
            if visited[index] {
                continue;
            }
            visited[index] = true;
            component.push(index);
            stack.extend(duplicate_links[index].iter().copied());
        }

        let keep = component
            .iter()
            .copied()
            .find(|index| {
                let key = session_path_key(&sessions[*index].file);
                active_keys.iter().any(|active| active == &key)
            })
            .or_else(|| {
                component
                    .iter()
                    .copied()
                    .find(|index| !has_equal_parent[*index])
            })
            .unwrap_or(start);
        for index in component {
            hidden[index] = index != keep;
        }
    }

    sessions
        .into_iter()
        .enumerate()
        .filter_map(|(index, session)| (!hidden[index]).then_some(session))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::pi::sessions::parse_session_file;

    #[test]
    fn collapses_unchanged_forks_without_hiding_real_branches() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "pid-desktop-session-forks-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary session directory should be created");
        let parent = root.join("parent.jsonl");
        let child = root.join("child.jsonl");
        let message = serde_json::json!({
            "type": "message",
            "message": { "role": "user", "content": "same conversation" }
        });
        fs::write(
            &parent,
            format!(
                "{}\n{}\n",
                serde_json::json!({ "type": "session", "id": "parent", "cwd": root }),
                message
            ),
        )
        .expect("parent session should be written");
        fs::write(
            &child,
            format!(
                "{}\n{}\n",
                serde_json::json!({
                    "type": "session",
                    "id": "child",
                    "cwd": root,
                    "parentSession": if cfg!(windows) {
                        format!(r"\\?\{}", parent.to_string_lossy())
                    } else {
                        parent.to_string_lossy().to_string()
                    }
                }),
                message
            ),
        )
        .expect("child session should be written");

        let sessions = vec![
            parse_session_file(&child).unwrap(),
            parse_session_file(&parent).unwrap(),
        ];
        let collapsed = collapse_unchanged_session_forks(&root.to_string_lossy(), sessions, &[]);
        assert_eq!(collapsed.len(), 1);
        assert_eq!(collapsed[0].session_id, "parent");

        let sessions = vec![
            parse_session_file(&child).unwrap(),
            parse_session_file(&parent).unwrap(),
        ];
        let active_child = collapse_unchanged_session_forks(
            &root.to_string_lossy(),
            sessions,
            &[child.to_string_lossy().to_string()],
        );
        assert_eq!(active_child.len(), 1);
        assert_eq!(active_child[0].session_id, "child");

        writeln!(
            fs::OpenOptions::new().append(true).open(&child).unwrap(),
            "{}",
            serde_json::json!({
                "type": "message",
                "message": { "role": "assistant", "content": "new branch content" }
            })
        )
        .expect("branched message should be appended");
        let branched = collapse_unchanged_session_forks(
            &root.to_string_lossy(),
            vec![
                parse_session_file(&child).unwrap(),
                parse_session_file(&parent).unwrap(),
            ],
            &[],
        );
        assert_eq!(branched.len(), 2);

        fs::remove_dir_all(root).expect("temporary session directory should be removed");
    }
}
