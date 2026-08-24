import { useCallback, useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertCircle,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { pi } from "../lib/pi";
import { formatScheduleTime, scheduleSummary } from "../lib/schedule";
import type { ScheduledFrequency, ScheduledPermissionMode, ScheduledRunRecord, ScheduledTask } from "../types";

interface ScheduledTasksPageProps {
  workspaces: string[];
  onTasksChanged: () => void;
  onOpenSession: (workspace: string, file: string) => void;
  onError: (message: string) => void;
}

const EMPTY_TASK: ScheduledTask = {
  id: "",
  name: "",
  prompt: "",
  cwd: "",
  frequency: "daily",
  hour: 9,
  minute: 0,
  weekday: 1,
  permissionMode: "ask",
  timeoutMinutes: 30,
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  lastStatus: "",
  lastMessage: "",
};

function uniqueWorkspaces(workspaces: string[]): string[] {
  const seen = new Set<string>();
  return workspaces.filter((workspace) => {
    const key = workspace.replace(/[\\/]+$/, "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function runStatusLabel(status: ScheduledRunRecord["status"] | ScheduledTask["lastStatus"]): string {
  if (status === "running") return "运行中";
  if (status === "success") return "成功";
  if (status === "error") return "失败";
  if (status === "interrupted") return "已中断";
  if (status === "cancelled") return "已取消";
  if (status === "timed-out") return "已超时";
  return "未运行";
}

function permissionLabel(mode: ScheduledPermissionMode): string {
  if (mode === "read-only") return "只读";
  if (mode === "workspace-write") return "工作区写入";
  return "先询问";
}

function formatRunTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(duration?: number | null): string {
  if (duration == null) return "进行中";
  if (duration < 1_000) return "不到 1 秒";
  const seconds = Math.round(duration / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function RunStatusIcon({ status }: { status: ScheduledRunRecord["status"] }) {
  if (status === "running") return <LoaderCircle size={15} className="spinner-icon" />;
  if (status === "success") return <CheckCircle2 size={15} />;
  if (status === "error" || status === "timed-out") return <AlertCircle size={15} />;
  return <CircleDashed size={15} />;
}

export function ScheduledTasksPage({
  workspaces,
  onTasksChanged,
  onOpenSession,
  onError,
}: ScheduledTasksPageProps) {
  const workspaceOptions = useMemo(() => uniqueWorkspaces(workspaces), [workspaces]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<ScheduledRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<ScheduledTask>(EMPTY_TASK);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const [nextTasks, nextRuns] = await Promise.all([
        pi.listScheduledTasks(),
        pi.listScheduledRuns(undefined, 80),
      ]);
      setTasks(nextTasks);
      setRuns(nextRuns);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let refreshTimer: number | undefined;
    let unlisten: UnlistenFn[] = [];
    const queueRefresh = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void load(false), 100);
    };
    void Promise.all([
      listen("scheduled-task-updated", queueRefresh),
      listen<ScheduledRunRecord>("scheduled-run-updated", queueRefresh),
    ]).then((listeners) => {
      if (disposed) listeners.forEach((stop) => stop());
      else unlisten = listeners;
    });
    return () => {
      disposed = true;
      window.clearTimeout(refreshTimer);
      unlisten.forEach((stop) => stop());
    };
  }, [load]);

  const openCreate = () => {
    setDraft({ ...EMPTY_TASK, cwd: workspaceOptions[0] || "" });
    setEditorOpen(true);
  };

  const openEdit = (task: ScheduledTask) => {
    setDraft({ ...task });
    setEditorOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await pi.saveScheduledTask({ ...draft });
      setEditorOpen(false);
      await load(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (task: ScheduledTask) => {
    try {
      await pi.saveScheduledTask({ ...task, enabled: !task.enabled });
      await load(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const runNow = async (task: ScheduledTask) => {
    setRunningId(task.id);
    try {
      const result = await pi.runScheduledTask(task.id);
      if (!result.success && result.run.status !== "cancelled") onError(result.output || "计划任务执行失败");
      await load(false);
      onTasksChanged();
      setExpandedRunId(result.run.id);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunningId(null);
    }
  };

  const cancel = async (task: ScheduledTask) => {
    setCancellingId(task.id);
    try {
      await pi.cancelScheduledTask(task.id);
      await load(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setCancellingId(null);
    }
  };

  const remove = async (id: string) => {
    try {
      await pi.deleteScheduledTask(id);
      setDeleteConfirmId(null);
      await load(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="scheduled-tasks-page">
      <header className="work-center-header">
        <div>
          <span className="work-center-icon"><Clock3 size={20} /></span>
          <span><h1>已安排</h1><p>在本机按计划运行 Pi，并保留每一次执行记录。</p></span>
        </div>
        <div className="work-center-header-actions">
          <button type="button" className="icon-button" title="刷新" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? "spinner-icon" : ""} /></button>
          <button type="button" className="primary-button" onClick={openCreate}><Plus size={15} />新建任务</button>
        </div>
      </header>

      {loading && tasks.length === 0 ? (
        <div className="work-center-empty"><LoaderCircle className="spinner-icon" size={21} /><strong>正在加载计划任务</strong></div>
      ) : tasks.length === 0 ? (
        <div className="work-center-empty"><CalendarClock size={23} /><strong>还没有计划任务</strong><span>新建后，PIDesktop 会在应用运行期间由本地后台 Runner 执行。</span><button type="button" className="primary-button" onClick={openCreate}><Plus size={15} />新建任务</button></div>
      ) : (
        <div className="scheduled-task-list">
          {tasks.map((task) => (
            <article className={`scheduled-task-row ${task.enabled ? "" : "disabled"}`} key={task.id}>
              <button type="button" className={`schedule-toggle ${task.enabled ? "enabled" : ""}`} role="switch" aria-label={`${task.enabled ? "停用" : "启用"}${task.name}`} aria-checked={task.enabled} onClick={() => void toggle(task)}><span /></button>
              <div className="scheduled-task-copy">
                <div><strong>{task.name}</strong><span className={`run-status ${task.lastStatus || "idle"}`}>{task.lastStatus === "running" ? "运行中" : task.lastStatus ? `上次${runStatusLabel(task.lastStatus)}` : "未运行"}</span></div>
                <p>{task.prompt}</p>
                <small>{workspaceName(task.cwd)} · {permissionLabel(task.permissionMode)} · 超时 {task.timeoutMinutes ?? 30} 分钟 · {scheduleSummary(task)} · 下次 {formatScheduleTime(task.nextRunAt)}</small>
              </div>
              <div className="scheduled-task-actions">
                {deleteConfirmId === task.id ? (
                  <>
                    <button type="button" className="danger-text-button" onClick={() => void remove(task.id)}><Check size={14} />确认删除</button>
                    <button type="button" className="icon-button" title="取消" onClick={() => setDeleteConfirmId(null)}><X size={15} /></button>
                  </>
                ) : (
                  <>
                    {task.lastStatus === "running" || runningId === task.id
                      ? <button type="button" className="secondary-button danger-text-button" disabled={cancellingId === task.id} onClick={() => void cancel(task)}>{cancellingId === task.id ? <LoaderCircle size={14} className="spinner-icon" /> : <Square size={13} />}停止</button>
                      : <button type="button" className="secondary-button" onClick={() => void runNow(task)}><Play size={14} />立即运行</button>}
                    <button type="button" className="icon-button" title="编辑" disabled={task.lastStatus === "running"} onClick={() => openEdit(task)}><Pencil size={15} /></button>
                    <button type="button" className="icon-button danger" title="删除" disabled={task.lastStatus === "running"} onClick={() => setDeleteConfirmId(task.id)}><Trash2 size={15} /></button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      <section className="scheduled-run-history" aria-label="运行记录">
        <header><div><h2>运行记录</h2><span>{runs.length ? `最近 ${runs.length} 次` : "暂无记录"}</span></div></header>
        {runs.length === 0 ? (
          <div className="scheduled-run-empty"><Clock3 size={17} /><span>任务运行后会在这里显示结果</span></div>
        ) : (
          <div className="scheduled-run-list">
            {runs.map((run) => {
              const expanded = expandedRunId === run.id;
              return (
                <article className={`scheduled-run-row ${run.status}`} key={run.id}>
                  <button type="button" className="scheduled-run-summary" onClick={() => setExpandedRunId(expanded ? null : run.id)} aria-expanded={expanded}>
                    <span className="scheduled-run-status-icon"><RunStatusIcon status={run.status} /></span>
                    <span className="scheduled-run-copy"><strong>{run.taskName}</strong><small>{formatRunTime(run.startedAt)} · {formatDuration(run.durationMs)} · {permissionLabel(run.permissionMode)} · {run.trigger === "manual" ? "手动运行" : "计划运行"}</small></span>
                    <span className={`run-status ${run.status}`}>{runStatusLabel(run.status)}</span>
                    {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                  {expanded && (
                    <div className="scheduled-run-detail">
                      <div className="scheduled-run-path"><span>{workspaceName(run.cwd)}</span><code>{run.cwd}</code>{run.exitCode != null && <em>退出码 {run.exitCode}</em>}</div>
                      <pre>{run.output || (run.status === "running" ? "Pi 正在执行任务..." : "运行完成，没有文本输出。")}</pre>
                      {run.sessionFile && <button type="button" className="secondary-button" onClick={() => onOpenSession(run.cwd, run.sessionFile!)}><MessageSquare size={14} />打开会话</button>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {editorOpen && (
        <div className="schedule-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditorOpen(false); }}>
          <form className="schedule-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <header><div><strong>{draft.id ? "编辑计划任务" : "新建计划任务"}</strong><small>任务在本机执行，并固定使用下面选择的权限。</small></div><button type="button" className="icon-button" title="关闭" onClick={() => setEditorOpen(false)}><X size={17} /></button></header>
            <label><span>名称</span><input autoFocus value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：每日检查未提交更改" required /></label>
            <label><span>工作目录</span><select value={draft.cwd} onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))} required><option value="" disabled>选择项目</option>{workspaceOptions.map((workspace) => <option key={workspace} value={workspace}>{workspaceName(workspace)} — {workspace}</option>)}</select></label>
            <label><span>交给 Pi 的任务</span><textarea value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} placeholder="描述每次运行时要完成的工作" required rows={5} /></label>
            <label><span>运行权限</span><select value={draft.permissionMode} onChange={(event) => setDraft((current) => ({ ...current, permissionMode: event.target.value as ScheduledPermissionMode }))}><option value="read-only">只读</option><option value="ask">先询问（无界面确认时阻止操作）</option><option value="workspace-write">工作区写入</option></select><small className="schedule-field-help">计划任务不会使用完全访问；需要交互确认的工具会被权限守卫阻止并写入运行记录。</small></label>
            <div className="schedule-editor-grid">
              <label><span>频率</span><select value={draft.frequency} onChange={(event) => setDraft((current) => ({ ...current, frequency: event.target.value as ScheduledFrequency }))}><option value="hourly">每小时</option><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option></select></label>
              {draft.frequency === "weekly" && <label><span>星期</span><select value={draft.weekday} onChange={(event) => setDraft((current) => ({ ...current, weekday: Number(event.target.value) }))}>{["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"].map((label, index) => <option key={label} value={index}>{label}</option>)}</select></label>}
              {draft.frequency !== "hourly" && <label><span>小时</span><input type="number" min={0} max={23} value={draft.hour} onChange={(event) => setDraft((current) => ({ ...current, hour: Number(event.target.value) }))} /></label>}
              <label><span>分钟</span><input type="number" min={0} max={59} value={draft.minute} onChange={(event) => setDraft((current) => ({ ...current, minute: Number(event.target.value) }))} /></label>
              <label><span>超时（分钟）</span><input type="number" min={1} max={240} value={draft.timeoutMinutes ?? 30} onChange={(event) => setDraft((current) => ({ ...current, timeoutMinutes: Number(event.target.value) }))} /></label>
            </div>
            <footer><button type="button" className="secondary-button" onClick={() => setEditorOpen(false)}>取消</button><button type="submit" className="primary-button" disabled={saving || !draft.name.trim() || !draft.prompt.trim() || !draft.cwd}>{saving && <LoaderCircle size={14} className="spinner-icon" />}保存任务</button></footer>
          </form>
        </div>
      )}
    </section>
  );
}
