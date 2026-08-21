use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{
    DateTime, Datelike, Duration, Local, LocalResult, NaiveDate, TimeZone, Timelike, Utc,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::ScheduledTask;

static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduledRunRecord {
    pub id: String,
    pub task_id: String,
    pub task_name: String,
    pub cwd: String,
    pub prompt: String,
    pub permission_mode: String,
    pub trigger: String,
    pub status: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub duration_ms: Option<u64>,
    pub exit_code: Option<i32>,
    pub output: String,
    pub session_file: Option<String>,
}

fn open_store(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create scheduler data directory: {err}"))?;
    }
    let connection = Connection::open(path)
        .map_err(|err| format!("failed to open scheduled run history: {err}"))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|err| format!("failed to configure scheduled run history: {err}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS scheduled_runs (
               id TEXT PRIMARY KEY,
               task_id TEXT NOT NULL,
               task_name TEXT NOT NULL,
               cwd TEXT NOT NULL,
               prompt TEXT NOT NULL,
               permission_mode TEXT NOT NULL DEFAULT 'ask',
               trigger TEXT NOT NULL,
               status TEXT NOT NULL,
               started_at INTEGER NOT NULL,
               finished_at INTEGER,
               duration_ms INTEGER,
               exit_code INTEGER,
               output TEXT NOT NULL DEFAULT '',
               session_file TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_scheduled_runs_task_started
               ON scheduled_runs(task_id, started_at DESC);
             CREATE INDEX IF NOT EXISTS idx_scheduled_runs_started
               ON scheduled_runs(started_at DESC);",
        )
        .map_err(|err| format!("failed to initialize scheduled run history: {err}"))?;
    let has_permission_mode = connection
        .prepare("PRAGMA table_info(scheduled_runs)")
        .and_then(|mut statement| {
            let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
            columns.collect::<Result<Vec<_>, _>>()
        })
        .map_err(|err| format!("failed to inspect scheduled run history: {err}"))?
        .iter()
        .any(|column| column == "permission_mode");
    if !has_permission_mode {
        connection
            .execute(
                "ALTER TABLE scheduled_runs ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask'",
                [],
            )
            .map_err(|err| format!("failed to migrate scheduled run history: {err}"))?;
    }
    Ok(connection)
}

pub(crate) fn begin_run(
    path: &Path,
    task: &ScheduledTask,
    trigger: &str,
    started_at: u64,
) -> Result<ScheduledRunRecord, String> {
    let record = ScheduledRunRecord {
        id: format!(
            "run-{started_at}-{}-{}",
            std::process::id(),
            NEXT_RUN_ID.fetch_add(1, Ordering::Relaxed)
        ),
        task_id: task.id.clone(),
        task_name: task.name.clone(),
        cwd: task.cwd.clone(),
        prompt: task.prompt.clone(),
        permission_mode: task.permission_mode.clone(),
        trigger: trigger.to_string(),
        status: "running".to_string(),
        started_at,
        finished_at: None,
        duration_ms: None,
        exit_code: None,
        output: String::new(),
        session_file: None,
    };
    open_store(path)?
        .execute(
            "INSERT INTO scheduled_runs (
               id, task_id, task_name, cwd, prompt, permission_mode, trigger, status, started_at,
               finished_at, duration_ms, exit_code, output, session_file
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, '', NULL)",
            params![
                record.id,
                record.task_id,
                record.task_name,
                record.cwd,
                record.prompt,
                record.permission_mode,
                record.trigger,
                record.status,
                record.started_at,
            ],
        )
        .map_err(|err| format!("failed to start scheduled run record: {err}"))?;
    Ok(record)
}

pub(crate) fn finish_run(path: &Path, record: &ScheduledRunRecord) -> Result<(), String> {
    open_store(path)?
        .execute(
            "UPDATE scheduled_runs SET
               status = ?2,
               finished_at = ?3,
               duration_ms = ?4,
               exit_code = ?5,
               output = ?6,
               session_file = ?7
             WHERE id = ?1",
            params![
                record.id,
                record.status,
                record.finished_at,
                record.duration_ms,
                record.exit_code,
                record.output,
                record.session_file,
            ],
        )
        .map_err(|err| format!("failed to finish scheduled run record: {err}"))?;
    Ok(())
}

pub(crate) fn list_runs(
    path: &Path,
    task_id: Option<&str>,
    limit: u32,
) -> Result<Vec<ScheduledRunRecord>, String> {
    let connection = open_store(path)?;
    let limit = limit.clamp(1, 250) as i64;
    let columns =
        "id, task_id, task_name, cwd, prompt, permission_mode, trigger, status, started_at,
                   finished_at, duration_ms, exit_code, output, session_file";
    let sql = if task_id.is_some() {
        format!("SELECT {columns} FROM scheduled_runs WHERE task_id = ?1 ORDER BY started_at DESC LIMIT ?2")
    } else {
        format!("SELECT {columns} FROM scheduled_runs ORDER BY started_at DESC LIMIT ?1")
    };
    let mut statement = connection
        .prepare(&sql)
        .map_err(|err| format!("failed to query scheduled run history: {err}"))?;
    let map_row = |row: &rusqlite::Row<'_>| {
        Ok(ScheduledRunRecord {
            id: row.get(0)?,
            task_id: row.get(1)?,
            task_name: row.get(2)?,
            cwd: row.get(3)?,
            prompt: row.get(4)?,
            permission_mode: row.get(5)?,
            trigger: row.get(6)?,
            status: row.get(7)?,
            started_at: row.get(8)?,
            finished_at: row.get(9)?,
            duration_ms: row.get(10)?,
            exit_code: row.get(11)?,
            output: row.get(12)?,
            session_file: row.get(13)?,
        })
    };
    let rows = if let Some(task_id) = task_id {
        statement.query_map(params![task_id, limit], map_row)
    } else {
        statement.query_map(params![limit], map_row)
    }
    .map_err(|err| format!("failed to read scheduled run history: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to decode scheduled run history: {err}"))
}

pub(crate) fn recover_interrupted_runs(path: &Path, now: u64) -> Result<usize, String> {
    let changed = open_store(path)?
        .execute(
            "UPDATE scheduled_runs SET
               status = 'interrupted',
               finished_at = ?1,
               duration_ms = CASE WHEN ?1 >= started_at THEN ?1 - started_at ELSE 0 END,
               output = CASE
                 WHEN output = '' THEN 'PIDesktop exited before this run completed.'
                 ELSE output
               END
             WHERE status = 'running'",
            params![now],
        )
        .map_err(|err| format!("failed to recover scheduled run history: {err}"))?;
    Ok(changed)
}

fn local_datetime(date: NaiveDate, hour: u8, minute: u8) -> DateTime<Local> {
    let mut naive = date
        .and_hms_opt(hour as u32, minute as u32, 0)
        .expect("validated scheduler time");
    for _ in 0..180 {
        match Local.from_local_datetime(&naive) {
            LocalResult::Single(value) => return value,
            LocalResult::Ambiguous(first, _) => return first,
            LocalResult::None => naive += Duration::minutes(1),
        }
    }
    Local.from_utc_datetime(&naive)
}

fn from_timestamp(timestamp: u64) -> DateTime<Local> {
    DateTime::<Utc>::from_timestamp_millis(timestamp.min(i64::MAX as u64) as i64)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .with_timezone(&Local)
}

pub(crate) fn next_scheduled_run(task: &ScheduledTask, from: u64) -> u64 {
    let origin = from_timestamp(from);
    let mut candidate = if task.frequency == "hourly" {
        local_datetime(origin.date_naive(), origin.hour() as u8, task.minute)
    } else {
        local_datetime(origin.date_naive(), task.hour, task.minute)
    };

    match task.frequency.as_str() {
        "hourly" => {
            if candidate.timestamp_millis() <= from as i64 {
                candidate += Duration::hours(1);
            }
        }
        "daily" => {
            if candidate.timestamp_millis() <= from as i64 {
                candidate = local_datetime(
                    origin
                        .date_naive()
                        .succ_opt()
                        .unwrap_or(origin.date_naive()),
                    task.hour,
                    task.minute,
                );
            }
        }
        "weekdays" => {
            let mut date = origin.date_naive();
            if candidate.timestamp_millis() <= from as i64 {
                date = date.succ_opt().unwrap_or(date);
            }
            while date.weekday().number_from_monday() > 5 {
                date = date.succ_opt().unwrap_or(date);
            }
            candidate = local_datetime(date, task.hour, task.minute);
        }
        "weekly" => {
            let current = origin.weekday().num_days_from_sunday() as i64;
            let desired = task.weekday.min(6) as i64;
            let mut days_ahead = (desired - current + 7) % 7;
            if days_ahead == 0 && candidate.timestamp_millis() <= from as i64 {
                days_ahead = 7;
            }
            let date = origin.date_naive() + Duration::days(days_ahead);
            candidate = local_datetime(date, task.hour, task.minute);
        }
        _ => {
            candidate = origin + Duration::days(1);
        }
    }
    candidate.timestamp_millis().max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(frequency: &str) -> ScheduledTask {
        ScheduledTask {
            frequency: frequency.to_string(),
            hour: 9,
            minute: 15,
            weekday: 1,
            permission_mode: "ask".to_string(),
            ..ScheduledTask::default()
        }
    }

    #[test]
    fn computes_all_supported_schedule_frequencies_in_the_future() {
        let now = 1_700_000_000_000;
        for frequency in ["hourly", "daily", "weekdays", "weekly"] {
            assert!(next_scheduled_run(&task(frequency), now) > now);
        }
    }

    #[test]
    fn persists_finishes_filters_and_recovers_run_history() {
        let path = std::env::temp_dir().join(format!(
            "pid-desktop-scheduled-runs-{}-{}.sqlite3",
            std::process::id(),
            NEXT_RUN_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let mut scheduled = task("daily");
        scheduled.id = "task-one".to_string();
        scheduled.name = "Daily check".to_string();
        scheduled.cwd = "D:/workspace".to_string();
        scheduled.prompt = "Check the repository".to_string();

        let mut first = begin_run(&path, &scheduled, "manual", 1_000).unwrap();
        first.status = "success".to_string();
        first.finished_at = Some(1_750);
        first.duration_ms = Some(750);
        first.exit_code = Some(0);
        first.output = "done".to_string();
        first.session_file = Some("session.jsonl".to_string());
        finish_run(&path, &first).unwrap();

        scheduled.id = "task-two".to_string();
        begin_run(&path, &scheduled, "scheduled", 2_000).unwrap();
        assert_eq!(recover_interrupted_runs(&path, 2_500).unwrap(), 1);

        let all = list_runs(&path, None, 10).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].status, "interrupted");
        assert_eq!(all[0].duration_ms, Some(500));
        let filtered = list_runs(&path, Some("task-one"), 10).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].permission_mode, "ask");
        assert_eq!(filtered[0].output, "done");
        assert_eq!(filtered[0].session_file.as_deref(), Some("session.jsonl"));

        drop(all);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = std::fs::remove_file(path);
    }
}
