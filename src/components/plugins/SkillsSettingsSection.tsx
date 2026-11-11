import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SkillInfo, SkillScope } from "@qianji/protocol";
import { Check, Eye, FileText, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { describeError } from "../../lib/errors";
import { queryKeys } from "../../lib/queries";
import { skillClient } from "../../lib/skillClient";

type ScopeFilter = "all" | SkillScope;

export interface SkillsSettingsSectionProps {
  cwd: string;
  search: string;
  onNotify: (notice: { kind: "success" | "error"; text: string } | null) => void;
}

const NO_SKILLS: SkillInfo[] = [];

function scopeBadgeLabel(scope: SkillScope, readOnly?: boolean): string {
  if (scope === "builtin") return "内置只读";
  if (scope === "project") return "项目级";
  return readOnly ? "全局只读" : "全局用户";
}

export function SkillsSettingsSection({ cwd, search, onNotify }: SkillsSettingsSectionProps) {
  const queryClient = useQueryClient();
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [creating, setCreating] = useState(false);
  const [createScope, setCreateScope] = useState<"user" | "project">("user");
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [editorDraft, setEditorDraft] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);

  const skillsQuery = useQuery({
    queryKey: queryKeys.skills(cwd),
    queryFn: () => skillClient.list(cwd),
  });

  const skills = skillsQuery.data ?? NO_SKILLS;
  const needle = search.trim().toLowerCase();

  const counts = useMemo(() => {
    const base = { all: skills.length, builtin: 0, user: 0, project: 0 };
    for (const s of skills) {
      base[s.scope] += 1;
    }
    return base;
  }, [skills]);

  const filtered = useMemo(() => {
    return skills.filter((item) => {
      if (scopeFilter !== "all" && item.scope !== scopeFilter) return false;
      if (needle === "") return true;
      return `${item.name} ${item.description} ${item.path}`.toLowerCase().includes(needle);
    });
  }, [skills, scopeFilter, needle]);

  const refreshSkills = (next?: SkillInfo[]) => {
    if (next !== undefined) {
      queryClient.setQueryData(queryKeys.skills(cwd), next);
    } else {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills(cwd) });
    }
  };

  const toggleMutation = useMutation({
    mutationFn: (params: { skill: SkillInfo; enabled: boolean }) =>
      skillClient.toggle({ path: params.skill.path, cwd, enabled: params.enabled }),
    onSuccess: (res, vars) => {
      refreshSkills(res.skills);
      onNotify({
        kind: "success",
        text: `${vars.enabled ? "已启用" : "已停用"}技能 "${vars.skill.name}"。`,
      });
    },
    onError: (err) => onNotify({ kind: "error", text: describeError(err) }),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      skillClient.create({
        scope: createScope,
        cwd,
        name: createName.trim(),
        description: createDesc.trim(),
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills(cwd) });
      setCreating(false);
      setCreateName("");
      setCreateDesc("");
      onNotify({ kind: "success", text: `已创建技能 "${res.skill.name}"。` });
    },
    onError: (err) => onNotify({ kind: "error", text: describeError(err) }),
  });

  const saveMutation = useMutation({
    mutationFn: (path: string) => skillClient.save({ path, cwd, content: editorDraft }),
    onSuccess: (res) => {
      refreshSkills(res.skills);
      setExpandedPath(null);
      onNotify({ kind: "success", text: "已保存技能文档（SKILL.md）。" });
    },
    onError: (err) => onNotify({ kind: "error", text: describeError(err) }),
  });

  const deleteMutation = useMutation({
    mutationFn: (path: string) => skillClient.delete({ path, cwd }),
    onSuccess: (res) => {
      refreshSkills(res.skills);
      setConfirmDeletePath(null);
      setExpandedPath(null);
      onNotify({ kind: "success", text: "已删除自定义技能。" });
    },
    onError: (err) => onNotify({ kind: "error", text: describeError(err) }),
  });

  const busy =
    toggleMutation.isPending
    || createMutation.isPending
    || saveMutation.isPending
    || deleteMutation.isPending;

  const openSkillPreview = async (skill: SkillInfo) => {
    if (expandedPath === skill.path) {
      setExpandedPath(null);
      setConfirmDeletePath(null);
      return;
    }
    setExpandedPath(skill.path);
    setConfirmDeletePath(null);
    setEditorLoading(true);
    try {
      const read = await skillClient.read({ path: skill.path, cwd });
      setEditorDraft(read.content);
    } catch (err) {
      onNotify({ kind: "error", text: describeError(err) });
      setExpandedPath(null);
    } finally {
      setEditorLoading(false);
    }
  };

  if (skillsQuery.isPending) {
    return <div className="plugins-empty">正在读取技能目录…</div>;
  }

  if (skillsQuery.isError) {
    return (
      <div className="plugin-inline-alert error">
        <span>读取技能列表失败：{describeError(skillsQuery.error)}</span>
        <button type="button" className="plugin-ghost-btn" onClick={() => void skillsQuery.refetch()}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="skills-panel">
      <div className="skills-toolbar">
        <div className="skills-filter-pills" role="tablist" aria-label="技能来源筛选">
          {([
            { id: "all", label: "全部", count: counts.all },
            { id: "builtin", label: "内置规范", count: counts.builtin },
            { id: "user", label: "全局用户", count: counts.user },
            { id: "project", label: "当前项目", count: counts.project },
          ] as const).map((pill) => (
            <button
              key={pill.id}
              type="button"
              role="tab"
              aria-selected={scopeFilter === pill.id}
              className={scopeFilter === pill.id ? "active" : ""}
              onClick={() => setScopeFilter(pill.id)}
            >
              {pill.label}
              <span>{pill.count}</span>
            </button>
          ))}
        </div>

        <div className="skills-toolbar-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void skillsQuery.refetch()}
          >
            <RefreshCw size={13} />
            <span>刷新</span>
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => setCreating((v) => !v)}
          >
            <Plus size={13} />
            <span>新建技能</span>
          </button>
        </div>
      </div>

      {creating && (
        <div className="skills-create-card">
          <header>
            <strong>新建渐进式技能包（SKILL.md）</strong>
            <button type="button" className="icon-button" aria-label="关闭新建技能" onClick={() => setCreating(false)}>
              <X size={14} />
            </button>
          </header>
          <div className="skills-scope-Segment">
            <button
              type="button"
              className={createScope === "user" ? "active" : ""}
              onClick={() => setCreateScope("user")}
            >
              全局技能（~/.qianji/skills）
            </button>
            <button
              type="button"
              disabled={cwd.trim() === ""}
              className={createScope === "project" ? "active" : ""}
              onClick={() => setCreateScope("project")}
            >
              项目技能（.qianji/skills）
            </button>
          </div>
          <div className="skills-create-grid">
            <input
              placeholder="技能标识符，例如 repo-audit"
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
            />
            <input
              placeholder="一句话触发描述（注入系统提示词摘要）"
              value={createDesc}
              onChange={(event) => setCreateDesc(event.target.value)}
            />
          </div>
          <footer>
            <button type="button" className="secondary-button" onClick={() => setCreating(false)}>
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy || createName.trim() === "" || createDesc.trim() === ""}
              onClick={() => createMutation.mutate()}
            >
              <Check size={13} />
              <span>创建</span>
            </button>
          </footer>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="plugins-empty">当前筛选下暂无匹配的技能包。</div>
      ) : (
        <div className="skills-list">
          {filtered.map((skill) => {
            const isReadOnly = skill.readOnly === true || skill.scope === "builtin";
            const isOpen = expandedPath === skill.path;
            return (
              <article
                key={skill.path}
                className={`skill-item-card${skill.enabled ? "" : " is-disabled"}`}
                data-skill-name={skill.name}
                data-skill-scope={skill.scope}
              >
                <div className="skill-item-main">
                  <div className="skill-item-info">
                    <div className="skill-item-title-row">
                      <strong>{skill.name}</strong>
                      <span className={`skill-scope-badge${skill.scope === "project" ? " project" : ""}`}>
                        {scopeBadgeLabel(skill.scope, skill.readOnly)}
                      </span>
                      <span className="skill-slash-tag">/skill:{skill.name}</span>
                      {!skill.enabled && <span className="skill-disabled-badge">已停用</span>}
                    </div>
                    <p className="skill-item-desc">{skill.description}</p>
                    <span className="skill-item-path">{skill.path}</span>
                  </div>

                  <div className="skill-item-actions">
                    <button
                      type="button"
                      className="plugin-ghost-btn"
                      onClick={() => void openSkillPreview(skill)}
                    >
                      {isReadOnly ? <Eye size={12.5} /> : <FileText size={12.5} />}
                      <span>{isOpen ? "收起" : isReadOnly ? "查看" : "编辑"}</span>
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={skill.enabled}
                      aria-label={`${skill.enabled ? "停用" : "启用"}技能 ${skill.name}`}
                      disabled={busy}
                      className={`settings-switch ${skill.enabled ? "on" : ""}`}
                      onClick={() => toggleMutation.mutate({ skill, enabled: !skill.enabled })}
                    >
                      <span />
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div className="skill-inline-editor">
                    <textarea
                      className="skill-editor-textarea"
                      value={editorLoading ? "正在读取 SKILL.md…" : editorDraft}
                      readOnly={isReadOnly || editorLoading}
                      onChange={(event) => setEditorDraft(event.target.value)}
                      spellCheck={false}
                    />
                    <div className="skill-editor-footer">
                      {isReadOnly ? (
                        <small className="skill-item-path">
                          内置技能随千机版本自动升级；如需定制，可在全局或项目目录创建同名技能覆盖。
                        </small>
                      ) : confirmDeletePath === skill.path ? (
                        <div className="skill-delete-confirm">
                          <span>确认永久删除该技能目录？</span>
                          <button
                            type="button"
                            className="plugin-ghost-btn danger"
                            disabled={busy}
                            onClick={() => deleteMutation.mutate(skill.path)}
                          >
                            确认删除
                          </button>
                          <button
                            type="button"
                            className="plugin-ghost-btn"
                            onClick={() => setConfirmDeletePath(null)}
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="plugin-ghost-btn danger"
                          disabled={busy}
                          onClick={() => setConfirmDeletePath(skill.path)}
                        >
                          <Trash2 size={12.5} />
                          <span>删除</span>
                        </button>
                      )}

                      {!isReadOnly && (
                        <div className="skill-editor-save">
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => setExpandedPath(null)}
                          >
                            关闭
                          </button>
                          <button
                            type="button"
                            className="primary-button"
                            disabled={busy || editorLoading}
                            onClick={() => saveMutation.mutate(skill.path)}
                          >
                            <Check size={13} />
                            <span>保存 SKILL.md</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
