//! Pi resources and packages: the npm marketplace, installs, and appearance extensions.

use crate::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceItem {
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) scope: String,
    pub(crate) version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageCatalogItem {
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) description: String,
    pub(crate) author: String,
    pub(crate) published_at: String,
    pub(crate) downloads: u64,
    pub(crate) score: f64,
    pub(crate) keywords: Vec<String>,
    pub(crate) npm_url: String,
    pub(crate) repository_url: Option<String>,
    pub(crate) homepage_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageCatalogPage {
    pub(crate) items: Vec<PackageCatalogItem>,
    pub(crate) total: u64,
    pub(crate) page: u32,
    pub(crate) page_size: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageCatalogDetail {
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) description: String,
    pub(crate) author: String,
    pub(crate) license: String,
    pub(crate) keywords: Vec<String>,
    pub(crate) npm_url: String,
    pub(crate) repository_url: Option<String>,
    pub(crate) homepage_url: Option<String>,
    pub(crate) image_url: Option<String>,
    pub(crate) video_url: Option<String>,
    pub(crate) extensions: Vec<String>,
    pub(crate) skills: Vec<String>,
    pub(crate) prompts: Vec<String>,
    pub(crate) themes: Vec<String>,
    pub(crate) dependency_count: u64,
    pub(crate) peer_dependency_count: u64,
    pub(crate) unpacked_size: u64,
    pub(crate) integrity: String,
}

pub(crate) fn package_sources_from_settings(value: &serde_json::Value) -> Vec<String> {
    value
        .get("packages")
        .and_then(|entry| entry.as_array())
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            entry
                .as_str()
                .or_else(|| entry.get("source").and_then(|source| source.as_str()))
        })
        .map(str::trim)
        .filter(|source| !source.is_empty())
        .map(str::to_string)
        .collect()
}

pub(crate) fn npm_package_name(source: &str) -> Option<String> {
    let value = source.trim().strip_prefix("npm:").unwrap_or(source.trim());
    if value.is_empty() || value.contains("://") || value.starts_with("git:") {
        return None;
    }
    if value.starts_with('@') {
        let slash = value.find('/')?;
        let version = value[slash + 1..].rfind('@').map(|index| slash + 1 + index);
        return Some(value[..version.unwrap_or(value.len())].to_string());
    }
    Some(value.split('@').next().unwrap_or(value).to_string())
}

pub(crate) fn installed_package_version(scope_root: &Path, source: &str) -> Option<String> {
    let name = npm_package_name(source)?;
    let manifest = scope_root
        .join("npm")
        .join("node_modules")
        .join(name)
        .join("package.json");
    let value =
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(manifest).ok()?).ok()?;
    value
        .get("version")
        .and_then(|entry| entry.as_str())
        .map(str::to_string)
}

pub(crate) fn collect_package_settings(
    settings_path: &Path,
    scope_root: &Path,
    scope: &str,
    items: &mut Vec<ResourceItem>,
) {
    let Ok(raw) = fs::read_to_string(settings_path) else {
        return;
    };
    let Ok(value) = json5::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    for source in package_sources_from_settings(&value) {
        items.push(ResourceItem {
            kind: "package".to_string(),
            name: npm_package_name(&source).unwrap_or_else(|| source.clone()),
            version: installed_package_version(scope_root, &source),
            path: source,
            scope: scope.to_string(),
        });
    }
}

#[tauri::command(async)]
pub(crate) fn list_resources(cwd: String) -> Result<Vec<ResourceItem>, AppError> {
    let mut items = Vec::new();
    let agent = pi_agent_dir();
    collect_resources(&agent.join("extensions"), "extension", "user", &mut items);
    collect_resources(&agent.join("skills"), "skill", "user", &mut items);
    collect_resources(&agent.join("prompts"), "prompt", "user", &mut items);
    collect_resources(&agent.join("themes"), "theme", "user", &mut items);
    collect_resources(&agent.join("pets"), "pet", "user", &mut items);
    collect_package_settings(&agent.join("settings.json"), &agent, "user", &mut items);
    let project = PathBuf::from(cwd).join(".pi");
    collect_resources(
        &project.join("extensions"),
        "extension",
        "project",
        &mut items,
    );
    collect_resources(&project.join("skills"), "skill", "project", &mut items);
    collect_resources(&project.join("prompts"), "prompt", "project", &mut items);
    collect_resources(&project.join("themes"), "theme", "project", &mut items);
    collect_resources(&project.join("pets"), "pet", "project", &mut items);
    collect_package_settings(
        &project.join("settings.json"),
        &project,
        "project",
        &mut items,
    );
    items.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
    Ok(items)
}

pub(crate) fn appearance_directory(
    cwd: &str,
    kind: &str,
    scope: &str,
) -> Result<PathBuf, AppError> {
    let folder = match kind {
        "theme" => "themes",
        "pet" => "pets",
        _ => {
            return Err(AppError::InvalidInput(format!(
                "unsupported appearance extension kind: {kind}"
            )))
        }
    };
    match scope {
        "user" => Ok(pi_agent_dir().join(folder)),
        "project" => Ok(validate_workspace_directory(cwd)?.join(".pi").join(folder)),
        _ => Err(AppError::InvalidInput(format!(
            "unsupported appearance extension scope: {scope}"
        ))),
    }
}

pub(crate) fn validate_json_object(path: &Path, label: &str) -> Result<(), AppError> {
    let raw = fs::read_to_string(path)
        .map_err(|err| AppError::Io(format!("failed to read {label}: {err}")))?;
    let value = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|err| AppError::InvalidInput(format!("{label} is not valid JSON: {err}")))?;
    if !value.is_object() {
        return Err(AppError::InvalidInput(format!(
            "{label} must contain a JSON object"
        )));
    }
    Ok(())
}

pub(crate) fn copy_appearance_directory(source: &Path, destination: &Path) -> Result<(), AppError> {
    fs::create_dir(destination)
        .map_err(|err| AppError::Io(format!("failed to create pet directory: {err}")))?;
    for entry in fs::read_dir(source)
        .map_err(|err| AppError::Io(format!("failed to read pet directory: {err}")))?
    {
        let entry = entry
            .map_err(|err| AppError::Io(format!("failed to read pet directory entry: {err}")))?;
        let file_type = entry
            .file_type()
            .map_err(|err| AppError::Io(format!("failed to inspect pet directory entry: {err}")))?;
        if file_type.is_symlink() {
            return Err(AppError::InvalidInput(
                "pet directories cannot contain symbolic links".to_string(),
            ));
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_appearance_directory(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)
                .map_err(|err| AppError::Io(format!("failed to copy pet asset: {err}")))?;
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn open_appearance_directory(
    cwd: String,
    kind: String,
    scope: String,
) -> Result<String, AppError> {
    let directory = appearance_directory(&cwd, &kind, &scope)?;
    fs::create_dir_all(&directory).map_err(|err| {
        AppError::Io(format!(
            "failed to create appearance extension directory: {err}"
        ))
    })?;
    let path = directory.to_string_lossy().to_string();
    open_workspace_in_file_manager(path.clone())?;
    Ok(path)
}

#[tauri::command(async)]
pub(crate) fn install_appearance_extension(
    source: String,
    cwd: String,
    kind: String,
    scope: String,
) -> Result<String, AppError> {
    let source = fs::canonicalize(&source)
        .map_err(|err| AppError::Io(format!("failed to resolve the selected extension: {err}")))?;
    let target_root = appearance_directory(&cwd, &kind, &scope)?;
    fs::create_dir_all(&target_root).map_err(|err| {
        AppError::Io(format!(
            "failed to create appearance extension directory: {err}"
        ))
    })?;
    let canonical_target_root = fs::canonicalize(&target_root).map_err(|err| {
        AppError::Io(format!(
            "failed to resolve appearance extension directory: {err}"
        ))
    })?;

    let destination = if kind == "theme" {
        if !source.is_file()
            || source
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                != Some("json".to_string())
        {
            return Err(AppError::InvalidInput(
                "a theme extension must be a JSON file".to_string(),
            ));
        }
        validate_json_object(&source, "theme file")?;
        let name = source.file_name().ok_or_else(|| {
            AppError::InvalidInput("the selected theme has no file name".to_string())
        })?;
        let destination = target_root.join(name);
        if destination.exists() {
            if fs::canonicalize(&destination).ok().as_ref() == Some(&source) {
                return Ok(destination.to_string_lossy().to_string());
            }
            return Err(AppError::InvalidInput(format!(
                "a theme named {} already exists",
                name.to_string_lossy()
            )));
        }
        fs::copy(&source, &destination)
            .map_err(|err| AppError::Io(format!("failed to import the theme: {err}")))?;
        destination
    } else {
        let source_directory = if source.is_dir() {
            source
        } else if source.file_name().and_then(|value| value.to_str()) == Some("pet.json") {
            source.parent().map(Path::to_path_buf).ok_or_else(|| {
                AppError::NotFound("cannot resolve the selected pet directory".to_string())
            })?
        } else {
            return Err(AppError::InvalidInput(
                "a pet extension must be a directory containing pet.json".to_string(),
            ));
        };
        let manifest = source_directory.join("pet.json");
        if !manifest.is_file() {
            return Err(AppError::InvalidInput(
                "the selected pet directory does not contain pet.json".to_string(),
            ));
        }
        validate_json_object(&manifest, "pet.json")?;
        if canonical_target_root.starts_with(&source_directory) {
            return Err(AppError::InvalidInput(
                "the selected pet directory cannot contain the extension destination".to_string(),
            ));
        }
        let name = source_directory.file_name().ok_or_else(|| {
            AppError::InvalidInput("the selected pet directory has no name".to_string())
        })?;
        let destination = target_root.join(name);
        if destination.exists() {
            if fs::canonicalize(&destination).ok().as_ref() == Some(&source_directory) {
                return Ok(destination.to_string_lossy().to_string());
            }
            return Err(AppError::InvalidInput(format!(
                "a pet named {} already exists",
                name.to_string_lossy()
            )));
        }
        copy_appearance_directory(&source_directory, &destination)?;
        destination
    };
    Ok(destination.to_string_lossy().to_string())
}

pub(crate) fn collect_resources(
    root: &Path,
    kind: &str,
    scope: &str,
    items: &mut Vec<ResourceItem>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_stem()
            .or_else(|| path.file_name())
            .and_then(|value| value.to_str())
            .unwrap_or("resource")
            .to_string();
        items.push(ResourceItem {
            kind: kind.to_string(),
            name,
            path: path.to_string_lossy().to_string(),
            scope: scope.to_string(),
            version: None,
        });
    }
}

pub(crate) fn json_string(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(|entry| entry.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub(crate) fn json_string_list(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::Array(entries)) => entries
            .iter()
            .filter_map(|entry| entry.as_str())
            .map(str::to_string)
            .collect(),
        Some(serde_json::Value::String(entry)) => vec![entry.clone()],
        _ => Vec::new(),
    }
}

pub(crate) fn package_author(value: &serde_json::Value) -> String {
    value
        .get("author")
        .and_then(|entry| {
            entry
                .as_str()
                .or_else(|| entry.get("name").and_then(|name| name.as_str()))
        })
        .or_else(|| {
            value
                .pointer("/publisher/username")
                .and_then(|entry| entry.as_str())
        })
        .unwrap_or_default()
        .to_string()
}

pub(crate) fn package_link(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .pointer(&format!("/links/{field}"))
        .and_then(|entry| entry.as_str())
        .or_else(|| {
            value.get(field).and_then(|entry| {
                entry
                    .as_str()
                    .or_else(|| entry.get("url").and_then(|url| url.as_str()))
            })
        })
        .and_then(safe_external_url)
}

pub(crate) fn safe_external_url(entry: &str) -> Option<String> {
    let entry = entry.trim().trim_start_matches("git+");
    if entry.starts_with("https://") || entry.starts_with("http://") {
        return Some(entry.to_string());
    }
    entry
        .strip_prefix("git://github.com/")
        .map(|path| format!("https://github.com/{}", path.trim_end_matches(".git")))
}

pub(crate) fn npm_registry_json(url: &str) -> Result<serde_json::Value, AppError> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(18))
        .user_agent("PiDesktop/0.2 package-marketplace")
        .build();
    let response = agent
        .get(url)
        .call()
        .map_err(|err| AppError::Network(format!("无法连接 npm Registry: {err}")))?;
    response
        .into_json::<serde_json::Value>()
        .map_err(|err| AppError::Network(format!("npm Registry 返回了无效数据: {err}")))
}

pub(crate) async fn run_marketplace_request<T, F>(request: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(request)
        .await
        .map_err(|err| AppError::Process(format!("插件市场后台任务失败: {err}")))?
}

pub(crate) fn search_pi_packages_blocking(
    query: String,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<PackageCatalogPage, AppError> {
    let query = query.trim();
    if query.chars().count() > 120 {
        return Err(AppError::InvalidInput(
            "搜索词不能超过 120 个字符".to_string(),
        ));
    }
    let page = page.unwrap_or(0);
    let page_size = page_size.unwrap_or(30).clamp(1, 50);
    let text = if query.is_empty() {
        "keywords:pi-package".to_string()
    } else {
        format!("keywords:pi-package {query}")
    };
    let url = format!(
        "https://registry.npmjs.org/-/v1/search?text={}&size={page_size}&from={}",
        urlencoding::encode(&text),
        page.saturating_mul(page_size)
    );
    let value = npm_registry_json(&url)?;
    let total = value
        .get("total")
        .and_then(|entry| entry.as_u64())
        .unwrap_or(0);
    let items = value
        .get("objects")
        .and_then(|entry| entry.as_array())
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let package = entry.get("package")?;
            let keywords = json_string_list(package.get("keywords"));
            if !keywords.iter().any(|keyword| keyword == "pi-package") {
                return None;
            }
            let name = json_string(package.get("name"));
            if name.is_empty() {
                return None;
            }
            Some(PackageCatalogItem {
                npm_url: package_link(package, "npm")
                    .unwrap_or_else(|| format!("https://www.npmjs.com/package/{name}")),
                repository_url: package_link(package, "repository"),
                homepage_url: package_link(package, "homepage"),
                name,
                version: json_string(package.get("version")),
                description: json_string(package.get("description")),
                author: package_author(package),
                published_at: json_string(package.get("date")),
                downloads: entry
                    .pointer("/downloads/monthly")
                    .and_then(|item| item.as_u64())
                    .unwrap_or(0),
                score: entry
                    .pointer("/score/final")
                    .and_then(|item| item.as_f64())
                    .unwrap_or(0.0),
                keywords,
            })
        })
        .collect();
    Ok(PackageCatalogPage {
        items,
        total,
        page,
        page_size,
    })
}

#[tauri::command]
pub(crate) async fn search_pi_packages(
    query: String,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<PackageCatalogPage, AppError> {
    run_marketplace_request(move || search_pi_packages_blocking(query, page, page_size)).await
}

pub(crate) fn pi_package_detail_blocking(name: String) -> Result<PackageCatalogDetail, AppError> {
    let name = npm_package_name(&name)
        .ok_or_else(|| AppError::InvalidInput("无效的 npm 软件包名称".to_string()))?;
    if name.chars().count() > 214 {
        return Err(AppError::InvalidInput("npm 软件包名称过长".to_string()));
    }
    let url = format!(
        "https://registry.npmjs.org/{}/latest",
        urlencoding::encode(&name)
    );
    let value = npm_registry_json(&url)?;
    let keywords = json_string_list(value.get("keywords"));
    if !keywords.iter().any(|keyword| keyword == "pi-package") {
        return Err(AppError::NotFound(
            "该软件包没有 pi-package 标记，未进入 Pi 官方目录".to_string(),
        ));
    }
    let manifest = value.get("pi").cloned().unwrap_or(serde_json::Value::Null);
    let license = value
        .get("license")
        .and_then(|entry| {
            entry
                .as_str()
                .or_else(|| entry.get("type").and_then(|item| item.as_str()))
        })
        .unwrap_or("未声明")
        .to_string();
    Ok(PackageCatalogDetail {
        npm_url: format!("https://www.npmjs.com/package/{name}"),
        repository_url: package_link(&value, "repository"),
        homepage_url: package_link(&value, "homepage"),
        name,
        version: json_string(value.get("version")),
        description: json_string(value.get("description")),
        author: package_author(&value),
        license,
        keywords,
        image_url: manifest
            .get("image")
            .and_then(|entry| entry.as_str())
            .and_then(safe_external_url),
        video_url: manifest
            .get("video")
            .and_then(|entry| entry.as_str())
            .and_then(safe_external_url),
        extensions: json_string_list(manifest.get("extensions")),
        skills: json_string_list(manifest.get("skills")),
        prompts: json_string_list(manifest.get("prompts")),
        themes: json_string_list(manifest.get("themes")),
        dependency_count: value
            .get("dependencies")
            .and_then(|entry| entry.as_object())
            .map(|entry| entry.len() as u64)
            .unwrap_or(0),
        peer_dependency_count: value
            .get("peerDependencies")
            .and_then(|entry| entry.as_object())
            .map(|entry| entry.len() as u64)
            .unwrap_or(0),
        unpacked_size: value
            .pointer("/dist/unpackedSize")
            .and_then(|entry| entry.as_u64())
            .unwrap_or(0),
        integrity: json_string(value.pointer("/dist/integrity")),
    })
}

#[tauri::command]
pub(crate) async fn pi_package_detail(name: String) -> Result<PackageCatalogDetail, AppError> {
    run_marketplace_request(move || pi_package_detail_blocking(name)).await
}

#[tauri::command(async)]
pub(crate) fn pi_package_action(
    state: State<'_, AppState>,
    action: String,
    source: Option<String>,
    cwd: Option<String>,
    scope: Option<String>,
) -> Result<String, AppError> {
    if !matches!(action.as_str(), "install" | "remove" | "update") {
        return Err(AppError::InvalidInput(
            "unsupported Pi package action".to_string(),
        ));
    }
    let settings = state
        .settings
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?
        .clone();
    let pi_binary = effective_pi_binary(&settings, &state);
    let working_directory = cwd
        .filter(|value| Path::new(value).is_dir())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    let scope = scope.unwrap_or_else(|| "user".to_string());
    if !matches!(scope.as_str(), "user" | "project") {
        return Err(AppError::InvalidInput(
            "unsupported Pi package scope".to_string(),
        ));
    }
    let source = source
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut arguments = match action.as_str() {
        "install" | "remove" => {
            let value = source.clone().ok_or_else(|| {
                AppError::InvalidInput("Pi package source is required".to_string())
            })?;
            vec![action.clone(), value]
        }
        "update" => source
            .clone()
            .map(|value| vec!["update".to_string(), "--extension".to_string(), value])
            .unwrap_or_else(|| vec!["update".to_string(), "--extensions".to_string()]),
        _ => unreachable!(),
    };
    if scope == "project" && matches!(action.as_str(), "install" | "remove") {
        arguments.extend(["-l".to_string(), "--approve".to_string()]);
    }

    #[cfg(windows)]
    let mut command = {
        let mut command = if let Some((node, cli)) = resolve_windows_pi_node_command(&pi_binary) {
            let mut command = Command::new(node);
            command.arg(cli).args(&arguments);
            command
        } else if Path::new(&pi_binary)
            .extension()
            .and_then(|entry| entry.to_str())
            .is_some_and(|entry| entry.eq_ignore_ascii_case("exe"))
        {
            let mut command = Command::new(&pi_binary);
            command.args(&arguments);
            command
        } else {
            let command_line = std::iter::once(pi_binary.as_str())
                .chain(arguments.iter().map(String::as_str))
                .map(|value| format!("\"{}\"", value.replace('%', "%%").replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" ");
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/S", "/C", &command_line]);
            command
        };
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(&pi_binary);
        command.args(&arguments);
        command
    };
    apply_pi_config(&mut command);
    let output = command
        .current_dir(working_directory)
        .output()
        .map_err(|err| AppError::Process(format!("failed to run Pi package command: {err}")))?;
    let stdout = redact_runtime_output(&settings, String::from_utf8_lossy(&output.stdout).trim());
    let stderr = redact_runtime_output(&settings, String::from_utf8_lossy(&output.stderr).trim());
    if output.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.is_empty() {
            AppError::Process(format!(
                "Pi package command exited with {}",
                output.status.code().unwrap_or(-1)
            ))
        } else {
            AppError::Process(stderr)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_theme_and_pet_extensions_into_project_scope() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "pid-desktop-appearance-import-{}-{stamp}",
            std::process::id()
        ));
        let workspace = root.join("workspace");
        let sources = root.join("sources");
        fs::create_dir_all(&workspace).expect("temporary workspace should be created");
        fs::create_dir_all(&sources).expect("temporary source directory should be created");

        let theme = sources.join("ocean.json");
        fs::write(&theme, r#"{ "name": "ocean" }"#).expect("theme fixture should be written");
        let installed_theme = install_appearance_extension(
            theme.to_string_lossy().to_string(),
            workspace.to_string_lossy().to_string(),
            "theme".to_string(),
            "project".to_string(),
        )
        .expect("theme should import");
        assert_eq!(
            PathBuf::from(installed_theme),
            workspace.join(".pi/themes/ocean.json")
        );

        let pet = sources.join("comet");
        fs::create_dir_all(pet.join("sprites")).expect("pet fixture should be created");
        fs::write(
            pet.join("pet.json"),
            r#"{ "id": "comet", "asset": "sprites/comet.png" }"#,
        )
        .expect("pet manifest should be written");
        fs::write(pet.join("sprites/comet.png"), b"png").expect("pet asset should be written");
        let installed_pet = install_appearance_extension(
            pet.to_string_lossy().to_string(),
            workspace.to_string_lossy().to_string(),
            "pet".to_string(),
            "project".to_string(),
        )
        .expect("pet should import");
        assert_eq!(
            PathBuf::from(installed_pet),
            workspace.join(".pi/pets/comet")
        );
        assert!(workspace.join(".pi/pets/comet/sprites/comet.png").is_file());

        assert!(install_appearance_extension(
            theme.to_string_lossy().to_string(),
            workspace.to_string_lossy().to_string(),
            "theme".to_string(),
            "project".to_string(),
        )
        .is_err());
        assert!(
            appearance_directory(&workspace.to_string_lossy(), "unsupported", "project").is_err()
        );

        fs::remove_dir_all(root).expect("temporary appearance fixture should be removed");
    }

    #[test]
    fn reads_string_and_filtered_package_settings() {
        let value = serde_json::json!({
            "packages": [
                "npm:plain-package",
                { "source": "npm:@scope/filtered@2.0.0", "skills": [] },
                { "skills": ["missing-source"] },
                42
            ]
        });
        assert_eq!(
            package_sources_from_settings(&value),
            vec!["npm:plain-package", "npm:@scope/filtered@2.0.0"]
        );
        assert_eq!(
            npm_package_name("npm:plain-package@1.2.0").as_deref(),
            Some("plain-package")
        );
        assert_eq!(
            npm_package_name("npm:@scope/filtered@2.0.0").as_deref(),
            Some("@scope/filtered")
        );
        assert!(npm_package_name("git:github.com/example/package").is_none());
    }

    #[test]
    fn filters_marketplace_external_urls() {
        assert_eq!(
            safe_external_url("git+https://github.com/example/package.git").as_deref(),
            Some("https://github.com/example/package.git")
        );
        assert_eq!(
            safe_external_url("git://github.com/example/package.git").as_deref(),
            Some("https://github.com/example/package")
        );
        assert!(safe_external_url("javascript:alert(1)").is_none());
        assert!(safe_external_url("file:///C:/private.txt").is_none());
    }

    #[test]
    fn marketplace_requests_run_off_the_command_thread() {
        let command_thread = std::thread::current().id();
        let worker_thread = tauri::async_runtime::block_on(run_marketplace_request(|| {
            Ok::<_, AppError>(std::thread::current().id())
        }))
        .expect("marketplace worker should complete");
        assert_ne!(command_thread, worker_thread);
    }
}
