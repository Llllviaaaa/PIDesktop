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
    /// Whether the editor can be asked to open a file at a given line.
    pub(crate) supports_line: bool,
}

/// How an editor's command line asks for a file at a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EditorLineStyle {
    /// VS Code and its forks: `-g file:line:column`.
    Goto,
    /// Zed and Sublime Text: `file:line:column`.
    ColonSuffix,
    /// IntelliJ-based IDEs: `--line N --column C file`.
    JetBrains,
    /// Notepad++: `-nN -cC file`.
    NotepadPlusPlus,
    /// Visual Studio: `/Edit file`; it has no line argument.
    VisualStudio,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct WorkspaceEditorSpec {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    /// Commands looked up on PATH (Toolbox and editor shell scripts live there).
    pub(crate) commands: &'static [&'static str],
    pub(crate) executable_names: &'static [&'static str],
    /// Install folders under %LOCALAPPDATA%\Programs, %ProgramFiles% and %ProgramFiles(x86)%.
    pub(crate) install_directories: &'static [&'static str],
    /// Versioned install folders (`WebStorm 2025.2`) matched by prefix.
    pub(crate) versioned_prefixes: &'static [&'static str],
    pub(crate) scoop_name: &'static str,
    pub(crate) line_style: EditorLineStyle,
}

const fn editor(
    id: &'static str,
    name: &'static str,
    commands: &'static [&'static str],
    executable_names: &'static [&'static str],
    install_directories: &'static [&'static str],
    scoop_name: &'static str,
    line_style: EditorLineStyle,
) -> WorkspaceEditorSpec {
    WorkspaceEditorSpec {
        id,
        name,
        commands,
        executable_names,
        install_directories,
        versioned_prefixes: &[],
        scoop_name,
        line_style,
    }
}

const fn jetbrains(
    id: &'static str,
    name: &'static str,
    commands: &'static [&'static str],
    executable_names: &'static [&'static str],
    versioned_prefixes: &'static [&'static str],
) -> WorkspaceEditorSpec {
    WorkspaceEditorSpec {
        id,
        name,
        commands,
        executable_names,
        install_directories: &[],
        versioned_prefixes,
        scoop_name: "",
        line_style: EditorLineStyle::JetBrains,
    }
}

pub(crate) const WORKSPACE_EDITOR_SPECS: &[WorkspaceEditorSpec] = &[
    editor(
        "cursor",
        "Cursor",
        &["cursor"],
        &["Cursor.exe"],
        &["Cursor", "cursor"],
        "cursor",
        EditorLineStyle::Goto,
    ),
    editor(
        "vscode",
        "Visual Studio Code",
        &["code", "code-insiders"],
        &["Code.exe", "Code - Insiders.exe"],
        &["Microsoft VS Code", "Microsoft VS Code Insiders"],
        "vscode",
        EditorLineStyle::Goto,
    ),
    editor(
        "windsurf",
        "Windsurf",
        &["windsurf"],
        &["Windsurf.exe"],
        &["Windsurf"],
        "windsurf",
        EditorLineStyle::Goto,
    ),
    editor(
        "antigravity",
        "Antigravity",
        &["antigravity"],
        &["Antigravity.exe"],
        &["Antigravity", "antigravity"],
        "antigravity",
        EditorLineStyle::Goto,
    ),
    editor(
        "zed",
        "Zed",
        &["zed"],
        &["Zed.exe"],
        &["Zed"],
        "zed",
        EditorLineStyle::ColonSuffix,
    ),
    editor(
        "sublime",
        "Sublime Text",
        &["subl"],
        &["subl.exe", "sublime_text.exe"],
        &["Sublime Text", "Sublime Text 4", "Sublime Text 3"],
        "sublime-text",
        EditorLineStyle::ColonSuffix,
    ),
    editor(
        "notepadpp",
        "Notepad++",
        &["notepad++"],
        &["notepad++.exe"],
        &["Notepad++"],
        "notepadplusplus",
        EditorLineStyle::NotepadPlusPlus,
    ),
    jetbrains(
        "idea",
        "IntelliJ IDEA",
        &["idea", "idea64"],
        &["idea64.exe"],
        &["IntelliJ IDEA"],
    ),
    jetbrains(
        "webstorm",
        "WebStorm",
        &["webstorm", "webstorm64"],
        &["webstorm64.exe"],
        &["WebStorm"],
    ),
    jetbrains(
        "pycharm",
        "PyCharm",
        &["pycharm", "pycharm64"],
        &["pycharm64.exe"],
        &["PyCharm"],
    ),
    jetbrains(
        "rider",
        "Rider",
        &["rider", "rider64"],
        &["rider64.exe"],
        &["JetBrains Rider", "Rider"],
    ),
    jetbrains(
        "goland",
        "GoLand",
        &["goland", "goland64"],
        &["goland64.exe"],
        &["GoLand"],
    ),
    jetbrains(
        "clion",
        "CLion",
        &["clion", "clion64"],
        &["clion64.exe"],
        &["CLion"],
    ),
    jetbrains(
        "rustrover",
        "RustRover",
        &["rustrover", "rustrover64"],
        &["rustrover64.exe"],
        &["RustRover"],
    ),
    editor(
        "visualstudio",
        "Visual Studio",
        &[],
        &["devenv.exe"],
        &[],
        "",
        EditorLineStyle::VisualStudio,
    ),
];

pub(crate) fn workspace_editor_spec(editor_id: &str) -> Option<&'static WorkspaceEditorSpec> {
    WORKSPACE_EDITOR_SPECS
        .iter()
        .find(|editor| editor.id.eq_ignore_ascii_case(editor_id.trim()))
}

/// Builds the arguments that open a folder, a file, or a file at a line.
///
/// When both a workspace and a file are given, editors that understand
/// folders receive the workspace too, so the file opens in that project's
/// window instead of a stray one.
pub(crate) fn editor_launch_args(
    spec: &WorkspaceEditorSpec,
    workspace: Option<&Path>,
    file: Option<&Path>,
    line: Option<u32>,
    column: Option<u32>,
) -> Vec<std::ffi::OsString> {
    use std::ffi::OsString;
    let line = line.filter(|value| *value > 0);
    let column = column.filter(|value| *value > 0).filter(|_| line.is_some());
    let located = |path: &Path| -> OsString {
        let mut value = path.as_os_str().to_os_string();
        if let Some(line) = line {
            value.push(format!(":{line}"));
            if let Some(column) = column {
                value.push(format!(":{column}"));
            }
        }
        value
    };
    let mut args: Vec<OsString> = Vec::new();
    match spec.line_style {
        EditorLineStyle::Goto => {
            if let Some(workspace) = workspace {
                args.push(workspace.as_os_str().to_os_string());
            }
            if let Some(file) = file {
                if line.is_some() {
                    args.push("-g".into());
                    args.push(located(file));
                } else {
                    args.push(file.as_os_str().to_os_string());
                }
            }
        }
        EditorLineStyle::ColonSuffix => {
            if let Some(workspace) = workspace {
                args.push(workspace.as_os_str().to_os_string());
            }
            if let Some(file) = file {
                args.push(located(file));
            }
        }
        EditorLineStyle::JetBrains => {
            if let Some(workspace) = workspace {
                args.push(workspace.as_os_str().to_os_string());
            }
            if let Some(file) = file {
                if let Some(line) = line {
                    args.push("--line".into());
                    args.push(line.to_string().into());
                    if let Some(column) = column {
                        args.push("--column".into());
                        args.push(column.to_string().into());
                    }
                }
                args.push(file.as_os_str().to_os_string());
            }
        }
        EditorLineStyle::NotepadPlusPlus => match file {
            Some(file) => {
                if let Some(line) = line {
                    args.push(format!("-n{line}").into());
                    if let Some(column) = column {
                        args.push(format!("-c{column}").into());
                    }
                }
                args.push(file.as_os_str().to_os_string());
            }
            None => {
                if let Some(workspace) = workspace {
                    args.push("-openFoldersAsWorkspace".into());
                    args.push(workspace.as_os_str().to_os_string());
                }
            }
        },
        EditorLineStyle::VisualStudio => match file {
            Some(file) => {
                args.push("/Edit".into());
                args.push(file.as_os_str().to_os_string());
            }
            None => {
                if let Some(workspace) = workspace {
                    args.push(workspace.as_os_str().to_os_string());
                }
            }
        },
    }
    args
}

#[tauri::command(async)]
pub(crate) fn list_workspace_editors() -> Vec<WorkspaceEditorInfo> {
    WORKSPACE_EDITOR_SPECS
        .iter()
        .filter(|editor| resolve_workspace_editor(editor).is_some())
        .map(|editor| WorkspaceEditorInfo {
            id: editor.id.to_string(),
            name: editor.name.to_string(),
            supports_line: editor.line_style != EditorLineStyle::VisualStudio,
        })
        .collect()
}

fn launch_editor(
    editor_id: &str,
    workspace: Option<&Path>,
    file: Option<&Path>,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), AppError> {
    let editor = workspace_editor_spec(editor_id).ok_or_else(|| {
        AppError::InvalidInput(format!("unsupported workspace editor: {editor_id}"))
    })?;
    let executable = resolve_workspace_editor(editor).ok_or_else(|| {
        AppError::NotFound(format!(
            "{} is not installed or cannot be found",
            editor.name
        ))
    })?;
    let mut command = hidden_command(&executable);
    command.args(editor_launch_args(editor, workspace, file, line, column));
    if let Some(directory) = workspace.or_else(|| file.and_then(Path::parent)) {
        command.current_dir(directory);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| AppError::Process(format!("failed to open {}: {err}", editor.name)))
}

#[tauri::command(async)]
pub(crate) fn open_workspace_in_editor(path: String, editor_id: String) -> Result<(), AppError> {
    let workspace = validate_workspace_directory(&path)?;
    launch_editor(&editor_id, Some(&workspace), None, None, None)
}

/// Opens one file, optionally at a line, in the chosen editor.
#[tauri::command(async)]
pub(crate) fn open_file_in_editor(
    path: String,
    editor_id: String,
    line: Option<u32>,
    column: Option<u32>,
    workspace: Option<String>,
) -> Result<(), AppError> {
    let file = PathBuf::from(path.trim());
    if !file.is_absolute() {
        return Err(AppError::InvalidInput(
            "file path must be absolute".to_string(),
        ));
    }
    if !file.exists() {
        return Err(AppError::NotFound(format!(
            "{} does not exist",
            file.display()
        )));
    }
    let workspace = workspace
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|value| value.is_dir());
    if file.is_dir() {
        return launch_editor(&editor_id, Some(&file), None, None, None);
    }
    launch_editor(&editor_id, workspace.as_deref(), Some(&file), line, column)
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

/// Shows a file selected in its folder, the way "Reveal in File Explorer" does.
#[tauri::command(async)]
pub(crate) fn reveal_path_in_file_manager(path: String) -> Result<(), AppError> {
    let target = PathBuf::from(path.trim());
    if !target.is_absolute() || !target.exists() {
        return Err(AppError::NotFound(format!(
            "{} does not exist",
            target.display()
        )));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Explorer parses its own command line: `/select,` must precede the quoted path.
        hidden_command("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", target.display()))
            .spawn()
            .map(|_| ())
            .map_err(|err| AppError::Process(format!("failed to open File Explorer: {err}")))
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|err| AppError::Process(format!("failed to open Finder: {err}")))
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let folder = if target.is_dir() {
            target.clone()
        } else {
            target
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or(target.clone())
        };
        Command::new("xdg-open")
            .arg(&folder)
            .spawn()
            .map(|_| ())
            .map_err(|err| AppError::Process(format!("failed to open file manager: {err}")))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalAppInfo {
    pub(crate) id: String,
    pub(crate) name: String,
}

#[cfg(windows)]
fn windows_terminal_executable() -> Option<PathBuf> {
    resolve_windows_executable("wt").or_else(|| {
        std::env::var_os("LOCALAPPDATA")
            .map(|local| {
                PathBuf::from(local)
                    .join("Microsoft")
                    .join("WindowsApps")
                    .join("wt.exe")
            })
            .filter(|candidate| candidate.exists())
    })
}

#[cfg(windows)]
fn git_bash_launcher() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(git) = resolve_windows_executable("git") {
        for ancestor in git.ancestors().skip(1).take(3) {
            candidates.push(ancestor.join("git-bash.exe"));
        }
    }
    for variable in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable) {
            candidates.push(PathBuf::from(root).join("Git").join("git-bash.exe"));
        }
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// External terminal apps the "open in" menu can hand the workspace to.
#[tauri::command(async)]
pub(crate) fn list_terminal_apps() -> Vec<TerminalAppInfo> {
    let mut apps = Vec::new();
    let mut add = |id: &str, name: &str| {
        apps.push(TerminalAppInfo {
            id: id.to_string(),
            name: name.to_string(),
        })
    };
    #[cfg(windows)]
    {
        if windows_terminal_executable().is_some() {
            add("windows-terminal", "Windows Terminal");
        }
        add("powershell", "PowerShell");
        if resolve_windows_executable("pwsh").is_some() {
            add("pwsh", "PowerShell 7");
        }
        add("cmd", "命令提示符");
        if git_bash_launcher().is_some() {
            add("git-bash", "Git Bash");
        }
    }
    #[cfg(target_os = "macos")]
    {
        add("terminal", "终端");
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        add("terminal", "终端");
    }
    apps
}

#[tauri::command(async)]
pub(crate) fn open_workspace_in_terminal_app(path: String, app_id: String) -> Result<(), AppError> {
    let workspace = validate_workspace_directory(&path)?;
    let failed = |err: std::io::Error| AppError::Process(format!("failed to open terminal: {err}"));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        match app_id.as_str() {
            "windows-terminal" => {
                let executable = windows_terminal_executable().ok_or_else(|| {
                    AppError::NotFound("Windows Terminal is not installed".to_string())
                })?;
                Command::new(executable)
                    .arg("-d")
                    .arg(&workspace)
                    .spawn()
                    .map(|_| ())
                    .map_err(failed)
            }
            "powershell" | "pwsh" => Command::new(if app_id == "pwsh" {
                "pwsh.exe"
            } else {
                "powershell.exe"
            })
            .arg("-NoExit")
            .arg("-NoLogo")
            .current_dir(&workspace)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(failed),
            "cmd" => Command::new("cmd.exe")
                .current_dir(&workspace)
                .creation_flags(CREATE_NEW_CONSOLE)
                .spawn()
                .map(|_| ())
                .map_err(failed),
            "git-bash" => {
                let executable = git_bash_launcher()
                    .ok_or_else(|| AppError::NotFound("Git Bash is not installed".to_string()))?;
                let mut target = std::ffi::OsString::from("--cd=");
                target.push(workspace.as_os_str());
                Command::new(executable)
                    .arg(target)
                    .current_dir(&workspace)
                    .spawn()
                    .map(|_| ())
                    .map_err(failed)
            }
            _ => Err(AppError::InvalidInput(format!(
                "unsupported terminal app: {app_id}"
            ))),
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app_id;
        Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(&workspace)
            .spawn()
            .map(|_| ())
            .map_err(failed)
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app_id;
        Command::new("x-terminal-emulator")
            .current_dir(&workspace)
            .spawn()
            .map(|_| ())
            .map_err(failed)
    }
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
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let mut roots = Vec::new();
    if let Some(local) = &local_app_data {
        roots.push(local.join("Programs"));
    }
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable) {
            roots.push(PathBuf::from(root));
        }
    }

    let mut candidates = roots
        .iter()
        .flat_map(|root| {
            spec.install_directories.iter().flat_map(move |directory| {
                spec.executable_names
                    .iter()
                    .map(move |name| root.join(directory).join(name))
            })
        })
        .collect::<Vec<_>>();

    // Zed keeps its CLI next to the app; JetBrains IDEs keep theirs under bin/.
    if spec.id == "zed" {
        if let Some(local) = &local_app_data {
            candidates.push(
                local
                    .join("Programs")
                    .join("Zed")
                    .join("bin")
                    .join("zed.exe"),
            );
        }
    }

    if !spec.versioned_prefixes.is_empty() {
        let mut versioned_roots = roots.clone();
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(variable) {
                versioned_roots.push(PathBuf::from(root).join("JetBrains"));
            }
        }
        let mut found = versioned_roots
            .iter()
            .filter_map(|root| fs::read_dir(root).ok())
            .flat_map(|entries| entries.filter_map(Result::ok))
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                spec.versioned_prefixes
                    .iter()
                    .any(|prefix| name.starts_with(prefix))
            })
            .flat_map(|entry| {
                spec.executable_names
                    .iter()
                    .map(move |name| entry.path().join("bin").join(name))
            })
            .filter(|candidate| candidate.is_file())
            .collect::<Vec<_>>();
        // `WebStorm 2025.2` sorts after `WebStorm 2024.3`: prefer the newest install.
        found.sort();
        candidates.extend(found.into_iter().rev());
    }

    if !spec.scoop_name.is_empty() {
        if let Some(user_profile) = std::env::var_os("USERPROFILE") {
            let root = PathBuf::from(user_profile)
                .join("scoop")
                .join("apps")
                .join(spec.scoop_name)
                .join("current");
            candidates.extend(spec.executable_names.iter().map(|name| root.join(name)));
        }
    }
    candidates
}

/// Visual Studio installs are found through vswhere, which ships with the installer.
#[cfg(windows)]
fn visual_studio_executable() -> Option<PathBuf> {
    let installer_root = std::env::var_os("ProgramFiles(x86)")
        .or_else(|| std::env::var_os("ProgramFiles"))
        .map(PathBuf::from)?;
    let vswhere = installer_root
        .join("Microsoft Visual Studio")
        .join("Installer")
        .join("vswhere.exe");
    if !vswhere.is_file() {
        return None;
    }
    let output = hidden_command(&vswhere)
        .args(["-latest", "-prerelease", "-property", "productPath"])
        .output()
        .ok()?;
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    path.is_file().then_some(path)
}

#[cfg(windows)]
pub(crate) fn resolve_workspace_editor(spec: &WorkspaceEditorSpec) -> Option<PathBuf> {
    if spec.id == "visualstudio" {
        return visual_studio_executable();
    }
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
        assert_eq!(
            workspace_editor_spec("webstorm").map(|item| item.line_style),
            Some(EditorLineStyle::JetBrains)
        );
        assert!(workspace_editor_spec("unknown").is_none());
    }

    fn strings(args: Vec<std::ffi::OsString>) -> Vec<String> {
        args.into_iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn builds_line_arguments_per_editor_family() {
        let workspace = Path::new("/repo");
        let file = Path::new("/repo/src/app.ts");
        let spec = |id: &str| workspace_editor_spec(id).expect("editor spec should exist");

        assert_eq!(
            strings(editor_launch_args(
                spec("vscode"),
                Some(workspace),
                Some(file),
                Some(12),
                Some(4)
            )),
            ["/repo", "-g", "/repo/src/app.ts:12:4"]
        );
        assert_eq!(
            strings(editor_launch_args(
                spec("cursor"),
                None,
                Some(file),
                None,
                Some(4)
            )),
            ["/repo/src/app.ts"]
        );
        assert_eq!(
            strings(editor_launch_args(
                spec("zed"),
                Some(workspace),
                Some(file),
                Some(7),
                None
            )),
            ["/repo", "/repo/src/app.ts:7"]
        );
        assert_eq!(
            strings(editor_launch_args(
                spec("webstorm"),
                Some(workspace),
                Some(file),
                Some(3),
                Some(9)
            )),
            ["/repo", "--line", "3", "--column", "9", "/repo/src/app.ts"]
        );
        assert_eq!(
            strings(editor_launch_args(
                spec("notepadpp"),
                Some(workspace),
                Some(file),
                Some(40),
                None
            )),
            ["-n40", "/repo/src/app.ts"]
        );
        assert_eq!(
            strings(editor_launch_args(
                spec("notepadpp"),
                Some(workspace),
                None,
                None,
                None
            )),
            ["-openFoldersAsWorkspace", "/repo"]
        );
        assert_eq!(
            strings(editor_launch_args(
                spec("visualstudio"),
                Some(workspace),
                Some(file),
                Some(40),
                None
            )),
            ["/Edit", "/repo/src/app.ts"]
        );
        // Line 0 means "no line"; so does a column without a line.
        assert_eq!(
            strings(editor_launch_args(
                spec("vscode"),
                None,
                Some(file),
                Some(0),
                Some(3)
            )),
            ["/repo/src/app.ts"]
        );
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
