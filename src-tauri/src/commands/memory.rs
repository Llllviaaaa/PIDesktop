//! The explicit local memory file.
//!
//! Pi writes durable user preferences here through the `desktop_memory` tool,
//! and Settings reads, exports and clears the same file.

use std::fs;
use std::path::PathBuf;

use crate::app_config_dir;

pub(crate) fn local_memory_path() -> PathBuf {
    app_config_dir().join("memory.md")
}

#[tauri::command(async)]
pub(crate) fn get_local_memory() -> Result<String, String> {
    let path = local_memory_path();
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|err| format!("failed to read local memory: {err}"))
}

#[tauri::command(async)]
pub(crate) fn set_local_memory(contents: String) -> Result<(), String> {
    const MAX_MEMORY_BYTES: usize = 256 * 1024;
    if contents.len() > MAX_MEMORY_BYTES {
        return Err("local memory cannot exceed 256 KB".to_string());
    }
    let path = local_memory_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create local memory directory: {err}"))?;
    }
    fs::write(&path, contents).map_err(|err| format!("failed to write local memory: {err}"))
}

#[tauri::command(async)]
pub(crate) fn export_local_memory(destination: String) -> Result<String, String> {
    let destination = PathBuf::from(destination.trim());
    if destination.as_os_str().is_empty() {
        return Err("memory export path is required".to_string());
    }
    let source = local_memory_path();
    if !source.is_file() {
        return Err("local memory is empty".to_string());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create memory export directory: {err}"))?;
    }
    fs::copy(&source, &destination)
        .map_err(|err| format!("failed to export local memory: {err}"))?;
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command(async)]
pub(crate) fn delete_local_memory() -> Result<(), String> {
    let path = local_memory_path();
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(path).map_err(|err| format!("failed to delete local memory: {err}"))
}
