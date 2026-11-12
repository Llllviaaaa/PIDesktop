//! The desktop's log on disk (docs/archive/REFACTOR_V2_P7.md, 3.3): its own messages
//! and the Harness Host's stderr, one file a day beside the Host's in
//! `~/.qianji/logs`, kept for a week and redacted line by line. Every line also
//! still goes to stderr.

use std::backtrace::Backtrace;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, Once, OnceLock, TryLockError};

use chrono::{Days, Local, NaiveDate};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::harness_host::harness_data_dir;

/// `eprintln!` that also writes the line to the desktop's log file.
macro_rules! log_line {
    ($($arg:tt)*) => {
        $crate::desktop_log::log(&format!($($arg)*))
    };
}

const PREFIX: &str = "desktop";
const KEEP_DAYS: u64 = 7;
const CRASHES_FILE: &str = "desktop-crashes.jsonl";
const LIFECYCLE_FILE: &str = "desktop-lifecycle.json";
const MAX_CRASH_FILE_BYTES: u64 = 1_048_576;
const KEEP_CRASH_LINES: usize = 200;
const MAX_CRASH_SUMMARY_CHARS: usize = 500;
const UNCLEAN_EXIT_TAIL_LINES: usize = 25;
const MAX_TAIL_READ_BYTES: u64 = 65_536;
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
static CRASH_SEQ: AtomicU64 = AtomicU64::new(0);
static SESSION_CLEAN_EXITED: AtomicBool = AtomicBool::new(false);

/// Shared JSONL crash/incident record persisted to `desktop-crashes.jsonl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashRecord {
    pub v: u8,
    pub id: String,
    pub timestamp: String,
    pub plane: String,
    pub kind: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

pub(crate) struct CrashRecordParams<'a> {
    pub plane: &'a str,
    pub kind: &'a str,
    pub summary: &'a str,
    pub detail: Option<&'a str>,
    pub plugin_id: Option<&'a str>,
    pub exit_code: Option<i32>,
    pub pid: Option<u32>,
}

/// Session sentinel written to `desktop-lifecycle.json` so native SEH faults,
/// GPU driver crashes, OOM kills, or hard-terminations are detected on next boot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopLifecycle {
    pub session_id: String,
    pub pid: u32,
    pub version: String,
    pub started_at: String,
    pub clean_exit: bool,
    #[serde(default)]
    pub exit_reason: Option<String>,
}

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

/// Decode common Windows NTSTATUS / SEH / runtime crash exit codes into a human-readable label.
pub(crate) fn decode_exit_code(code: i32) -> Option<&'static str> {
    match code as u32 {
        0xC000_0005 => Some("Access Violation"),
        0xC000_00FD => Some("Stack Overflow"),
        0xC000_0409 => Some("Stack Buffer Overrun"),
        0xC000_013A => Some("Control-C Exit"),
        0xE06D_7363 => Some("C++ Exception"),
        0xC000_0017 | 0xE000_0008 => Some("Out of Memory"),
        0xC000_0142 => Some("DLL Initialization Failed"),
        0xC000_0135 => Some("DLL Not Found"),
        _ => None,
    }
}

/// Format an exit code with its 32-bit hex value and optional NTSTATUS decode.
pub(crate) fn format_exit_code(code: i32) -> String {
    match decode_exit_code(code) {
        Some(desc) => format!("{code} (0x{:08X} {desc})", code as u32),
        None => format!("{code} (0x{:08X})", code as u32),
    }
}

fn single_line_summary(input: &str) -> String {
    let collapsed = input
        .chars()
        .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
        .collect::<String>();
    truncate_chars(collapsed.trim(), MAX_CRASH_SUMMARY_CHARS)
}

/// Append a redacted JSONL crash record to `<logs_dir>/desktop-crashes.jsonl`.
pub(crate) fn append_crash_record(params: CrashRecordParams<'_>) {
    append_crash_record_to_dir(&logs_dir(), params, MAX_CRASH_FILE_BYTES);
}

pub(crate) fn append_crash_record_to_dir(
    dir: &Path,
    params: CrashRecordParams<'_>,
    max_file_bytes: u64,
) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let now = Local::now();
    let seq = CRASH_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let pid_for_id = params.pid.unwrap_or_else(std::process::id);
    let summary = redact(&single_line_summary(params.summary));
    let detail = params
        .detail
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| redact(&truncate_chars(s, MAX_BACKTRACE_CHARS)));
    let record = CrashRecord {
        v: 1,
        id: format!("{}-{}-{}", now.timestamp_millis(), pid_for_id, seq),
        timestamp: now.to_rfc3339(),
        plane: params.plane.to_string(),
        kind: params.kind.to_string(),
        summary,
        detail,
        plugin_id: params.plugin_id.map(str::to_string),
        exit_code: params.exit_code,
        pid: params.pid,
    };
    let Ok(json) = serde_json::to_string(&record) else {
        return;
    };
    let line = format!("{json}\n");
    let crashes_path = dir.join(CRASHES_FILE);

    let exceeds_limit = fs::metadata(&crashes_path)
        .map(|meta| meta.len() > max_file_bytes)
        .unwrap_or(false);
    if exceeds_limit {
        if let Ok(existing) = fs::read_to_string(&crashes_path) {
            let mut kept: Vec<&str> = existing
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .collect();
            let keep_prev = KEEP_CRASH_LINES.saturating_sub(1);
            if kept.len() > keep_prev {
                let drain_count = kept.len() - keep_prev;
                kept.drain(0..drain_count);
            }
            let mut rewritten = String::new();
            for item in kept {
                rewritten.push_str(item);
                rewritten.push('\n');
            }
            rewritten.push_str(&line);
            let tmp_path = dir.join("desktop-crashes.jsonl.tmp");
            if fs::write(&tmp_path, rewritten.as_bytes()).is_ok()
                && fs::rename(&tmp_path, &crashes_path).is_ok()
            {
                return;
            }
            let _ = fs::remove_file(&tmp_path);
            if fs::write(&crashes_path, rewritten.as_bytes()).is_ok() {
                return;
            }
        }
    }

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&crashes_path)
    {
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }
}

fn read_latest_desktop_log_tail(dir: &Path, max_lines: usize) -> Option<String> {
    let entries = fs::read_dir(dir).ok()?;
    let mut latest: Option<(NaiveDate, PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(date) = log_date(&name) {
            if latest
                .as_ref()
                .is_none_or(|(best_date, _)| date >= *best_date)
            {
                latest = Some((date, entry.path()));
            }
        }
    }
    let (_, path) = latest?;
    let mut file = File::open(path).ok()?;
    let total_len = file.metadata().ok()?.len();
    let seek_offset = total_len.saturating_sub(MAX_TAIL_READ_BYTES);
    if seek_offset > 0 {
        let _ = file.seek(SeekFrom::Start(seek_offset));
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    let raw = String::from_utf8_lossy(&buf);
    let text = if seek_offset > 0 {
        match raw.find('\n') {
            Some(idx) => &raw[idx + 1..],
            None => raw.as_ref(),
        }
    } else {
        raw.as_ref()
    };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return None;
    }
    let start = lines.len().saturating_sub(max_lines);
    Some(lines[start..].join("\n"))
}

fn write_lifecycle_atomic(dir: &Path, lifecycle: &DesktopLifecycle) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(mut payload) = serde_json::to_string_pretty(lifecycle) else {
        return;
    };
    payload.push('\n');
    let target = dir.join(LIFECYCLE_FILE);
    let tmp = dir.join("desktop-lifecycle.json.tmp");
    if fs::write(&tmp, payload.as_bytes()).is_ok() && fs::rename(&tmp, &target).is_ok() {
        return;
    }
    let _ = fs::remove_file(&tmp);
    let _ = fs::write(&target, payload.as_bytes());
}

/// Inspect any previous session's `desktop-lifecycle.json` for an unclean exit,
/// persist an `"unclean_desktop_exit"` crash record if found, and arm the new session sentinel.
pub(crate) fn mark_session_start(version: &str) {
    SESSION_CLEAN_EXITED.store(false, Ordering::SeqCst);
    mark_session_start_in_dir(&logs_dir(), version, std::process::id(), true);
}

fn mark_session_start_in_dir(dir: &Path, version: &str, pid: u32, emit_stderr: bool) {
    let lifecycle_path = dir.join(LIFECYCLE_FILE);
    if let Ok(raw) = fs::read_to_string(&lifecycle_path) {
        if let Ok(prev) = serde_json::from_str::<DesktopLifecycle>(&raw) {
            if !prev.clean_exit && prev.pid != pid {
                let tail = read_latest_desktop_log_tail(dir, UNCLEAN_EXIT_TAIL_LINES);
                let detail = match tail {
                    Some(lines) => format!(
                        "previous_session_id={} pid={} version={} started_at={}\n--- Last desktop log lines ---\n{lines}",
                        prev.session_id, prev.pid, prev.version, prev.started_at
                    ),
                    None => format!(
                        "previous_session_id={} pid={} version={} started_at={}",
                        prev.session_id, prev.pid, prev.version, prev.started_at
                    ),
                };
                append_crash_record_to_dir(
                    dir,
                    CrashRecordParams {
                        plane: "desktop",
                        kind: "unclean_desktop_exit",
                        summary: "上次桌面进程异常终止（原生闪退、驱动崩溃或被系统强制结束）",
                        detail: Some(&detail),
                        plugin_id: None,
                        exit_code: None,
                        pid: Some(prev.pid),
                    },
                    MAX_CRASH_FILE_BYTES,
                );
                let msg = format!(
                    "[desktop] previous session (pid={}) exited uncleanly",
                    prev.pid
                );
                if emit_stderr {
                    eprintln!("{msg}");
                }
                write_redacted_to_dir(dir, &msg, !emit_stderr);
            }
        }
    }

    let now = Local::now();
    let lifecycle = DesktopLifecycle {
        session_id: format!("{}-{}", now.timestamp_millis(), pid),
        pid,
        version: version.to_string(),
        started_at: now.to_rfc3339(),
        clean_exit: false,
        exit_reason: None,
    };
    write_lifecycle_atomic(dir, &lifecycle);

    let start_msg = format!("[desktop] session_start version={version} pid={pid}");
    if emit_stderr {
        eprintln!("{start_msg}");
    }
    write_redacted_to_dir(dir, &start_msg, !emit_stderr);
}

/// Mark the current desktop session as cleanly exited so the next boot knows no crash occurred.
pub(crate) fn mark_session_clean_exit(reason: &str) {
    if SESSION_CLEAN_EXITED.swap(true, Ordering::SeqCst) {
        return;
    }
    mark_session_clean_exit_in_dir(&logs_dir(), reason, std::process::id(), true);
}

fn mark_session_clean_exit_in_dir(dir: &Path, reason: &str, pid: u32, emit_stderr: bool) {
    let lifecycle_path = dir.join(LIFECYCLE_FILE);
    let updated = fs::read_to_string(&lifecycle_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<DesktopLifecycle>(&raw).ok())
        .map(|mut prev| {
            prev.clean_exit = true;
            prev.exit_reason = Some(reason.to_string());
            prev
        })
        .unwrap_or_else(|| {
            let now = Local::now();
            DesktopLifecycle {
                session_id: format!("{}-{}", now.timestamp_millis(), pid),
                pid,
                version: env!("CARGO_PKG_VERSION").to_string(),
                started_at: now.to_rfc3339(),
                clean_exit: true,
                exit_reason: Some(reason.to_string()),
            }
        });
    write_lifecycle_atomic(dir, &updated);

    let exit_msg = format!("[desktop] session_exit reason={reason} pid={pid}");
    if emit_stderr {
        eprintln!("{exit_msg}");
    }
    write_redacted_to_dir(dir, &exit_msg, true);
}

/// Install a process-wide panic hook that persists redacted panic diagnostics + backtrace
/// to `desktop-YYYY-MM-DD.log` and `desktop-crashes.jsonl` before delegating to the default panic hook.
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
            let pid = std::process::id();
            let where_at = match location {
                Some((file, line, col)) => format!("{file}:{line}:{col}"),
                None => "<unknown>".to_string(),
            };
            let report = format_panic_report(thread_name, pid, location, payload, &backtrace);
            let summary = format!(
                "Rust 主进程 panic ({thread_name} @ {where_at}): {}",
                truncate_chars(payload.trim(), 240)
            );
            let dir = logs_dir();
            eprintln!("{}", redact(&report));
            write_redacted_to_dir(&dir, &report, true);
            append_crash_record_to_dir(
                &dir,
                CrashRecordParams {
                    plane: "desktop",
                    kind: "rust_panic",
                    summary: &summary,
                    detail: Some(&report),
                    plugin_id: None,
                    exit_code: None,
                    pid: Some(pid),
                },
                MAX_CRASH_FILE_BYTES,
            );
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

    #[test]
    fn decodes_common_ntstatus_exit_codes() {
        assert_eq!(
            format_exit_code(0xC000_0005u32 as i32),
            "-1073741819 (0xC0000005 Access Violation)"
        );
        assert_eq!(
            format_exit_code(0xC000_00FDu32 as i32),
            "-1073741571 (0xC00000FD Stack Overflow)"
        );
        assert_eq!(
            format_exit_code(0xC000_0409u32 as i32),
            "-1073740791 (0xC0000409 Stack Buffer Overrun)"
        );
        assert_eq!(
            format_exit_code(0xC000_013Au32 as i32),
            "-1073741510 (0xC000013A Control-C Exit)"
        );
        assert_eq!(
            format_exit_code(0xE06D_7363u32 as i32),
            "-529697949 (0xE06D7363 C++ Exception)"
        );
        assert_eq!(format_exit_code(1), "1 (0x00000001)");
    }

    #[test]
    fn detects_unclean_desktop_exit_and_prunes_crash_jsonl() {
        let dir = std::env::temp_dir().join(format!(
            "pid-desktop-lifecycle-{}-{}",
            std::process::id(),
            Local::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();

        let secret = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz012345"].join("-");
        write_redacted_to_dir(
            &dir,
            &format!("[desktop] working with Bearer {secret}"),
            true,
        );

        // Session 1 starts (pid=1111) and dies abruptly without calling mark_session_clean_exit
        mark_session_start_in_dir(&dir, "0.3.0", 1111, false);
        let sentinel_1: DesktopLifecycle =
            serde_json::from_str(&fs::read_to_string(dir.join(LIFECYCLE_FILE)).unwrap()).unwrap();
        assert!(!sentinel_1.clean_exit);
        assert_eq!(sentinel_1.pid, 1111);

        // Session 2 starts (pid=2222) -> detects unclean exit of pid=1111 and records CrashRecord!
        mark_session_start_in_dir(&dir, "0.3.0", 2222, false);
        let crashes_raw = fs::read_to_string(dir.join(CRASHES_FILE)).unwrap();
        let crash_lines: Vec<&str> = crashes_raw.lines().collect();
        assert_eq!(crash_lines.len(), 1);
        let record: CrashRecord = serde_json::from_str(crash_lines[0]).unwrap();
        assert_eq!(record.v, 1);
        assert_eq!(record.plane, "desktop");
        assert_eq!(record.kind, "unclean_desktop_exit");
        assert_eq!(record.pid, Some(1111));
        assert!(record.summary.contains("上次桌面进程异常终止"));
        let detail = record.detail.expect("tail detail");
        assert!(detail.contains("[REDACTED]"));
        assert!(!detail.contains(&secret));

        // Session 2 exits cleanly -> Session 3 (pid=3333) does NOT record another crash
        mark_session_clean_exit_in_dir(&dir, "explicit_request", 2222, false);
        let sentinel_2: DesktopLifecycle =
            serde_json::from_str(&fs::read_to_string(dir.join(LIFECYCLE_FILE)).unwrap()).unwrap();
        assert!(sentinel_2.clean_exit);
        assert_eq!(sentinel_2.exit_reason.as_deref(), Some("explicit_request"));

        mark_session_start_in_dir(&dir, "0.3.0", 3333, false);
        let crashes_after_clean = fs::read_to_string(dir.join(CRASHES_FILE)).unwrap();
        assert_eq!(crashes_after_clean.lines().count(), 1);

        // Verify JSONL pruning when file exceeds byte threshold
        for idx in 0..215 {
            append_crash_record_to_dir(
                &dir,
                CrashRecordParams {
                    plane: "desktop",
                    kind: "harness_unexpected_exit",
                    summary: &format!("crash #{idx} token={secret}"),
                    detail: Some("stack"),
                    plugin_id: None,
                    exit_code: Some(1),
                    pid: Some(5000 + idx),
                },
                512,
            );
        }
        let pruned_raw = fs::read_to_string(dir.join(CRASHES_FILE)).unwrap();
        let pruned_lines: Vec<&str> = pruned_raw.lines().collect();
        assert_eq!(pruned_lines.len(), KEEP_CRASH_LINES);
        assert!(!pruned_raw.contains(&secret));
        let last: CrashRecord = serde_json::from_str(pruned_lines.last().unwrap()).unwrap();
        assert_eq!(last.pid, Some(5214));

        fs::remove_dir_all(&dir).unwrap();
    }
}
