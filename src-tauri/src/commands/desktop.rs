//! Attachments, the quick-chat directory, and handing a workspace to an editor or file manager.

use crate::*;

#[tauri::command(async)]
pub(crate) fn quick_chat_dir() -> Result<String, AppError> {
    let path = app_config_dir().join("quick-chat");
    fs::create_dir_all(&path)
        .map_err(|err| AppError::Io(format!("failed to create quick chat directory: {err}")))?;
    Ok(path.to_string_lossy().to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentPayload {
    pub(crate) path: String,
    pub(crate) file_name: String,
    pub(crate) mime_type: String,
    pub(crate) size: u64,
    pub(crate) kind: String,
    pub(crate) data: Option<String>,
    pub(crate) text: Option<String>,
}

#[tauri::command(async)]
pub(crate) fn read_attachment(file: String) -> Result<AttachmentPayload, AppError> {
    let path = fs::canonicalize(&file)
        .map_err(|err| AppError::Io(format!("failed to open attachment: {err}")))?;
    let metadata = fs::metadata(&path)
        .map_err(|err| AppError::Io(format!("failed to inspect attachment: {err}")))?;
    if !metadata.is_file() {
        return Err(AppError::InvalidInput(
            "attachment must be a file".to_string(),
        ));
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime_type = mime_for_extension(&extension).to_string();
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment")
        .to_string();

    if mime_type.starts_with("image/") {
        if metadata.len() > 12 * 1024 * 1024 {
            return Err(AppError::Io("images are limited to 12 MB".to_string()));
        }
        let bytes =
            fs::read(&path).map_err(|err| AppError::Io(format!("failed to read image: {err}")))?;
        return Ok(AttachmentPayload {
            path: path.to_string_lossy().to_string(),
            file_name,
            mime_type,
            size: metadata.len(),
            kind: "image".to_string(),
            data: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            text: None,
        });
    }

    if metadata.len() > 2 * 1024 * 1024 {
        return Ok(AttachmentPayload {
            path: path.to_string_lossy().to_string(),
            file_name,
            mime_type,
            size: metadata.len(),
            kind: "file".to_string(),
            data: None,
            text: None,
        });
    }

    let bytes =
        fs::read(&path).map_err(|err| AppError::Io(format!("failed to read attachment: {err}")))?;
    let text = String::from_utf8(bytes).ok();
    Ok(AttachmentPayload {
        path: path.to_string_lossy().to_string(),
        file_name,
        mime_type,
        size: metadata.len(),
        kind: if text.is_some() { "text" } else { "file" }.to_string(),
        data: None,
        text,
    })
}

pub(crate) fn mime_for_extension(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "md" | "txt" | "log" => "text/plain",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "rs" => "text/rust",
        "py" => "text/python",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceEditorInfo {
    pub(crate) id: String,
    pub(crate) name: String,
}

pub(crate) const WORKSPACE_EDITOR_SPECS: &[WorkspaceEditorSpec] = &[
    WorkspaceEditorSpec {
        id: "cursor",
        name: "Cursor",
        commands: &["cursor"],
        executable_names: &["Cursor.exe"],
    },
    WorkspaceEditorSpec {
        id: "vscode",
        name: "Visual Studio Code",
        commands: &["code", "code-insiders"],
        executable_names: &["Code.exe", "Code - Insiders.exe"],
    },
    WorkspaceEditorSpec {
        id: "windsurf",
        name: "Windsurf",
        commands: &["windsurf"],
        executable_names: &["Windsurf.exe"],
    },
    WorkspaceEditorSpec {
        id: "antigravity",
        name: "Antigravity",
        commands: &["antigravity"],
        executable_names: &["Antigravity.exe"],
    },
];

pub(crate) fn workspace_editor_spec(editor_id: &str) -> Option<&'static WorkspaceEditorSpec> {
    WORKSPACE_EDITOR_SPECS
        .iter()
        .find(|editor| editor.id.eq_ignore_ascii_case(editor_id.trim()))
}

#[tauri::command(async)]
pub(crate) fn list_workspace_editors() -> Vec<WorkspaceEditorInfo> {
    WORKSPACE_EDITOR_SPECS
        .iter()
        .filter(|editor| resolve_workspace_editor(editor).is_some())
        .map(|editor| WorkspaceEditorInfo {
            id: editor.id.to_string(),
            name: editor.name.to_string(),
        })
        .collect()
}

#[tauri::command(async)]
pub(crate) fn open_workspace_in_editor(path: String, editor_id: String) -> Result<(), AppError> {
    let workspace = validate_workspace_directory(&path)?;
    let editor = workspace_editor_spec(&editor_id).ok_or_else(|| {
        AppError::InvalidInput(format!("unsupported workspace editor: {editor_id}"))
    })?;
    let executable = resolve_workspace_editor(editor).ok_or_else(|| {
        AppError::NotFound(format!(
            "{} is not installed or cannot be found",
            editor.name
        ))
    })?;

    hidden_command(&executable)
        .arg(&workspace)
        .spawn()
        .map(|_| ())
        .map_err(|err| {
            AppError::Process(format!(
                "failed to open workspace in {}: {err}",
                editor.name
            ))
        })
}

#[tauri::command(async)]
pub(crate) fn open_workspace_in_file_manager(path: String) -> Result<(), AppError> {
    let workspace = validate_workspace_directory(&path)?;

    #[cfg(windows)]
    {
        hidden_command("explorer.exe")
            .arg(&workspace)
            .spawn()
            .map(|_| ())
            .map_err(|err| AppError::Process(format!("failed to open File Explorer: {err}")))
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&workspace)
            .spawn()
            .map(|_| ())
            .map_err(|err| AppError::Process(format!("failed to open Finder: {err}")))
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&workspace)
            .spawn()
            .map(|_| ())
            .map_err(|err| AppError::Process(format!("failed to open file manager: {err}")))
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct WorkspaceEditorSpec {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) commands: &'static [&'static str],
    pub(crate) executable_names: &'static [&'static str],
}

#[cfg(windows)]
pub(crate) fn prefer_native_editor_executable(
    path: PathBuf,
    spec: &WorkspaceEditorSpec,
) -> PathBuf {
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return path;
    }
    for ancestor in path.ancestors().take(6) {
        for executable_name in spec.executable_names {
            let candidate = ancestor.join(executable_name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    path
}

#[cfg(windows)]
pub(crate) fn windows_editor_install_candidates(spec: &WorkspaceEditorSpec) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local_app_data).join("Programs"));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(program_files));
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        roots.push(PathBuf::from(program_files_x86));
    }

    let install_directories: &[&str] = match spec.id {
        "cursor" => &["Cursor", "cursor"],
        "vscode" => &["Microsoft VS Code", "Microsoft VS Code Insiders"],
        "windsurf" => &["Windsurf"],
        "antigravity" => &["Antigravity", "antigravity"],
        _ => &[],
    };
    let mut candidates = roots
        .iter()
        .flat_map(|root| {
            install_directories.iter().flat_map(move |directory| {
                spec.executable_names
                    .iter()
                    .map(move |name| root.join(directory).join(name))
            })
        })
        .collect::<Vec<_>>();

    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        let scoop_name = match spec.id {
            "cursor" => "cursor",
            "vscode" => "vscode",
            "windsurf" => "windsurf",
            "antigravity" => "antigravity",
            _ => "",
        };
        if !scoop_name.is_empty() {
            let root = PathBuf::from(user_profile)
                .join("scoop")
                .join("apps")
                .join(scoop_name)
                .join("current");
            candidates.extend(spec.executable_names.iter().map(|name| root.join(name)));
        }
    }
    candidates
}

#[cfg(windows)]
pub(crate) fn resolve_workspace_editor(spec: &WorkspaceEditorSpec) -> Option<PathBuf> {
    if let Some(candidate) = windows_editor_install_candidates(spec)
        .into_iter()
        .find(|candidate| candidate.is_file())
    {
        return Some(candidate);
    }

    spec.commands.iter().find_map(|program| {
        let candidate = resolve_windows_executable(program)?;
        let normalized = candidate.to_string_lossy().to_ascii_lowercase();
        if spec.id == "vscode"
            && (normalized.contains("cursor")
                || normalized.contains("windsurf")
                || normalized.contains("antigravity"))
        {
            return None;
        }
        Some(prefer_native_editor_executable(candidate, spec))
    })
}

#[cfg(not(windows))]
pub(crate) fn resolve_workspace_editor(spec: &WorkspaceEditorSpec) -> Option<PathBuf> {
    let path_entries = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    spec.commands
        .iter()
        .flat_map(|program| path_entries.iter().map(move |entry| entry.join(program)))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn workspace_editor_catalog_has_stable_unique_ids() {
        let ids = WORKSPACE_EDITOR_SPECS
            .iter()
            .map(|editor| editor.id)
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), WORKSPACE_EDITOR_SPECS.len());
        assert_eq!(
            workspace_editor_spec("cursor").map(|item| item.name),
            Some("Cursor")
        );
        assert_eq!(
            workspace_editor_spec("VSCODE").map(|item| item.name),
            Some("Visual Studio Code")
        );
        assert_eq!(
            workspace_editor_spec("antigravity").map(|item| item.name),
            Some("Antigravity")
        );
        assert!(workspace_editor_spec("unknown").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn promotes_editor_command_script_to_native_executable() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "pid-desktop-editor-launcher-{}-{stamp}",
            std::process::id()
        ));
        let bin = root.join("resources").join("app").join("bin");
        fs::create_dir_all(&bin).expect("temporary editor bin should exist");
        let script = bin.join("cursor.cmd");
        let executable = root.join("Cursor.exe");
        fs::write(&script, b"").expect("temporary command script should be written");
        fs::write(&executable, b"").expect("temporary editor executable should be written");

        let spec = workspace_editor_spec("cursor").expect("Cursor spec should exist");
        assert_eq!(prefer_native_editor_executable(script, spec), executable);

        fs::remove_dir_all(root).expect("temporary editor directory should be removed");
    }
}
