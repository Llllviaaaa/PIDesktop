//! Workspace registration: the project list the sidebar reads.

use std::path::Path;

use tauri::State;

use crate::error::AppError;
use crate::{normalize_path_key, projects_path, save_json_list, AppState, ProjectConfig};

#[tauri::command]
pub(crate) fn list_projects_cmd(
    state: State<'_, AppState>,
) -> Result<Vec<ProjectConfig>, AppError> {
    state
        .projects
        .lock()
        .map(|projects| projects.clone())
        .map_err(|_| AppError::locked("project"))
}

#[tauri::command(async)]
pub(crate) fn register_project_cmd(
    state: State<'_, AppState>,
    path: String,
) -> Result<ProjectConfig, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "project path is required".to_string(),
        ));
    }
    if !Path::new(&path).is_dir() {
        return Err(AppError::NotFound(
            "project directory does not exist".to_string(),
        ));
    }
    let key = normalize_path_key(&path);
    let mut projects = state
        .projects
        .lock()
        .map_err(|_| AppError::locked("project"))?;
    let project = if let Some(existing) = projects
        .iter_mut()
        .find(|project| normalize_path_key(&project.path) == key)
    {
        existing.path = path;
        existing.hidden = false;
        existing.clone()
    } else {
        let project = ProjectConfig {
            path,
            ..ProjectConfig::default()
        };
        projects.push(project.clone());
        project
    };
    save_json_list(&projects_path(), &projects)?;
    Ok(project)
}

#[tauri::command(async)]
pub(crate) fn save_project_cmd(
    state: State<'_, AppState>,
    project: ProjectConfig,
) -> Result<ProjectConfig, AppError> {
    if project.path.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "project path is required".to_string(),
        ));
    }
    let key = normalize_path_key(&project.path);
    let mut projects = state
        .projects
        .lock()
        .map_err(|_| AppError::locked("project"))?;
    if let Some(existing) = projects
        .iter_mut()
        .find(|entry| normalize_path_key(&entry.path) == key)
    {
        *existing = project.clone();
    } else {
        projects.push(project.clone());
    }
    save_json_list(&projects_path(), &projects)?;
    Ok(project)
}

#[tauri::command(async)]
pub(crate) fn remove_local_project_cmd(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), AppError> {
    let key = normalize_path_key(&path);
    let mut projects = state
        .projects
        .lock()
        .map_err(|_| AppError::locked("project"))?;
    if let Some(existing) = projects
        .iter_mut()
        .find(|project| normalize_path_key(&project.path) == key)
    {
        existing.hidden = true;
    } else {
        projects.push(ProjectConfig {
            path,
            hidden: true,
            ..ProjectConfig::default()
        });
    }
    save_json_list(&projects_path(), &projects)
}
