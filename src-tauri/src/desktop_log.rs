//! The desktop's log on disk (docs/archive/REFACTOR_V2_P7.md, 3.3): its own messages
//! and the Harness Host's stderr, one file a day beside the Host's in
//! `~/.qianji/logs`, kept for a week and redacted line by line. Every line also
//! still goes to stderr.

use std::backtrace::Backtrace;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once, OnceLock, TryLockError};

use chrono::{Days, Local, NaiveDate};
use regex::Regex;

use crate::harness_host::harness_data_dir;

/// `eprintln!` that also writes the line to the desktop's log file.
macro_rules! log_line {
    ($($arg:tt)*) => {
        $crate::desktop_log::log(&format!($($arg)*))
    };
}

const PREFIX: &str = "desktop";
const KEEP_DAYS: u64 = 7;
const MAX_FRONTEND_SOURCE_CHARS: usize = 120;
const MAX_FRONTEND_MESSAGE_CHARS: usize = 4_000;
const MAX_FRONTEND_STACK_CHARS: usize = 12_000;
const MAX_BACKTRACE_CHARS: usize = 16_000;

struct Today {
    date: NaiveDate,
    file: File,
}

static LOG: Mutex<Option<Today>> = Mutex::new(None);
static PANIC_HOOK_INSTALLED: Once = Once::new();

/// Where the desktop and the Host keep their logs.
pub(crate) fn logs_dir() -> PathBuf {
    harness_data_dir().join("logs")
}

/// Write `line` to stderr and, redacted, to today's file.
pub(crate) fn log(line: &str) {
    eprintln!("{line}");
    write_redacted_to_dir(&logs_dir(), line, false);
}

fn write_redacted_to_dir(dir: &Path, line: &str, use_direct_append: bool) {
    let now = Local::now();
    let date = now.date_naive();
    let entry = format!("{} {}\n", now.to_rfc3339(), redact(line));

    if !use_direct_append {
        match LOG.try_lock() {
            Ok(mut state) => {
                write_with_cached_handle(&mut state, dir, date, &entry);
                return;
            }
            Err(TryLockError::Poisoned(poisoned)) => {
                let mut state = poisoned.into_inner();
                write_with_cached_handle(&mut state, dir, date, &entry);
                return;
            }
            Err(TryLockError::WouldBlock) => {
                // Fall through to direct append so re-entrant panic logging never deadlocks.
            }
        }
    }

    append_direct(dir, date, &entry);
}

fn write_with_cached_handle(state: &mut Option<Today>, dir: &Path, date: NaiveDate, entry: &str) {
    if state.as_ref().map(|today| today.date) != Some(date) {
        *state = open(dir, date);
    }
    if let Some(today) = state.as_mut() {
        let _ = today.file.write_all(entry.as_bytes());
        let _ = today.file.flush();
    }
}

fn append_direct(dir: &Path, date: NaiveDate, entry: &str) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(file_name(date)))
    {
        let _ = file.write_all(entry.as_bytes());
        let _ = file.flush();
    }
}

fn truncate_chars(input: &str, max_chars: usize) -> String {
    let mut chars = input.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}…[truncated]")
    } else {
        truncated
    }
}

fn panic_payload_message<'a>(info: &'a PanicHookInfo<'_>) -> &'a str {
    if let Some(text) = info.payload().downcast_ref::<&str>() {
        text
    } else if let Some(text) = info.payload().downcast_ref::<String>() {
        text.as_str()
    } else {
        "<non-string panic payload>"
    }
}

fn format_panic_report(
    thread_name: &str,
    pid: u32,
    location: Option<(&str, u32, u32)>,
    payload: &str,
    backtrace: &str,
) -> String {
    let where_at = match location {
        Some((file, line, col)) => format!("{file}:{line}:{col}"),
        None => "<unknown>".to_string(),
    };
    let clean_payload = truncate_chars(payload.trim(), MAX_FRONTEND_MESSAGE_CHARS);
    let clean_bt = truncate_chars(backtrace.trim(), MAX_BACKTRACE_CHARS);
    if clean_bt.is_empty() {
        format!("[panic] pid={pid} thread={thread_name} at {where_at}: {clean_payload}")
    } else {
        format!(
            "[panic] pid={pid} thread={thread_name} at {where_at}: {clean_payload}\nBacktrace:\n{clean_bt}"
        )
    }
}

/// Install a process-wide panic hook that persists redacted panic diagnostics + backtrace
/// to `desktop-YYYY-MM-DD.log` before delegating to the default panic hook.
pub fn install_panic_hook() {
    PANIC_HOOK_INSTALLED.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let thread = std::thread::current();
            let thread_name = thread.name().unwrap_or("unnamed");
            let location = info
                .location()
                .map(|loc| (loc.file(), loc.line(), loc.column()));
            let payload = panic_payload_message(info);
            let backtrace = Backtrace::force_capture().to_string();
            let report = format_panic_report(
                thread_name,
                std::process::id(),
                location,
                payload,
                &backtrace,
            );
            eprintln!("{}", redact(&report));
            write_redacted_to_dir(&logs_dir(), &report, true);
            previous(info);
        }));
    });
}

/// Tauri command used by the React ErrorBoundary and global `onerror`/`unhandledrejection`
/// handlers so renderer crashes leave a trail on disk even if the WebView reloads right after.
#[tauri::command]
pub(crate) fn log_frontend_error(
    level: Option<String>,
    source: String,
    message: String,
    stack: Option<String>,
) {
    let normalized_level = match level.as_deref().map(str::trim) {
        Some("warn" | "WARN") => "warn",
        _ => "error",
    };
    let clean_source = truncate_chars(source.trim(), MAX_FRONTEND_SOURCE_CHARS);
    let clean_message = truncate_chars(message.trim(), MAX_FRONTEND_MESSAGE_CHARS);
    let source_label = if clean_source.is_empty() {
        "renderer"
    } else {
        clean_source.as_str()
    };
    match stack.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw_stack) => {
            let clean_stack = truncate_chars(raw_stack, MAX_FRONTEND_STACK_CHARS);
            log(&format!(
                "[renderer:{normalized_level}] ({source_label}) {clean_message}\n{clean_stack}"
            ));
        }
        None => {
            log(&format!(
                "[renderer:{normalized_level}] ({source_label}) {clean_message}"
            ));
        }
    }
}

fn open(dir: &Path, date: NaiveDate) -> Option<Today> {
    fs::create_dir_all(dir).ok()?;
    prune(dir, date);
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(file_name(date)))
        .ok()?;
    Some(Today { date, file })
}

fn file_name(date: NaiveDate) -> String {
    format!("{PREFIX}-{}.log", date.format("%Y-%m-%d"))
}

fn log_date(name: &str) -> Option<NaiveDate> {
    let date = name.strip_prefix(PREFIX)?.strip_prefix('-')?;
    NaiveDate::parse_from_str(date.strip_suffix(".log")?, "%Y-%m-%d").ok()
}

/// Remove this log's files from before the last `KEEP_DAYS` days.
fn prune(dir: &Path, today: NaiveDate) -> Vec<String> {
    let mut removed = Vec::new();
    let Some(oldest) = today.checked_sub_days(Days::new(KEEP_DAYS - 1)) else {
        return removed;
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return removed;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let old = log_date(&name).is_some_and(|date| date < oldest);
        if old && fs::remove_file(entry.path()).is_ok() {
            removed.push(name);
        }
    }
    removed
}

struct Patterns {
    known: Regex,
    bearer: Regex,
    quoted: Regex,
    assigned: Regex,
}

/// The rules of `redactSensitiveText` (packages/protocol/src/redact.ts).
fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        known: Regex::new(concat!(
            r"(?i)(?:sk-(?:proj-|svcacct-|ant-|or-v1-)?[a-z0-9_-]{16,}|gsk_[a-z0-9]{16,}",
            r"|github_pat_[a-z0-9_]{30,}|gh[pousr]_[a-z0-9]{20,}|aiza[0-9a-z_-]{30,}",
            r"|(?:akia|asia)[a-z0-9]{16}|xox[baprs]-[a-z0-9-]{10,}|hf_[a-z0-9]{20,}",
            r"|npm_[a-z0-9]{20,}|pypi-[a-z0-9_-]{20,}|sg\.[a-z0-9_-]{10,}\.[a-z0-9_-]{20,})",
        ))
        .expect("credential pattern"),
        bearer: Regex::new(r"(?i)\b(bearer\s+)[a-z0-9._~+/=-]{8,}").expect("bearer pattern"),
        quoted: Regex::new(concat!(
            r#"(?i)(["'](?:api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret"#,
            r#"|credential|cookie|password|private[-_]?key|secret|token)["']\s*:\s*["'])"#,
            r#"[^"']*(["'])"#,
        ))
        .expect("quoted secret pattern"),
        assigned: Regex::new(concat!(
            r"(?i)\b(api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret",
            r"|credential|cookie|password|private[-_]?key|secret|token)\b(\s*[:=]\s*)([^\s,;]+)",
        ))
        .expect("assigned secret pattern"),
    })
}

/// Replace credentials and secrets in `text`.
pub(crate) fn redact(text: &str) -> String {
    let patterns = patterns();
    let text = patterns.known.replace_all(text, "[REDACTED]");
    let text = patterns.bearer.replace_all(&text, "${1}[REDACTED]");
    let text = patterns.quoted.replace_all(&text, "${1}[REDACTED]${2}");
    let text = patterns.assigned.replace_all(&text, "${1}${2}[REDACTED]");
    text.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_like_the_frontend() {
        // Built here, so the repository's secret scan does not take it for a key.
        let key = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz"].join("-");
        let line = format!("key {key}, Bearer abcdefghijk token=hunter2");
        let redacted = redact(&line);
        assert_eq!(
            redacted,
            "key [REDACTED], Bearer [REDACTED] token=[REDACTED]"
        );
        assert_eq!(
            redact(r#"{"password": "pa55"}"#),
            r#"{"password": "[REDACTED]"}"#
        );
    }

    #[test]
    fn keeps_a_week_of_files() {
        let name = format!("pid-desktop-log-{}", std::process::id());
        let dir = std::env::temp_dir().join(name);
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "desktop-2026-10-23.log",
            "desktop-2026-10-24.log",
            "host-2026-10-01.log",
            "notes.txt",
        ] {
            fs::write(dir.join(name), "").unwrap();
        }
        let today = NaiveDate::from_ymd_opt(2026, 10, 30).unwrap();
        assert_eq!(prune(&dir, today), vec!["desktop-2026-10-23.log"]);
        assert!(dir.join("desktop-2026-10-24.log").is_file());
        assert!(dir.join("host-2026-10-01.log").is_file());
        assert_eq!(file_name(today), "desktop-2026-10-30.log");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn formats_and_persists_redacted_panic_and_frontend_logs() {
        let dir = std::env::temp_dir().join(format!(
            "pid-desktop-panic-log-{}-{}",
            std::process::id(),
            Local::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let secret = ["sk", "proj", "0123456789abcdefghij"].join("-");
        let report = format_panic_report(
            "worker-1",
            4242,
            Some(("src/lib.rs", 99, 5)),
            &format!("unexpected state with token={secret}"),
            "0: qianji_lib::run\n1: main",
        );
        write_redacted_to_dir(&dir, &report, true);

        let today = Local::now().date_naive();
        let content = fs::read_to_string(dir.join(file_name(today))).unwrap();
        assert!(content.contains("[panic] pid=4242 thread=worker-1 at src/lib.rs:99:5"));
        assert!(content.contains("token=[REDACTED]"));
        assert!(!content.contains(&secret));
        assert!(content.contains("Backtrace:\n0: qianji_lib::run"));

        assert_eq!(
            truncate_chars("千机桌面崩溃日志", 4),
            "千机桌面…[truncated]"
        );
        assert_eq!(truncate_chars("千机", 4), "千机");

        fs::remove_dir_all(&dir).unwrap();
    }
}
