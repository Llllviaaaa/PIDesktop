import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  Check,
  Clock3,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { pi } from "../lib/pi";
import { formatScheduleTime, nextScheduledRun, scheduleSummary } from "../lib/schedule";
import type { ScheduledFrequency, ScheduledTask } from "../types";

interface ScheduledTasksPageProps {
  workspaces: string[];
  onTasksChanged: () => void;
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

export function ScheduledTasksPage({ workspaces, onTasksChanged, onError }: ScheduledTasksPageProps) {
  const workspaceOptions = useMemo(() => uniqueWorkspaces(workspaces), [workspaces]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<ScheduledTask>(EMPTY_TASK);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTasks(await pi.listScheduledTasks());
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
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
      const candidate = { ...draft };
      candidate.nextRunAt = candidate.enabled ? nextScheduledRun(candidate) : null;
      await pi.saveScheduledTask(candidate);
      setEditorOpen(false);
      await load();
      onTasksChanged();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (task: ScheduledTask) => {
    const next = { ...task, enabled: !task.enabled };
    next.nextRunAt = next.enabled ? nextScheduledRun(next) : null;
    try {
      await pi.saveScheduledTask(next);
      await load();
      onTasksChanged();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const runNow = async (task: ScheduledTask) => {
    setRunningId(task.id);
    try {
      const result = await pi.runScheduledTask(task.id, task.nextRunAt);
      if (!result.success) onError(result.output || "计划任务执行失败");
      await load();
      onTasksChanged();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunningId(null);
    }
  };

  const remove = async (id: string) => {
    try {
      await pi.deleteScheduledTask(id);
      setDeleteConfirmId(null);
      await load();
      onTasksChanged();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="scheduled-tasks-page">
      <header className="work-center-header">
        <div>
          <span className="work-center-icon"><Clock3 size={20} /></span>
          <span><h1>已安排</h1><p>按计划在指定工作目录运行 Pi，并把运行结果保存到会话历史。</p></span>
        </div>
        <div className="work-center-header-actions">
          <button type="button" className="icon-button" title="刷新" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? "spinner-icon" : ""} /></button>
          <button type="button" className="primary-button" onClick={openCreate}><Plus size={15} />新建任务</button>
        </div>
      </header>

      {loading && tasks.length === 0 ? (
        <div className="work-center-empty"><LoaderCircle className="spinner-icon" size={21} /><strong>正在加载计划任务</strong></div>
      ) : tasks.length === 0 ? (
        <div className="work-center-empty"><CalendarClock size={23} /><strong>还没有计划任务</strong><span>新建任务后，PIDesktop 会在运行期间按计划调用 Pi。</span><button type="button" className="primary-button" onClick={openCreate}><Plus size={15} />新建任务</button></div>
      ) : (
        <div className="scheduled-task-list">
          {tasks.map((task) => (
            <article className={`scheduled-task-row ${task.enabled ? "" : "disabled"}`} key={task.id}>
              <button type="button" className={`schedule-toggle ${task.enabled ? "enabled" : ""}`} role="switch" aria-checked={task.enabled} onClick={() => void toggle(task)}><span /></button>
              <div className="scheduled-task-copy">
                <div><strong>{task.name}</strong><span className={`run-status ${task.lastStatus || "idle"}`}>{task.lastStatus === "running" ? "运行中" : task.lastStatus === "success" ? "上次成功" : task.lastStatus === "error" ? "上次失败" : "未运行"}</span></div>
                <p>{task.prompt}</p>
                <small>{workspaceName(task.cwd)} · {scheduleSummary(task)} · 下次 {formatScheduleTime(task.nextRunAt)}</small>
              </div>
              <div className="scheduled-task-actions">
                {deleteConfirmId === task.id ? (
                  <>
                    <button type="button" className="danger-text-button" onClick={() => void remove(task.id)}><Check size={14} />确认删除</button>
                    <button type="button" className="icon-button" title="取消" onClick={() => setDeleteConfirmId(null)}><X size={15} /></button>
                  </>
                ) : (
                  <>
                    <button type="button" className="secondary-button" disabled={runningId !== null} onClick={() => void runNow(task)}>{runningId === task.id ? <LoaderCircle size={14} className="spinner-icon" /> : <Play size={14} />}立即运行</button>
                    <button type="button" className="icon-button" title="编辑" onClick={() => openEdit(task)}><Pencil size={15} /></button>
                    <button type="button" className="icon-button danger" title="删除" onClick={() => setDeleteConfirmId(task.id)}><Trash2 size={15} /></button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {editorOpen && (
        <div className="schedule-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditorOpen(false); }}>
          <form className="schedule-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <header><div><strong>{draft.id ? "编辑计划任务" : "新建计划任务"}</strong><small>任务会使用当前 Pi 配置在所选目录执行。</small></div><button type="button" className="icon-button" title="关闭" onClick={() => setEditorOpen(false)}><X size={17} /></button></header>
            <label><span>名称</span><input autoFocus value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：每日检查未提交更改" required /></label>
            <label><span>工作目录</span><select value={draft.cwd} onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))} required><option value="" disabled>选择项目</option>{workspaceOptions.map((workspace) => <option key={workspace} value={workspace}>{workspaceName(workspace)} — {workspace}</option>)}</select></label>
            <label><span>交给 Pi 的任务</span><textarea value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} placeholder="描述每次运行时要完成的工作" required rows={5} /></label>
            <div className="schedule-editor-grid">
              <label><span>频率</span><select value={draft.frequency} onChange={(event) => setDraft((current) => ({ ...current, frequency: event.target.value as ScheduledFrequency }))}><option value="hourly">每小时</option><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option></select></label>
              {draft.frequency === "weekly" && <label><span>星期</span><select value={draft.weekday} onChange={(event) => setDraft((current) => ({ ...current, weekday: Number(event.target.value) }))}>{["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"].map((label, index) => <option key={label} value={index}>{label}</option>)}</select></label>}
              {draft.frequency !== "hourly" && <label><span>小时</span><input type="number" min={0} max={23} value={draft.hour} onChange={(event) => setDraft((current) => ({ ...current, hour: Number(event.target.value) }))} /></label>}
              <label><span>分钟</span><input type="number" min={0} max={59} value={draft.minute} onChange={(event) => setDraft((current) => ({ ...current, minute: Number(event.target.value) }))} /></label>
            </div>
            <footer><button type="button" className="secondary-button" onClick={() => setEditorOpen(false)}>取消</button><button type="submit" className="primary-button" disabled={saving || !draft.name.trim() || !draft.prompt.trim() || !draft.cwd}>{saving && <LoaderCircle size={14} className="spinner-icon" />}保存任务</button></footer>
          </form>
        </div>
      )}
    </section>
  );
}
