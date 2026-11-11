//! WebView2 child-process crash monitoring and self-healing.
//!
//! Attaches `ICoreWebView2::add_ProcessFailed` to Tauri webviews so GPU, renderer,
//! subframe, and browser-manager crashes are logged to `~/.qianji/logs/desktop-*.log`
//! and automatically recovered without leaving a blank/frozen window or silently exiting.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const STORM_WINDOW: Duration = Duration::from_secs(60);
const ESCALATION_WINDOW: Duration = Duration::from_secs(30);
const MAX_HEAVY_RECOVERIES_PER_WINDOW: usize = 4;

// WebView2 COREWEBVIEW2_PROCESS_FAILED_KIND integer values
pub(crate) const KIND_BROWSER_PROCESS_EXITED: i32 = 0;
pub(crate) const KIND_RENDER_PROCESS_EXITED: i32 = 1;
pub(crate) const KIND_RENDER_PROCESS_UNRESPONSIVE: i32 = 2;
pub(crate) const KIND_FRAME_RENDER_PROCESS_EXITED: i32 = 3;
pub(crate) const KIND_UTILITY_PROCESS_EXITED: i32 = 4;
pub(crate) const KIND_SANDBOX_HELPER_PROCESS_EXITED: i32 = 5;
pub(crate) const KIND_GPU_PROCESS_EXITED: i32 = 6;
pub(crate) const KIND_PPAPI_PLUGIN_PROCESS_EXITED: i32 = 7;
pub(crate) const KIND_PPAPI_BROKER_PROCESS_EXITED: i32 = 8;
pub(crate) const KIND_UNKNOWN_PROCESS_EXITED: i32 = 9;

// WebView2 COREWEBVIEW2_PROCESS_FAILED_REASON integer values
pub(crate) const REASON_UNEXPECTED: i32 = 0;
pub(crate) const REASON_UNRESPONSIVE: i32 = 1;
pub(crate) const REASON_TERMINATED: i32 = 2;
pub(crate) const REASON_CRASHED: i32 = 3;
pub(crate) const REASON_LAUNCH_FAILED: i32 = 4;
pub(crate) const REASON_OUT_OF_MEMORY: i32 = 5;
pub(crate) const REASON_PROFILE_DELETED: i32 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryAction {
    /// Emit diagnostic event and log only.
    NotifyOnly,
    /// Re-bind compositor bounds after a transient GPU process restart without losing DOM state.
    RefreshSurface,
    /// Reload the webview document.
    Reload,
    /// Destroy the closed `"main"` WebViewWindow and rebuild it from `tauri.conf.json`.
    RecreateMainWindow,
    /// Recovery suppressed because too many heavy recoveries occurred in `STORM_WINDOW`.
    CircuitBroken,
}

impl RecoveryAction {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::NotifyOnly => "notify_only",
            Self::RefreshSurface => "refresh_surface",
            Self::Reload => "reload",
            Self::RecreateMainWindow => "recreate_main_window",
            Self::CircuitBroken => "circuit_broken",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebviewProcessFailedPayload {
    pub label: String,
    pub kind: String,
    pub kind_code: i32,
    pub reason: String,
    pub reason_code: i32,
    pub exit_code: i32,
    pub process_description: String,
    pub recovery_action: String,
}

pub(crate) fn kind_name(code: i32) -> &'static str {
    match code {
        KIND_BROWSER_PROCESS_EXITED => "browser_process_exited",
        KIND_RENDER_PROCESS_EXITED => "render_process_exited",
        KIND_RENDER_PROCESS_UNRESPONSIVE => "render_process_unresponsive",
        KIND_FRAME_RENDER_PROCESS_EXITED => "frame_render_process_exited",
        KIND_UTILITY_PROCESS_EXITED => "utility_process_exited",
        KIND_SANDBOX_HELPER_PROCESS_EXITED => "sandbox_helper_process_exited",
        KIND_GPU_PROCESS_EXITED => "gpu_process_exited",
        KIND_PPAPI_PLUGIN_PROCESS_EXITED => "ppapi_plugin_process_exited",
        KIND_PPAPI_BROKER_PROCESS_EXITED => "ppapi_broker_process_exited",
        KIND_UNKNOWN_PROCESS_EXITED => "unknown_process_exited",
        _ => "unrecognized_process_failed_kind",
    }
}

pub(crate) fn reason_name(code: i32) -> &'static str {
    match code {
        REASON_UNEXPECTED => "unexpected",
        REASON_UNRESPONSIVE => "unresponsive",
        REASON_TERMINATED => "terminated",
        REASON_CRASHED => "crashed",
        REASON_LAUNCH_FAILED => "launch_failed",
        REASON_OUT_OF_MEMORY => "out_of_memory",
        REASON_PROFILE_DELETED => "profile_deleted",
        -1 => "unavailable",
        _ => "unrecognized_reason",
    }
}

#[derive(Default)]
struct LabelHistory {
    heavy_recoveries: VecDeque<Instant>,
    gpu_failures: VecDeque<Instant>,
    unresponsive_events: VecDeque<Instant>,
}

#[derive(Default)]
pub(crate) struct RecoveryTracker {
    by_label: HashMap<String, LabelHistory>,
}

impl RecoveryTracker {
    pub(crate) fn decide(
        &mut self,
        label: &str,
        kind_code: i32,
        reason_code: i32,
        now: Instant,
    ) -> RecoveryAction {
        let history = self.by_label.entry(label.to_string()).or_default();
        prune_older_than(&mut history.heavy_recoveries, now, STORM_WINDOW);
        prune_older_than(&mut history.gpu_failures, now, ESCALATION_WINDOW);
        prune_older_than(&mut history.unresponsive_events, now, ESCALATION_WINDOW);

        let desired = match kind_code {
            KIND_BROWSER_PROCESS_EXITED => {
                if label == "main" {
                    RecoveryAction::RecreateMainWindow
                } else {
                    RecoveryAction::NotifyOnly
                }
            }
            KIND_RENDER_PROCESS_EXITED => RecoveryAction::Reload,
            KIND_RENDER_PROCESS_UNRESPONSIVE => {
                history.unresponsive_events.push_back(now);
                if history.unresponsive_events.len() >= 2 {
                    history.unresponsive_events.clear();
                    RecoveryAction::Reload
                } else {
                    RecoveryAction::NotifyOnly
                }
            }
            KIND_FRAME_RENDER_PROCESS_EXITED => {
                if label.starts_with("workspace-browser-") {
                    RecoveryAction::Reload
                } else {
                    RecoveryAction::NotifyOnly
                }
            }
            KIND_GPU_PROCESS_EXITED => {
                history.gpu_failures.push_back(now);
                let severe_reason = matches!(
                    reason_code,
                    REASON_LAUNCH_FAILED | REASON_OUT_OF_MEMORY | REASON_PROFILE_DELETED
                );
                if severe_reason || history.gpu_failures.len() >= 2 {
                    history.gpu_failures.clear();
                    RecoveryAction::Reload
                } else {
                    RecoveryAction::RefreshSurface
                }
            }
            _ => RecoveryAction::NotifyOnly,
        };

        if matches!(
            desired,
            RecoveryAction::Reload | RecoveryAction::RecreateMainWindow
        ) {
            if history.heavy_recoveries.len() >= MAX_HEAVY_RECOVERIES_PER_WINDOW {
                return RecoveryAction::CircuitBroken;
            }
            history.heavy_recoveries.push_back(now);
        }

        desired
    }
}

fn prune_older_than(queue: &mut VecDeque<Instant>, now: Instant, window: Duration) {
    while let Some(&front) = queue.front() {
        if now.saturating_duration_since(front) > window {
            queue.pop_front();
        } else {
            break;
        }
    }
}

fn tracker() -> &'static Mutex<RecoveryTracker> {
    static TRACKER: OnceLock<Mutex<RecoveryTracker>> = OnceLock::new();
    TRACKER.get_or_init(|| Mutex::new(RecoveryTracker::default()))
}

type WebviewIdentity = (usize, usize);

static RECREATING_MAIN: AtomicBool = AtomicBool::new(false);

struct RecreateMainGuard;

impl Drop for RecreateMainGuard {
    fn drop(&mut self) {
        RECREATING_MAIN.store(false, Ordering::Release);
    }
}

fn attached_webviews() -> &'static Mutex<HashMap<String, WebviewIdentity>> {
    static ATTACHED: OnceLock<Mutex<HashMap<String, WebviewIdentity>>> = OnceLock::new();
    ATTACHED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn should_attach_webview(
    map: &mut HashMap<String, WebviewIdentity>,
    label: &str,
    identity: WebviewIdentity,
) -> bool {
    if map.get(label).copied() == Some(identity) {
        return false;
    }
    map.insert(label.to_string(), identity);
    true
}

pub(crate) fn mark_detached(label: &str) {
    let mut map = attached_webviews()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    map.remove(label);
}

/// Spawn `"main"` window recreation on a background thread.
///
/// Must NOT run synchronously on the Win32 main thread or inside `run_on_main_thread`:
/// `existing.destroy()` posts an async event-loop message that needs the main loop to pump
/// before `"main"` is unregistered, and `WebviewWindowBuilder::build()` dispatches back to
/// the event loop over a blocking channel.
pub(crate) fn spawn_recreate_main_window(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = recreate_main_window_blocking(&handle);
    });
}

fn recreate_main_window_blocking(app: &AppHandle) -> bool {
    if RECREATING_MAIN.swap(true, Ordering::AcqRel) {
        return false;
    }
    let _guard = RecreateMainGuard;

    mark_detached("main");
    if let Some(existing) = app.get_webview_window("main") {
        let _ = existing.destroy();
    }

    let teardown_deadline = Instant::now() + Duration::from_secs(3);
    while app.get_webview_window("main").is_some() || app.get_webview("main").is_some() {
        if Instant::now() >= teardown_deadline {
            log_line!(
                "[webview] timed out waiting for broken main window teardown before recreation"
            );
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    let Some(cfg) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .or_else(|| app.config().app.windows.first())
    else {
        log_line!("[webview] cannot recreate main window: no window config found");
        return false;
    };

    match tauri::WebviewWindowBuilder::from_config(app, cfg).and_then(|builder| builder.build()) {
        Ok(window) => {
            log_line!("[webview] recreated main window after WebView2 failure");
            #[cfg(all(windows, not(debug_assertions)))]
            crate::disable_window_devtools("main", &window);
            #[cfg(windows)]
            attach_webview_window(app, &window);
            let _ = window.show();
            let _ = window.set_focus();
            true
        }
        Err(err) => {
            log_line!("[webview] failed to recreate main window: {err}");
            false
        }
    }
}

#[cfg(windows)]
pub(crate) fn install_for_all_windows(app: &tauri::App) {
    let handle = app.handle().clone();
    for window in app.webview_windows().values() {
        attach_webview_window(&handle, window);
    }
}

#[cfg(windows)]
pub(crate) fn attach_webview_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    let label = window.label().to_string();
    let app_handle = app.clone();
    let label_for_closure = label.clone();
    let result = window.with_webview(move |platform_webview| {
        if let Err(err) = register_process_failed_handler(
            app_handle,
            label_for_closure.clone(),
            platform_webview.controller(),
        ) {
            mark_detached(&label_for_closure);
            log_line!(
                "[webview] failed to attach ProcessFailed listener on {label_for_closure}: {err}"
            );
        }
    });

    if let Err(err) = result {
        mark_detached(&label);
        log_line!("[webview] could not reach webview {label} to attach crash guard: {err}");
    }
}

#[cfg(windows)]
pub(crate) fn ensure_child_webview_attached(app: &AppHandle, webview: &tauri::Webview) {
    let label = webview.label().to_string();
    let app_handle = app.clone();
    let label_for_closure = label.clone();
    let result = webview.with_webview(move |platform_webview| {
        if let Err(err) = register_process_failed_handler(
            app_handle,
            label_for_closure.clone(),
            platform_webview.controller(),
        ) {
            mark_detached(&label_for_closure);
            log_line!(
                "[webview] failed to attach ProcessFailed listener on child {label_for_closure}: {err}"
            );
        }
    });

    if let Err(err) = result {
        mark_detached(&label);
        log_line!("[webview] could not reach child webview {label} for crash guard: {err}");
    }
}

#[cfg(windows)]
fn register_process_failed_handler(
    app: AppHandle,
    label: String,
    controller: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) -> windows_core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ProcessFailedEventArgs2, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_REASON,
    };
    use webview2_com::{take_pwstr, ProcessFailedEventHandler};
    use windows_core::{Interface, PWSTR};

    let core = unsafe { controller.CoreWebView2() }?;
    let identity = (controller.as_raw() as usize, core.as_raw() as usize);
    {
        let mut map = attached_webviews()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !should_attach_webview(&mut map, &label, identity) {
            return Ok(());
        }
    }

    let label_on_err = label.clone();
    let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
        let mut kind_raw = COREWEBVIEW2_PROCESS_FAILED_KIND(KIND_UNKNOWN_PROCESS_EXITED);
        let mut reason_code: i32 = -1;
        let mut exit_code: i32 = 0;
        let mut process_description = String::new();

        if let Some(args_ref) = args.as_ref() {
            let _ = unsafe { args_ref.ProcessFailedKind(&mut kind_raw) };
            if let Ok(args2) = args_ref.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                let mut reason_raw = COREWEBVIEW2_PROCESS_FAILED_REASON(REASON_UNEXPECTED);
                if unsafe { args2.Reason(&mut reason_raw) }.is_ok() {
                    reason_code = reason_raw.0;
                }
                let _ = unsafe { args2.ExitCode(&mut exit_code) };
                let mut desc_pwstr = PWSTR::null();
                if unsafe { args2.ProcessDescription(&mut desc_pwstr) }.is_ok()
                    && !desc_pwstr.is_null()
                {
                    process_description = take_pwstr(desc_pwstr);
                }
            }
        }

        let kind_code = kind_raw.0;
        let action = {
            let mut guard = tracker()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.decide(&label, kind_code, reason_code, Instant::now())
        };

        log_line!(
            "[webview] ProcessFailed label={label} kind={}({kind_code}) reason={}({reason_code}) exit_code={exit_code} desc={:?} action={}",
            kind_name(kind_code),
            reason_name(reason_code),
            process_description,
            action.as_str()
        );

        let payload = WebviewProcessFailedPayload {
            label: label.clone(),
            kind: kind_name(kind_code).to_string(),
            kind_code,
            reason: reason_name(reason_code).to_string(),
            reason_code,
            exit_code,
            process_description,
            recovery_action: action.as_str().to_string(),
        };
        let _ = app.emit("webview-process-failed", payload);

        if kind_code == KIND_BROWSER_PROCESS_EXITED {
            mark_detached(&label);
        }

        schedule_recovery(app.clone(), label.clone(), action);
        Ok(())
    }));

    let mut token: i64 = 0;
    let res = unsafe { core.add_ProcessFailed(&handler, &mut token) };
    if res.is_err() {
        mark_detached(&label_on_err);
    }
    res
}

#[cfg(windows)]
fn schedule_recovery(app: AppHandle, label: String, action: RecoveryAction) {
    if matches!(
        action,
        RecoveryAction::NotifyOnly | RecoveryAction::CircuitBroken
    ) {
        if action == RecoveryAction::CircuitBroken {
            log_line!(
                "[webview] recovery circuit breaker open for {label}; skipping automatic reload to avoid crash loop"
            );
        }
        return;
    }

    // Dispatch outside the COM callback after a brief settle delay so WebView2
    // finishes unwinding its ProcessFailed event before we reload or recreate.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        if action == RecoveryAction::RecreateMainWindow {
            let _ = recreate_main_window_blocking(&app);
            return;
        }

        let app_for_main = app.clone();
        let _ = app.run_on_main_thread(move || match action {
            RecoveryAction::RefreshSurface => {
                if let Some(window) = app_for_main.get_webview_window(&label) {
                    let _ = window.with_webview(|wv| unsafe {
                        let _ = wv.controller().NotifyParentWindowPositionChanged();
                    });
                } else if let Some(webview) = app_for_main.get_webview(&label) {
                    let _ = webview.with_webview(|wv| unsafe {
                        let _ = wv.controller().NotifyParentWindowPositionChanged();
                    });
                }
            }
            RecoveryAction::Reload => {
                if let Some(window) = app_for_main.get_webview_window(&label) {
                    if let Err(err) = window.reload() {
                        log_line!("[webview] reload failed for window {label}: {err}");
                    } else {
                        log_line!("[webview] reloaded window {label} after child-process failure");
                    }
                } else if let Some(webview) = app_for_main.get_webview(&label) {
                    if let Err(err) = webview.reload() {
                        log_line!("[webview] reload failed for webview {label}: {err}");
                    } else {
                        log_line!("[webview] reloaded webview {label} after child-process failure");
                    }
                }
            }
            RecoveryAction::RecreateMainWindow
            | RecoveryAction::NotifyOnly
            | RecoveryAction::CircuitBroken => {}
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reloads_on_renderer_exit_and_trips_storm_circuit_breaker() {
        let mut tracker = RecoveryTracker::default();
        let t0 = Instant::now();

        for i in 0..MAX_HEAVY_RECOVERIES_PER_WINDOW {
            assert_eq!(
                tracker.decide(
                    "main",
                    KIND_RENDER_PROCESS_EXITED,
                    REASON_CRASHED,
                    t0 + Duration::from_secs(i as u64 * 5)
                ),
                RecoveryAction::Reload
            );
        }

        // 5th crash within 60s trips the circuit breaker
        assert_eq!(
            tracker.decide(
                "main",
                KIND_RENDER_PROCESS_EXITED,
                REASON_CRASHED,
                t0 + Duration::from_secs(25)
            ),
            RecoveryAction::CircuitBroken
        );

        // After the 60s storm window elapses, self-healing resumes
        assert_eq!(
            tracker.decide(
                "main",
                KIND_RENDER_PROCESS_EXITED,
                REASON_CRASHED,
                t0 + Duration::from_secs(90)
            ),
            RecoveryAction::Reload
        );
    }

    #[test]
    fn refreshes_surface_on_transient_gpu_exit_and_reloads_on_repeated_or_fatal_gpu_failure() {
        let mut tracker = RecoveryTracker::default();
        let t0 = Instant::now();

        assert_eq!(
            tracker.decide("main", KIND_GPU_PROCESS_EXITED, REASON_CRASHED, t0),
            RecoveryAction::RefreshSurface
        );
        // Second GPU crash within 30s escalates to full reload
        assert_eq!(
            tracker.decide(
                "main",
                KIND_GPU_PROCESS_EXITED,
                REASON_CRASHED,
                t0 + Duration::from_secs(10)
            ),
            RecoveryAction::Reload
        );

        // Fatal GPU OOM / LaunchFailed reloads immediately on first event
        assert_eq!(
            tracker.decide(
                "main",
                KIND_GPU_PROCESS_EXITED,
                REASON_OUT_OF_MEMORY,
                t0 + Duration::from_secs(120)
            ),
            RecoveryAction::Reload
        );
    }

    #[test]
    fn recreates_main_window_on_browser_process_exit_and_isolates_subframes() {
        let mut tracker = RecoveryTracker::default();
        let t0 = Instant::now();

        assert_eq!(
            tracker.decide("main", KIND_BROWSER_PROCESS_EXITED, REASON_UNEXPECTED, t0),
            RecoveryAction::RecreateMainWindow
        );
        assert_eq!(
            tracker.decide(
                "workspace-browser-1",
                KIND_BROWSER_PROCESS_EXITED,
                REASON_UNEXPECTED,
                t0
            ),
            RecoveryAction::NotifyOnly
        );

        // Subframe crash inside main does not wipe out the main shell, whereas embedded browser reloads
        assert_eq!(
            tracker.decide("main", KIND_FRAME_RENDER_PROCESS_EXITED, REASON_CRASHED, t0),
            RecoveryAction::NotifyOnly
        );
        assert_eq!(
            tracker.decide(
                "workspace-browser-1",
                KIND_FRAME_RENDER_PROCESS_EXITED,
                REASON_CRASHED,
                t0
            ),
            RecoveryAction::Reload
        );

        // Unresponsive renderer only reloads if repeated consecutively within 30s
        assert_eq!(
            tracker.decide(
                "main",
                KIND_RENDER_PROCESS_UNRESPONSIVE,
                REASON_UNRESPONSIVE,
                t0
            ),
            RecoveryAction::NotifyOnly
        );
        assert_eq!(
            tracker.decide(
                "main",
                KIND_RENDER_PROCESS_UNRESPONSIVE,
                REASON_UNRESPONSIVE,
                t0 + Duration::from_secs(12)
            ),
            RecoveryAction::Reload
        );
    }

    #[test]
    fn reattaches_when_same_label_recreated_with_new_com_identity() {
        let mut map = HashMap::new();
        assert!(should_attach_webview(
            &mut map,
            "workspace-browser-1",
            (0x1000, 0x2000)
        ));
        // Duplicate attach on identical COM pointers is skipped
        assert!(!should_attach_webview(
            &mut map,
            "workspace-browser-1",
            (0x1000, 0x2000)
        ));
        // Recreated webview with same label and new COM pointers re-attaches
        assert!(should_attach_webview(
            &mut map,
            "workspace-browser-1",
            (0x3000, 0x4000)
        ));
    }
}
