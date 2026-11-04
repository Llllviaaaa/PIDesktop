import { useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openPath } from "@tauri-apps/plugin-opener";
import type { SkillInfo } from "@pid/protocol";
import {
  CheckCircle2,
  CircleAlert,
  FilePenLine,
  FolderOpen,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { agent } from "../lib/agent";
import { describeError } from "../lib/errors";
import { queryKeys } from "../lib/queries";

type SkillScopeFilter = "all" | "user" | "project";
type Notice = { kind: "success" | "error"; text: string } | null;

const NO_SKILLS: SkillInfo[] = [];

export function SkillsSettingsPanel({ cwd }: { cwd: string }) {
  const isTauri = "__TAURI_INTERNALS__" in window;
  const queryClient = useQueryClient();
  const hasWorkspace = cwd.trim() !== "";

  const [filter, setFilter] = useState<SkillScopeFilter>("all");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createScope, setCreateScope] = useState<"user" | "project">(hasWorkspace ? "project" : "user");
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createBody, setCreateBody] = useState("");
  const [creating, setCreating] = useState(false);

  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [loadingEditor, setLoadingEditor] = useState(false);
  const [savingEditor, setSavingEditor] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);

  const skillsQuery = useQuery({
    queryKey: queryKeys.skills(cwd),
    queryFn: () => agent.listSkills(cwd),
    enabled: isTauri,
  });

  const skills = skillsQuery.data ?? NO_SKILLS;

  const filteredSkills = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return skills.filter((skill) => {
      if (filter !== "all" && skill.scope !== filter) return false;
      if (needle === "") return true;
      return `${skill.name} ${skill.description} ${skill.path}`.toLowerCase().includes(needle);
    });
  }, [filter, search, skills]);

  const counts = useMemo(() => ({
    all: skills.length,
    user: skills.filter((item) => item.scope === "user").length,
    project: skills.filter((item) => item.scope === "project").length,
  }), [skills]);

  const openEditor = async (skill: SkillInfo) => {
    if (editingPath === skill.path) {
      setEditingPath(null);
      setConfirmDeletePath(null);
      return;
    }
    setNotice(null);
    setConfirmDeletePath(null);
    setEditingPath(skill.path);
    setLoadingEditor(true);
    try {
      const detail = await agent.readSkill(skill.path, cwd);
      setEditorContent(detail.content);
    } catch (error) {
      setEditingPath(null);
      setNotice({ kind: "error", text: `读取技能失败：${describeError(error)}` });
    } finally {
      setLoadingEditor(false);
    }
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = createName.trim();
    const trimmedDesc = createDescription.trim();
    if (!trimmedName || !trimmedDesc) return;
    const effectiveScope = createScope === "project" && hasWorkspace ? "project" : "user";
    setCreating(true);
    setNotice(null);
    try {
      const created = await agent.createSkill({
        scope: effectiveScope,
        ...(hasWorkspace ? { cwd } : {}),
        name: trimmedName,
        description: trimmedDesc,
        ...(createBody.trim() ? { body: createBody } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.skills(cwd) });
      setCreateOpen(false);
      setCreateName("");
      setCreateDescription("");
      setCreateBody("");
      setEditingPath(created.skill.path);
      setEditorContent(created.content);
      setNotice({ kind: "success", text: `已创建技能 /skill:${created.skill.name}` });
    } catch (error) {
      setNotice({ kind: "error", text: `创建技能失败：${describeError(error)}` });
    } finally {
      setCreating(false);
    }
  };

  const handleSaveEditor = async (path: string) => {
    setSavingEditor(true);
    setNotice(null);
    try {
      const next = await agent.saveSkill(path, editorContent, cwd);
      queryClient.setQueryData(queryKeys.skills(cwd), next);
      setNotice({ kind: "success", text: "技能 SKILL.md 已保存并即时同步到斜杠命令。" });
    } catch (error) {
      setNotice({ kind: "error", text: `保存技能失败：${describeError(error)}` });
    } finally {
      setSavingEditor(false);
    }
  };

  const handleToggle = async (skill: SkillInfo) => {
    setBusyPath(skill.path);
    setNotice(null);
    try {
      const next = await agent.toggleSkill(skill.path, !skill.enabled, cwd);
      queryClient.setQueryData(queryKeys.skills(cwd), next);
      setNotice({
        kind: "success",
        text: !skill.enabled ? `已启用技能 ${skill.name}` : `已停用技能 ${skill.name}`,
      });
    } catch (error) {
      setNotice({ kind: "error", text: `切换技能状态失败：${describeError(error)}` });
    } finally {
      setBusyPath(null);
    }
  };

  const handleDelete = async (skill: SkillInfo) => {
    setBusyPath(skill.path);
    setNotice(null);
    try {
      const next = await agent.deleteSkill(skill.path, cwd);
      queryClient.setQueryData(queryKeys.skills(cwd), next);
      if (editingPath === skill.path) {
        setEditingPath(null);
        setEditorContent("");
      }
      setConfirmDeletePath(null);
      setNotice({ kind: "success", text: `已删除技能 ${skill.name}` });
    } catch (error) {
      setNotice({ kind: "error", text: `删除技能失败：${describeError(error)}` });
    } finally {
      setBusyPath(null);
    }
  };

  return (
    <div className="skills-panel">
      <p className="settings-panel-description">
        管理全局（<code>~/.pid/skills</code>）与当前项目（<code>.pid/skills</code>、<code>.agents/skills</code>）中的技能模板；已启用技能会自动注入系统上下文并注册为 <code>/skill:名称</code> 斜杠命令。
      </p>

      <div className="skills-toolbar">
        <div className="skills-filter-pills" role="tablist" aria-label="技能作用域筛选">
          <button
            type="button"
            role="tab"
            aria-selected={filter === "all"}
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            全部 <span>{counts.all}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "user"}
            className={filter === "user" ? "active" : ""}
            onClick={() => setFilter("user")}
          >
            全局 <span>{counts.user}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "project"}
            className={filter === "project" ? "active" : ""}
            onClick={() => setFilter("project")}
          >
            当前项目 <span>{counts.project}</span>
          </button>
        </div>

        <div className="skills-toolbar-actions">
          <label className="skills-search">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索技能…"
              aria-label="搜索技能"
            />
            {search && (
              <button type="button" onClick={() => setSearch("")} aria-label="清空搜索">
                <X size={12} />
              </button>
            )}
          </label>
          <button
            type="button"
            className="secondary-button compact"
            disabled={skillsQuery.isFetching}
            onClick={() => void skillsQuery.refetch()}
            title="刷新技能列表"
          >
            <RefreshCw className={skillsQuery.isFetching ? "spinner-icon" : ""} size={13} />
            <span>刷新</span>
          </button>
          <button
            type="button"
            className="primary-button compact"
            onClick={() => {
              setCreateOpen((open) => !open);
              setNotice(null);
            }}
          >
            <Plus size={14} />
            <span>新建技能</span>
          </button>
        </div>
      </div>

      {notice && (
        <div className={`skills-notice ${notice.kind === "error" ? "is-error" : "is-success"}`} role="status">
          {notice.kind === "error" ? <CircleAlert size={15} /> : <CheckCircle2 size={15} />}
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">
            <X size={13} />
          </button>
        </div>
      )}

      {createOpen && (
        <form className="skills-create-card" onSubmit={(event) => void handleCreate(event)}>
          <header>
            <strong>从模板新建技能</strong>
            <button type="button" className="icon-button" onClick={() => setCreateOpen(false)} aria-label="关闭新建面板">
              <X size={15} />
            </button>
          </header>

          <div className="skills-create-grid">
            <div className="stacked-setting">
              <span>存放位置</span>
              <div className="skills-scope-Segment" role="radiogroup" aria-label="技能存放位置">
                <button
                  type="button"
                  role="radio"
                  aria-checked={createScope === "user" || !hasWorkspace}
                  className={createScope === "user" || !hasWorkspace ? "active" : ""}
                  onClick={() => setCreateScope("user")}
                >
                  全局 (~/.pid/skills)
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={createScope === "project" && hasWorkspace}
                  className={createScope === "project" && hasWorkspace ? "active" : ""}
                  disabled={!hasWorkspace}
                  onClick={() => setCreateScope("project")}
                >
                  当前项目 (.pid/skills)
                </button>
              </div>
            </div>

            <label className="stacked-setting">
              <span>技能标识</span>
              <input
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="例如：fix-ci"
                required
              />
              <small className="field-hint">
                调用命令预览：<code>/skill:{createName.trim() || "fix-ci"}</code>
              </small>
            </label>
          </div>

          <label className="stacked-setting">
            <span>触发描述</span>
            <input
              value={createDescription}
              onChange={(event) => setCreateDescription(event.target.value)}
              placeholder="简述何时使用此技能，例如：排查并修复 GitHub Actions 与本地单测失败"
              required
            />
          </label>

          <label className="stacked-setting">
            <span>技能步骤正文（Markdown，可选）</span>
            <textarea
              rows={5}
              value={createBody}
              onChange={(event) => setCreateBody(event.target.value)}
              placeholder={"# fix-ci\n\n1. 先复现失败测试并定位根因\n2. 最小化修改代码后重跑验证"}
            />
          </label>

          <footer>
            <button type="button" className="secondary-button" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={creating || !createName.trim() || !createDescription.trim()}
            >
              <Plus size={14} />
              <span>{creating ? "正在创建…" : "创建并打开编辑"}</span>
            </button>
          </footer>
        </form>
      )}

      {skillsQuery.isPending ? (
        <div className="settings-empty">
          <RefreshCw className="spinner-icon" size={18} />
          <span>正在发现技能…</span>
        </div>
      ) : filteredSkills.length === 0 ? (
        <div className="settings-empty">
          <Sparkles size={22} />
          <span>{skills.length === 0 ? "尚未发现任何技能，点击右上角“新建技能”即可从模板创建。" : "没有匹配当前筛选条件的技能。"}</span>
        </div>
      ) : (
        <div className="skills-list">
          {filteredSkills.map((skill) => {
            const isEditing = editingPath === skill.path;
            const isBusy = busyPath === skill.path;
            const confirmingDelete = confirmDeletePath === skill.path;
            return (
              <section key={skill.path} className={`skill-item-card ${skill.enabled ? "" : "is-disabled"}`}>
                <div className="skill-item-main">
                  <div className="skill-item-info">
                    <div className="skill-item-title-row">
                      <span className={`skill-scope-badge ${skill.scope}`}>
                        {skill.scope === "project" ? "项目" : "全局"}
                      </span>
                      <strong>{skill.name}</strong>
                      <code className="skill-slash-tag">/skill:{skill.name}</code>
                      {!skill.enabled && <span className="skill-disabled-badge">已停用</span>}
                    </div>
                    <p className="skill-item-desc">{skill.description || "暂无描述"}</p>
                    <small className="skill-item-path">{skill.path}</small>
                  </div>

                  <div className="skill-item-actions">
                    <button
                      type="button"
                      className="secondary-button compact"
                      onClick={() => void openEditor(skill)}
                    >
                      <FilePenLine size={13} />
                      <span>{isEditing ? "收起编辑" : "编辑"}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      title="在系统中打开 SKILL.md"
                      onClick={() => void openPath(skill.path).catch(() => undefined)}
                    >
                      <FolderOpen size={14} />
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={skill.enabled}
                      aria-label={`启用技能 ${skill.name}`}
                      disabled={isBusy}
                      className={`settings-switch ${skill.enabled ? "on" : ""}`}
                      onClick={() => void handleToggle(skill)}
                    >
                      <span />
                    </button>
                  </div>
                </div>

                {isEditing && (
                  <div className="skill-inline-editor">
                    {loadingEditor ? (
                      <div className="settings-empty compact">
                        <RefreshCw className="spinner-icon" size={15} />
                        <span>正在读取 SKILL.md…</span>
                      </div>
                    ) : (
                      <>
                        <textarea
                          className="large-settings-textarea skill-editor-textarea"
                          aria-label={`编辑 ${skill.name} SKILL.md`}
                          rows={12}
                          value={editorContent}
                          onChange={(event) => setEditorContent(event.target.value)}
                        />
                        <div className="skill-editor-footer">
                          {confirmingDelete ? (
                            <div className="skill-delete-confirm">
                              <span>确认删除此技能目录吗？此操作无法撤销。</span>
                              <button
                                type="button"
                                className="secondary-button compact"
                                onClick={() => setConfirmDeletePath(null)}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className="danger-button compact"
                                disabled={isBusy}
                                onClick={() => void handleDelete(skill)}
                              >
                                <Trash2 size={13} />
                                <span>确认删除</span>
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="icon-button danger"
                              title="删除此技能"
                              disabled={isBusy || savingEditor}
                              onClick={() => setConfirmDeletePath(skill.path)}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}

                          <div className="skill-editor-save">
                            <button
                              type="button"
                              className="secondary-button compact"
                              onClick={() => {
                                setEditingPath(null);
                                setConfirmDeletePath(null);
                              }}
                            >
                              关闭
                            </button>
                            <button
                              type="button"
                              className="primary-button compact"
                              disabled={savingEditor}
                              onClick={() => void handleSaveEditor(skill.path)}
                            >
                              <Save size={13} />
                              <span>{savingEditor ? "正在保存…" : "保存技能"}</span>
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <div className="settings-info">
        <Sparkles size={17} />
        <span>
          技能遵循标准 <code>SKILL.md</code>（YAML Frontmatter <code>name</code> + <code>description</code>）。启用后可在聊天框输入 <code>/skill:名称 参数</code> 直接触发，也可由 Agent 按需读取。
        </span>
      </div>
    </div>
  );
}
