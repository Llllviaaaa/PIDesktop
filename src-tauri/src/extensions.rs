//! Bundled Pi extensions and the personal-instructions file.
//!
//! The TypeScript sources are embedded in the binary with `include_str!` and
//! written into the Pi config directory on demand, so a release ships one
//! executable and no loose script files.

use std::fs;
use std::path::PathBuf;

use crate::app_config_dir;

const GUARD_EXTENSION: &str = include_str!("../resources/pidesktop-guard.ts");
const RULES_MODULE: &str = include_str!("../resources/pidesktop-rules.ts");
const CHECKPOINTS_MODULE: &str = include_str!("../resources/pidesktop-checkpoints.ts");
const PLAN_CORE_MODULE: &str = include_str!("../resources/pidesktop-plan-core.ts");
const PLAN_EXTENSION: &str = include_str!("../resources/pidesktop-plan.ts");
const HOOKS_CORE_MODULE: &str = include_str!("../resources/pidesktop-hooks-core.ts");
const HOOKS_EXTENSION: &str = include_str!("../resources/pidesktop-hooks.ts");
const SUBAGENTS_CORE_MODULE: &str = include_str!("../resources/pidesktop-subagents-core.ts");
const SUBAGENTS_EXTENSION: &str = include_str!("../resources/pidesktop-subagents.ts");
const MEMORY_EXTENSION: &str = include_str!("../resources/pidesktop-memory.ts");
const MEMORY_CORE_MODULE: &str = include_str!("../resources/pidesktop-memory-core.ts");
const BROWSER_EXTENSION: &str = include_str!("../resources/pidesktop-browser.ts");
const COMPUTER_EXTENSION: &str = include_str!("../resources/pidesktop-computer.ts");
const MCP_EXTENSION: &str = include_str!("../resources/pidesktop-mcp.ts");
const PROVIDERS_CORE_MODULE: &str = include_str!("../resources/pidesktop-providers-core.ts");
const PROVIDERS_EXTENSION: &str = include_str!("../resources/pidesktop-providers.ts");

pub(crate) fn ensure_guard_extension() -> Result<PathBuf, String> {
    // Helper modules are imported by the guard extension; keep all files in sync on disk.
    ensure_bundled_extension("pidesktop-rules.ts", RULES_MODULE, "rules")?;
    ensure_bundled_extension(
        "pidesktop-checkpoints.ts",
        CHECKPOINTS_MODULE,
        "checkpoints",
    )?;
    ensure_bundled_extension("pidesktop-guard.ts", GUARD_EXTENSION, "guard")
}

pub(crate) fn ensure_browser_extension() -> Result<PathBuf, String> {
    // Imports the shared rule helpers; do not rely on the guard having written them first.
    ensure_bundled_extension("pidesktop-rules.ts", RULES_MODULE, "rules")?;
    ensure_bundled_extension("pidesktop-browser.ts", BROWSER_EXTENSION, "browser")
}

pub(crate) fn ensure_computer_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension("pidesktop-rules.ts", RULES_MODULE, "rules")?;
    ensure_bundled_extension("pidesktop-computer.ts", COMPUTER_EXTENSION, "computer")
}

pub(crate) fn ensure_mcp_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension("pidesktop-rules.ts", RULES_MODULE, "rules")?;
    ensure_bundled_extension("pidesktop-mcp.ts", MCP_EXTENSION, "MCP")
}

pub(crate) fn ensure_plan_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension("pidesktop-plan-core.ts", PLAN_CORE_MODULE, "plan core")?;
    ensure_bundled_extension("pidesktop-plan.ts", PLAN_EXTENSION, "plan")
}

pub(crate) fn ensure_hooks_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension("pidesktop-hooks-core.ts", HOOKS_CORE_MODULE, "hooks core")?;
    ensure_bundled_extension("pidesktop-hooks.ts", HOOKS_EXTENSION, "hooks")
}

pub(crate) fn ensure_subagents_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension(
        "pidesktop-subagents-core.ts",
        SUBAGENTS_CORE_MODULE,
        "subagents core",
    )?;
    ensure_bundled_extension("pidesktop-subagents.ts", SUBAGENTS_EXTENSION, "subagents")
}

pub(crate) fn ensure_providers_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension(
        "pidesktop-providers-core.ts",
        PROVIDERS_CORE_MODULE,
        "providers core",
    )?;
    ensure_bundled_extension("pidesktop-providers.ts", PROVIDERS_EXTENSION, "providers")
}

pub(crate) fn ensure_memory_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension(
        "pidesktop-memory-core.ts",
        MEMORY_CORE_MODULE,
        "memory core",
    )?;
    ensure_bundled_extension("pidesktop-memory.ts", MEMORY_EXTENSION, "memory")
}

pub(crate) fn ensure_bundled_extension(
    file_name: &str,
    contents: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let path = app_config_dir().join("extensions").join(file_name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create extension directory: {err}"))?;
    }
    let should_write = fs::read_to_string(&path)
        .map(|current| current != contents)
        .unwrap_or(true);
    if should_write {
        fs::write(&path, contents)
            .map_err(|err| format!("failed to install Pi Desktop {label} extension: {err}"))?;
    }
    Ok(path)
}

pub(crate) fn ensure_personal_instructions(contents: &str) -> Result<PathBuf, String> {
    let path = app_config_dir().join("personal-instructions.md");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create instructions directory: {err}"))?;
    }
    fs::write(&path, contents)
        .map_err(|err| format!("failed to write personal instructions: {err}"))?;
    Ok(path)
}
