//! Skills, themes and pets: listing them, installing themes and pets, and the
//! one-time copy from Pi's directories (P6a).

use crate::harness_host::harness_data_dir;
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

/// The folders of skills, themes and pets, which live where the Harness Host
/// reads them (P6a): `~/.pid/<folder>` for the user, `<project>/.pid/<folder>`.
const PID_RESOURCE_FOLDERS: [&str; 3] = ["skills", "themes", "pets"];

#[tauri::command(async)]
pub(crate) fn list_resources(cwd: String) -> Result<Vec<ResourceItem>, AppError> {
    let mut items = Vec::new();
    let user = harness_data_dir();
    collect_resources(&user.join("skills"), "skill", "user", &mut items);
    collect_resources(&user.join("themes"), "theme", "user", &mut items);
    collect_resources(&user.join("pets"), "pet", "user", &mut items);
    let workspace = PathBuf::from(cwd);
    let project_pid = workspace.join(".pid");
    collect_resources(&project_pid.join("skills"), "skill", "project", &mut items);
    collect_resources(
        &workspace.join(".agents").join("skills"),
        "skill",
        "project",
        &mut items,
    );
    collect_resources(&project_pid.join("themes"), "theme", "project", &mut items);
    collect_resources(&project_pid.join("pets"), "pet", "project", &mut items);
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
        "user" => Ok(harness_data_dir().join(folder)),
        "project" => Ok(validate_workspace_directory(cwd)?.join(".pid").join(folder)),
        _ => Err(AppError::InvalidInput(format!(
            "unsupported appearance extension scope: {scope}"
        ))),
    }
}

/// The skills, themes and pets under `source` that `destination` does not have
/// yet, copied unless `dry_run`; returns how many there are. An entry already
/// in `destination` is never replaced, and one that fails to copy is skipped.
pub(crate) fn copy_missing_resources(source: &Path, destination: &Path, dry_run: bool) -> usize {
    let mut count = 0;
    for folder in PID_RESOURCE_FOLDERS {
        let Ok(entries) = fs::read_dir(source.join(folder)) else {
            continue;
        };
        for entry in entries.flatten() {
            let target = destination.join(folder).join(entry.file_name());
            if target.exists() {
                continue;
            }
            if dry_run {
                count += 1;
                continue;
            }
            if fs::create_dir_all(destination.join(folder)).is_err() {
                continue;
            }
            let path = entry.path();
            let copied = if path.is_dir() {
                copy_appearance_directory(&path, &target).is_ok()
            } else {
                fs::copy(&path, &target).is_ok()
            };
            if copied {
                count += 1;
            }
        }
    }
    count
}

/// Copy the user's skills, themes and pets from Pi's config directory to
/// `~/.pid` once (P6a). A marker keeps an entry the user removes from
/// `~/.pid` afterwards from coming back.
pub(crate) fn migrate_pi_resources() {
    let data_dir = harness_data_dir();
    let marker = data_dir.join(".pi-resources-copied");
    if marker.exists() {
        return;
    }
    copy_missing_resources(&pi_agent_dir(), &data_dir, false);
    if fs::create_dir_all(&data_dir).is_ok() {
        let _ = fs::write(&marker, "");
    }
}

/// How many skills, themes and pets the workspace's `.pi/` has that its
/// `.pid/` lacks; settings offer to copy them over.
#[tauri::command(async)]
pub(crate) fn legacy_project_resources(cwd: String) -> Result<usize, AppError> {
    let workspace = validate_workspace_directory(&cwd)?;
    Ok(copy_missing_resources(
        &workspace.join(".pi"),
        &workspace.join(".pid"),
        true,
    ))
}

/// Copy the workspace's `.pi/` skills, themes and pets into `.pid/`.
#[tauri::command(async)]
pub(crate) fn migrate_project_resources(cwd: String) -> Result<usize, AppError> {
    let workspace = validate_workspace_directory(&cwd)?;
    Ok(copy_missing_resources(
        &workspace.join(".pi"),
        &workspace.join(".pid"),
        false,
    ))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_missing_skills_themes_and_pets_without_replacing_any() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "pid-desktop-resource-copy-{}-{stamp}",
            std::process::id()
        ));
        let source = root.join("pi");
        let destination = root.join("pid");
        fs::create_dir_all(source.join("skills/review")).expect("skill fixture");
        fs::write(
            source.join("skills/review/SKILL.md"),
            "---\nname: review\n---\n",
        )
        .expect("skill file");
        fs::create_dir_all(source.join("themes")).expect("theme fixture");
        fs::write(source.join("themes/ocean.json"), "{}").expect("theme file");
        fs::create_dir_all(destination.join("themes")).expect("existing theme dir");
        fs::write(destination.join("themes/ocean.json"), "mine").expect("existing theme");

        assert_eq!(copy_missing_resources(&source, &destination, true), 1);
        assert!(!destination.join("skills/review").exists());
        assert_eq!(copy_missing_resources(&source, &destination, false), 1);
        assert!(destination.join("skills/review/SKILL.md").is_file());
        assert_eq!(
            fs::read_to_string(destination.join("themes/ocean.json")).expect("theme"),
            "mine"
        );
        assert_eq!(copy_missing_resources(&source, &destination, false), 0);
        fs::remove_dir_all(root).ok();
    }

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
            workspace.join(".pid/themes/ocean.json")
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
            workspace.join(".pid/pets/comet")
        );
        assert!(workspace
            .join(".pid/pets/comet/sprites/comet.png")
            .is_file());

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
}
