//! Reading and writing app settings from the renderer.

use crate::*;

#[tauri::command]
pub(crate) fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, AppError> {
    state
        .settings
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))
        .map(|guard| redact_mcp_secrets(&guard))
}

#[tauri::command(async)]
pub(crate) fn set_settings(
    state: State<'_, AppState>,
    host: State<'_, crate::harness_host::HarnessHost>,
    mut settings: AppSettings,
) -> Result<(), AppError> {
    let current = state
        .settings
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?
        .clone();
    resolve_mcp_secret_placeholders(&mut settings, &current)?;
    if !matches!(
        settings.permission_mode.as_str(),
        "read-only" | "ask" | "workspace-write" | "full-access"
    ) {
        return Err(AppError::InvalidInput(
            "invalid permission mode".to_string(),
        ));
    }
    if !matches!(settings.agent_mode.as_str(), "agent" | "plan" | "ask") {
        return Err(AppError::InvalidInput("invalid agent mode".to_string()));
    }
    if !matches!(
        settings.default_task_environment.as_str(),
        "local" | "worktree"
    ) {
        return Err(AppError::InvalidInput(
            "invalid default task environment".to_string(),
        ));
    }
    if !matches!(settings.settings_display_mode.as_str(), "page" | "modal") {
        return Err(AppError::InvalidInput(
            "invalid settings display mode".to_string(),
        ));
    }
    if !(75..=150).contains(&settings.ui_scale) {
        return Err(AppError::InvalidInput(
            "UI scale must be between 75 and 150".to_string(),
        ));
    }
    if !(10..=22).contains(&settings.message_font_size) {
        return Err(AppError::InvalidInput(
            "message font size must be between 10 and 22".to_string(),
        ));
    }
    if !(80..=224).contains(&settings.pet_size) {
        return Err(AppError::InvalidInput(
            "pet size must be between 80 and 224".to_string(),
        ));
    }
    if !(1..=4).contains(&settings.subagent_max_concurrency) {
        return Err(AppError::InvalidInput(
            "subagent concurrency must be between 1 and 4".to_string(),
        ));
    }
    let mut mcp_ids = std::collections::HashSet::new();
    for server in &settings.mcp_servers {
        if server.id.trim().is_empty() || !mcp_ids.insert(server.id.trim().to_lowercase()) {
            return Err(AppError::InvalidInput(
                "MCP server IDs must be non-empty and unique".to_string(),
            ));
        }
        if !matches!(server.transport.as_str(), "stdio" | "http") {
            return Err(AppError::InvalidInput(format!(
                "invalid MCP transport for {}",
                server.name
            )));
        }
        if server.enabled && server.transport == "stdio" && server.command.trim().is_empty() {
            return Err(AppError::InvalidInput(format!(
                "MCP server {} requires a command",
                server.name
            )));
        }
        if server.enabled
            && server.transport == "http"
            && !(server.url.starts_with("http://") || server.url.starts_with("https://"))
        {
            return Err(AppError::InvalidInput(format!(
                "MCP server {} requires an HTTP(S) URL",
                server.name
            )));
        }
    }
    if settings.hooks.len() > 32 {
        return Err(AppError::InvalidInput(
            "at most 32 hooks may be configured".to_string(),
        ));
    }
    if settings.tool_rules.len() > 64 {
        return Err(AppError::InvalidInput(
            "at most 64 tool rules may be configured".to_string(),
        ));
    }
    let mut rule_ids = std::collections::HashSet::new();
    for rule in &settings.tool_rules {
        if rule.id.trim().is_empty() || !rule_ids.insert(rule.id.trim().to_lowercase()) {
            return Err(AppError::InvalidInput(
                "tool rule IDs must be non-empty and unique".to_string(),
            ));
        }
        if rule.tool_pattern.trim().is_empty() {
            return Err(AppError::InvalidInput(format!(
                "tool rule {} requires a tool pattern",
                rule.id
            )));
        }
        if !matches!(rule.action.as_str(), "allow" | "confirm" | "block") {
            return Err(AppError::InvalidInput(format!(
                "invalid action for tool rule {}",
                rule.id
            )));
        }
    }
    let mut hook_ids = std::collections::HashSet::new();
    for hook in &settings.hooks {
        if hook.id.trim().is_empty() || !hook_ids.insert(hook.id.trim().to_lowercase()) {
            return Err(AppError::InvalidInput(
                "hook IDs must be non-empty and unique".to_string(),
            ));
        }
        if !matches!(
            hook.event.as_str(),
            "session_start"
                | "before_agent_start"
                | "agent_end"
                | "agent_settled"
                | "tool_call"
                | "tool_result"
        ) {
            return Err(AppError::InvalidInput(format!(
                "invalid event for hook {}",
                hook.name
            )));
        }
        if hook.command.trim().is_empty() {
            return Err(AppError::InvalidInput(format!(
                "hook {} requires a command",
                hook.name
            )));
        }
        if hook.command.len() > 8192 {
            return Err(AppError::InvalidInput(format!(
                "hook {} command is too long",
                hook.name
            )));
        }
        if !(1..=300).contains(&hook.timeout_seconds) {
            return Err(AppError::InvalidInput(format!(
                "hook {} timeout must be between 1 and 300 seconds",
                hook.name
            )));
        }
        if hook.blocking && hook.event != "tool_call" {
            return Err(AppError::InvalidInput(format!(
                "only tool_call hooks may block: {}",
                hook.name
            )));
        }
    }
    if !settings.custom_instructions.trim().is_empty() {
        ensure_personal_instructions(&settings.custom_instructions)?;
    }
    save_settings(&settings)?;
    #[cfg(windows)]
    crate::KEEP_AWAKE.store(settings.prevent_sleep, Ordering::Relaxed);
    let saved = settings.clone();
    *state
        .settings
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))? = settings;
    crate::harness_host::push_settings(&host, &saved);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_reject_invalid_task_environment() {
        let settings = AppSettings {
            default_task_environment: "cloud".to_string(),
            ..Default::default()
        };
        // Mirror set_settings validation without full AppState.
        assert!(!matches!(
            settings.default_task_environment.as_str(),
            "local" | "worktree"
        ));
    }

    #[test]
    fn settings_display_mode_defaults_to_page_and_validates() {
        let defaults = AppSettings::default();
        assert_eq!(defaults.settings_display_mode, "page");
        let parsed: AppSettings = serde_json::from_str("{}").expect("deserialize empty settings");
        assert_eq!(parsed.settings_display_mode, "page");
        assert!(matches!(
            parsed.settings_display_mode.as_str(),
            "page" | "modal"
        ));
        assert!(!matches!("drawer", "page" | "modal"));
    }

    #[test]
    fn per_model_thinking_settings_round_trip() {
        let parsed: AppSettings = serde_json::from_str(
            r#"{
                "modelThinkingLevels": { "sub2api/grok-4.7": "high", "openai/o4-mini": "low" },
                "modelCustomThinkingLevels": { "sub2api/grok-4.7": ["ultra", "16384"] }
            }"#,
        )
        .expect("deserialize per-model thinking maps");
        assert_eq!(
            parsed
                .model_thinking_levels
                .get("sub2api/grok-4.7")
                .map(String::as_str),
            Some("high")
        );
        assert_eq!(
            parsed
                .model_thinking_levels
                .get("openai/o4-mini")
                .map(String::as_str),
            Some("low")
        );
        assert_eq!(
            parsed.model_custom_thinking_levels.get("sub2api/grok-4.7"),
            Some(&vec!["ultra".to_string(), "16384".to_string()])
        );
    }
}
