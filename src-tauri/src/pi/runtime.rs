use std::path::{Path, PathBuf};

const DEFAULT_PI_BINARY: &str = "pi";

pub(crate) fn locate_bundled_pi_binary() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("pi-runtime").join("pi.exe"));
        }
    }
    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("pi-runtime")
            .join("pi.exe"),
    );
    candidates.into_iter().find(|candidate| candidate.is_file())
}

pub(crate) fn resolve_pi_binary(configured: &str, bundled: Option<&Path>) -> String {
    let normalized = configured.trim().trim_matches('"');
    if normalized.eq_ignore_ascii_case(DEFAULT_PI_BINARY) {
        if let Some(path) = bundled {
            return path.to_string_lossy().to_string();
        }
    }
    configured.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_binary_prefers_bundled_runtime() {
        let bundled = Path::new(r"C:\Program Files\Pi Desktop\pi-runtime\pi.exe");
        assert_eq!(
            resolve_pi_binary("pi", Some(bundled)),
            bundled.to_string_lossy()
        );
        assert_eq!(
            resolve_pi_binary("\"PI\"", Some(bundled)),
            bundled.to_string_lossy()
        );
    }

    #[test]
    fn custom_binary_is_never_replaced() {
        let bundled = Path::new(r"C:\Program Files\Pi Desktop\pi-runtime\pi.exe");
        let custom = r"D:\Tools\pi.cmd";
        assert_eq!(resolve_pi_binary(custom, Some(bundled)), custom);
        assert_eq!(resolve_pi_binary("pi", None), "pi");
    }
}
