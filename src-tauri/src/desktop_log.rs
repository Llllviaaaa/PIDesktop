//! The desktop's log on disk (docs/REFACTOR_V2_P7.md, 3.3): its own messages
//! and the Harness Host's stderr, one file a day beside the Host's in
//! `~/.pid/logs`, kept for a week and redacted line by line. Every line also
//! still goes to stderr.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

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

struct Today {
    date: NaiveDate,
    file: File,
}

static LOG: Mutex<Option<Today>> = Mutex::new(None);

/// Where the desktop and the Host keep their logs.
pub(crate) fn logs_dir() -> PathBuf {
    harness_data_dir().join("logs")
}

/// Write `line` to stderr and, redacted, to today's file.
pub(crate) fn log(line: &str) {
    eprintln!("{line}");
    let now = Local::now();
    let Ok(mut state) = LOG.lock() else {
        return;
    };
    let date = now.date_naive();
    if state.as_ref().map(|today| today.date) != Some(date) {
        *state = open(&logs_dir(), date);
    }
    if let Some(today) = state.as_mut() {
        let _ = writeln!(today.file, "{} {}", now.to_rfc3339(), redact(line));
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
}
