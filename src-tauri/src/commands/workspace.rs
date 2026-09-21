//! Reading the workspace tree, searching it, and opening files in it.

use crate::workspace_files::{self, WorkspaceDirEntry};
use crate::*;

#[tauri::command(async)]
pub(crate) fn list_workspace_dir(
    cwd: String,
    path: Option<String>,
) -> Result<Vec<WorkspaceDirEntry>, String> {
    let rel = path.unwrap_or_default().replace('\\', "/");
    let (_root, dir) = confined_workspace_path(&cwd, &rel)?;
    if !dir.is_dir() {
        return Err("not a directory".to_string());
    }
    let mut entries = Vec::new();
    let reader = fs::read_dir(&dir).map_err(|err| format!("failed to list directory: {err}"))?;
    for entry in reader.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let child = if rel.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel.trim_end_matches('/'), name)
        };
        entries.push(WorkspaceDirEntry {
            name,
            path: child,
            is_dir,
        });
        if entries.len() >= 400 {
            break;
        }
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub(crate) async fn search_workspace_files(
    state: State<'_, AppState>,
    cwd: String,
    query: String,
    request_id: String,
) -> Result<Vec<WorkspaceDirEntry>, String> {
    let (root, _) = confined_workspace_path(&cwd, "")?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut searches = state
            .workspace_searches
            .lock()
            .map_err(|_| "workspace search state lock poisoned".to_string())?;
        if let Some(previous) = searches.insert(request_id.clone(), Arc::clone(&cancelled)) {
            previous.store(true, Ordering::Release);
        }
    }
    let worker_cancelled = Arc::clone(&cancelled);
    let worker = tauri::async_runtime::spawn_blocking(move || {
        workspace_files::search(&root, &query, &worker_cancelled)
    })
    .await;
    if let Ok(mut searches) = state.workspace_searches.lock() {
        if searches
            .get(&request_id)
            .is_some_and(|active| Arc::ptr_eq(active, &cancelled))
        {
            searches.remove(&request_id);
        }
    }
    worker.map_err(|err| format!("workspace search worker failed: {err}"))?
}

#[tauri::command]
pub(crate) fn cancel_workspace_search(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    if let Some(cancelled) = state
        .workspace_searches
        .lock()
        .map_err(|_| "workspace search state lock poisoned".to_string())?
        .get(&request_id)
        .cloned()
    {
        cancelled.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn read_workspace_file(
    cwd: String,
    path: String,
) -> Result<WorkspaceFileContent, String> {
    const MAX_BYTES: u64 = 512 * 1024;
    const MAX_BINARY_PREVIEW_BYTES: u64 = 10 * 1024 * 1024;
    let (_root, file) = confined_workspace_path(&cwd, &path)?;
    if !file.is_file() {
        return Err("not a file".to_string());
    }
    let metadata = fs::metadata(&file).map_err(|err| format!("failed to inspect file: {err}"))?;
    let file_name = file
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file")
        .to_string();
    let extension = file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime_type = match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "pdf" => Some("application/pdf"),
        _ => None,
    };
    let binary_preview = mime_type.is_some() && metadata.len() <= MAX_BINARY_PREVIEW_BYTES;
    let bytes = if metadata.len() > MAX_BYTES && !binary_preview {
        let mut data = fs::read(&file).map_err(|err| format!("failed to read file: {err}"))?;
        data.truncate(MAX_BYTES as usize);
        data
    } else {
        fs::read(&file).map_err(|err| format!("failed to read file: {err}"))?
    };
    let text = if mime_type.is_some() {
        None
    } else {
        String::from_utf8(bytes.clone()).ok()
    };
    let is_binary = text.is_none();
    let data = binary_preview.then(|| base64::engine::general_purpose::STANDARD.encode(&bytes));
    Ok(WorkspaceFileContent {
        path,
        file_name,
        text,
        mime_type: mime_type.map(str::to_string),
        data,
        truncated: metadata.len()
            > if binary_preview {
                MAX_BINARY_PREVIEW_BYTES
            } else {
                MAX_BYTES
            },
        is_binary,
        size: metadata.len(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFileContent {
    pub(crate) path: String,
    pub(crate) file_name: String,
    pub(crate) text: Option<String>,
    pub(crate) mime_type: Option<String>,
    pub(crate) data: Option<String>,
    pub(crate) truncated: bool,
    pub(crate) is_binary: bool,
    pub(crate) size: u64,
}

pub(crate) fn confined_workspace_path(
    cwd: &str,
    relative: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root = strip_windows_prefix(
        fs::canonicalize(cwd).map_err(|err| format!("workspace not found: {err}"))?,
    );
    let requested = strip_windows_prefix(PathBuf::from(relative));
    if requested
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("path is outside the workspace".to_string());
    }
    let joined = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };
    let canon = if joined.exists() {
        strip_windows_prefix(
            fs::canonicalize(&joined).map_err(|err| format!("path not found: {err}"))?,
        )
    } else {
        joined
    };
    if !canon.starts_with(&root) {
        return Err("path is outside the workspace".to_string());
    }
    Ok((root, canon))
}

pub(crate) fn validate_workspace_directory(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("workspace path is empty".to_string());
    }
    let workspace = PathBuf::from(trimmed);
    if !workspace.is_absolute() {
        return Err("workspace path must be absolute".to_string());
    }
    let metadata = fs::metadata(&workspace)
        .map_err(|err| format!("workspace path is not available: {err}"))?;
    if !metadata.is_dir() {
        return Err("workspace path is not a directory".to_string());
    }
    Ok(workspace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confines_relative_and_absolute_files_to_the_workspace() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "pid-desktop-workspace-path-{}-{stamp}",
            std::process::id()
        ));
        let workspace = directory.join("workspace");
        let outside = directory.join("outside.html");
        let inside = workspace.join("inside.html");
        fs::create_dir_all(&workspace).expect("temporary workspace should be created");
        fs::write(&inside, "<h1>inside</h1>").expect("workspace file should be written");
        fs::write(&outside, "<h1>outside</h1>").expect("outside file should be written");

        let cwd = workspace.to_string_lossy();
        assert_eq!(
            confined_workspace_path(&cwd, "inside.html")
                .expect("relative workspace path should be accepted")
                .1,
            strip_windows_prefix(fs::canonicalize(&inside).expect("inside file should resolve")),
        );
        assert_eq!(
            confined_workspace_path(&cwd, &inside.to_string_lossy())
                .expect("absolute workspace path should be accepted")
                .1,
            strip_windows_prefix(fs::canonicalize(&inside).expect("inside file should resolve")),
        );
        let forward_slash_inside = inside.to_string_lossy().replace('\\', "/");
        let content = read_workspace_file(cwd.to_string(), forward_slash_inside)
            .expect("forward-slash absolute HTML path should be readable");
        assert_eq!(content.text.as_deref(), Some("<h1>inside</h1>"));
        assert!(confined_workspace_path(&cwd, &outside.to_string_lossy()).is_err());
        assert!(confined_workspace_path(&cwd, "../outside.html").is_err());

        fs::remove_dir_all(directory).expect("temporary path fixture should be removed");
    }

    #[test]
    fn validates_workspace_directory_before_opening_file_manager() {
        assert!(validate_workspace_directory("").is_err());
        assert!(validate_workspace_directory("relative/path").is_err());

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "pid-desktop-file-manager-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("temporary workspace should be created");
        let file = directory.join("not-a-workspace.txt");
        fs::write(&file, b"test").expect("temporary file should be created");

        assert_eq!(
            validate_workspace_directory(&directory.to_string_lossy())
                .expect("existing absolute directory should be accepted"),
            directory
        );
        assert!(validate_workspace_directory(&file.to_string_lossy()).is_err());

        fs::remove_dir_all(directory).expect("temporary workspace should be removed");
    }
}
