//! The personal-instructions file the settings write and the Harness Host's
//! system prompt reads.

use crate::error::AppError;
use std::fs;
use std::path::PathBuf;

use crate::app_config_dir;

pub(crate) fn ensure_personal_instructions(contents: &str) -> Result<PathBuf, AppError> {
    let path = app_config_dir().join("personal-instructions.md");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            AppError::Io(format!("failed to create instructions directory: {err}"))
        })?;
    }
    fs::write(&path, contents)
        .map_err(|err| AppError::Io(format!("failed to write personal instructions: {err}")))?;
    Ok(path)
}
