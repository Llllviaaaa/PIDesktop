import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { CircleAlert, CloudDownload, KeyRound, LoaderCircle, Plus, X } from "lucide-react";
import { agent } from "../../lib/agent";
import {
  defaultBaseUrlPlaceholder,
  endpointPreview,
  enrichModel,
  PROVIDER_APIS,
  requiresBaseUrl,
  slugifyProviderId,
  type EnrichedModel,
  type ModelCatalog,
} from "../../lib/modelProviders";
import type { ModelProviderInput, ModelProviderModel } from "../../types";
import { ApiCandidatePicker } from "./ApiCandidatePicker";
import {
  effectiveModelThinking,
  errorText,
  Toggle,
} from "./modelPageHelpers";
import { SelectedModelsList } from "./SelectedModelsList";

export function CustomProviderEditor({
  initial,
  takenIds,
  catalog,
  onClose,
  onSaved,
}: {
  initial: ModelProviderInput;
  takenIds: ReadonlySet<string>;
  catalog: ModelCatalog;
  onClose: () => void;
  onSaved: (saved: ModelProviderInput) => Promise<void>;
}) {
  const editing = Boolean(initial.originalId);
  const [draft, setDraft] = useState<ModelProviderInput>(initial);
  const [idTouched, setIdTouched] = useState(editing || Boolean(initial.id));
  const [discovered, setDiscovered] = useState<ModelProviderModel[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sources, setSources] = useState<Record<string, EnrichedModel>>({});
  const [discovering, setDiscovering] = useState(false);
  const [manualId, setManualId] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  const patch = (next: Partial<ModelProviderInput>) => setDraft((current) => ({ ...current, ...next }));
  const setName = (name: string) => patch(idTouched ? { name } : { name, id: slugifyProviderId(name) });
  const selectedIds = new Set(draft.models.map((model) => model.id));
  const needle = modelQuery.trim().toLowerCase();
  const filteredDiscovered = discovered.filter(
    (model) => !needle || model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
  );
  const preview = endpointPreview(draft.api, draft.baseUrl);
  const idError = !draft.id.trim()
    ? ""
    : !/^[a-z0-9][a-z0-9._-]*$/i.test(draft.id)
      ? "只能包含字母、数字、点、下划线和连字符"
      : takenIds.has(draft.id)
        ? "该 ID 已被其他提供商使用"
        : "";

  const toggleModel = (model: ModelProviderModel) => {
    if (selectedIds.has(model.id)) {
      patch({ models: draft.models.filter((item) => item.id !== model.id) });
      if (expanded === model.id) setExpanded(null);
      return;
    }
    const enriched = enrichModel(model, catalog);
    setSources((current) => ({ ...current, [model.id]: enriched }));
    patch({ models: [...draft.models, enriched.model] });
  };
  const removeSelectedModel = (id: string) => {
    patch({ models: draft.models.filter((item) => item.id !== id) });
    if (expanded === id) setExpanded(null);
  };
  const changeModel = (id: string, next: Partial<ModelProviderModel>) => {
    patch({ models: draft.models.map((model) => (model.id === id ? { ...model, ...next } : model)) });
    setSources(({ [id]: _edited, ...rest }) => rest);
  };
  const addManual = () => {
    const id = manualId.trim();
    if (!id || selectedIds.has(id)) return;
    const known = discovered.find((model) => model.id === id);
    if (known) {
      patch({ models: [...draft.models, known] });
    } else {
      const enriched = enrichModel({ id, name: "", reasoning: false, input: ["text"], contextWindow: null, maxTokens: null }, catalog);
      patch({ models: [...draft.models, enriched.model] });
      setSources((current) => ({ ...current, [id]: enriched }));
    }
    setManualId("");
  };
  const discover = async () => {
    setDiscovering(true);
    setError("");
    try {
      const enriched = (await agent.discoverModelProviderModels({ ...draft, id: draft.id || "discover" })).map((model) =>
        enrichModel(model, catalog),
      );
      const models = enriched.map((entry) => entry.model);
      const byEnriched = new Map(models.map((item) => [item.id, item]));
      if (draft.models.length > 0) {
        patch({
          models: draft.models.map((existing) => {
            const synced = byEnriched.get(existing.id);
            if (!synced) return enrichModel(existing, catalog).model;
            return {
              ...existing,
              contextWindow: existing.contextWindow ?? synced.contextWindow,
              maxTokens: existing.maxTokens ?? synced.maxTokens,
              reasoning: existing.reasoning || synced.reasoning,
              thinkingLevel: existing.thinkingLevel ?? synced.thinkingLevel,
              thinkingLevels: existing.thinkingLevels ?? synced.thinkingLevels,
              input: existing.input.includes("image") || synced.input.includes("image") ? ["text", "image"] : ["text"],
              cost: existing.cost ?? synced.cost,
            };
          }),
        });
      }
      setSources((current) => ({ ...current, ...Object.fromEntries(enriched.map((entry) => [entry.model.id, entry])) }));
      setDiscovered(models);
      setPickerOpen(models.length > 0);
      if (models.length === 0) setError("该接口没有返回模型列表，请手动添加模型 ID。");
    } catch (nextError) {
      setError(`获取模型失败：${errorText(nextError)}`);
    } finally {
      setDiscovering(false);
    }
  };
  const save = async () => {
    if (!draft.id.trim() || idError) return setError(idError || "请填写提供商 ID");
    if (requiresBaseUrl(draft.api) && !draft.baseUrl.trim()) return setError("请填写 API 地址");
    if (draft.models.length === 0) return setError("至少选择或添加一个模型");
    setBusy(true);
    setError("");
    try {
      const normalizedDraft: ModelProviderInput = {
        ...draft,
        models: draft.models.map((item) => {
          const level = effectiveModelThinking(item.reasoning, item.thinkingLevel);
          const rawTiers = level === "off"
            ? undefined
            : item.thinkingLevels?.length
              ? Array.from(new Set(["off", ...item.thinkingLevels, level]))
              : undefined;
          return {
            ...item,
            reasoning: level !== "off",
            thinkingLevel: level,
            ...(rawTiers ? { thinkingLevels: rawTiers } : { thinkingLevels: undefined }),
            contextWindow: item.contextWindow || 128_000,
            input: item.input.includes("image") ? ["text", "image"] : ["text"],
          };
        }),
      };
      await agent.saveModelProvider(normalizedDraft);
      await onSaved(normalizedDraft);
    } catch (nextError) {
      setError(errorText(nextError));
      setBusy(false);
    }
  };

  return (
    <motion.div
      className="models-editor-backdrop"
      data-escape-layer
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <motion.div
        className="models-editor"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "编辑自定义提供商" : "添加自定义提供商"}
        initial={{ opacity: 0, scale: 0.965, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.975, y: 6 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        <header>
          <strong>{editing ? `编辑 ${initial.name || initial.id}` : "添加自定义提供商"}</strong>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} title="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="models-editor-body">
          <div className="models-editor-fields">
            <label>
              <span>名称</span>
              <input
                autoFocus={!editing}
                value={draft.name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如 公司网关 或 本地 Ollama"
              />
            </label>
            <label>
              <span>提供商 ID</span>
              <input
                value={draft.id}
                disabled={editing}
                onChange={(event) => {
                  setIdTouched(true);
                  patch({ id: event.target.value.trim() });
                }}
                placeholder="根据名称自动生成"
              />
              {idError && <em className="models-field-error">{idError}</em>}
            </label>
            <label>
              <span>接口协议</span>
              <select value={draft.api} onChange={(event) => patch({ api: event.target.value })}>
                {PROVIDER_APIS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>API 密钥</span>
              <span className="models-key-input">
                <KeyRound size={13} />
                <input
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={draft.apiKey}
                  onChange={(event) =>
                    patch({ apiKey: event.target.value, keepExistingApiKey: event.target.value ? false : draft.keepExistingApiKey })
                  }
                  placeholder={draft.keepExistingApiKey ? "已配置，留空则保留" : "sk-…、$ENV_VAR 或留空"}
                />
              </span>
            </label>
            <label className="wide">
              <span>API 地址</span>
              <input
                value={draft.baseUrl}
                onChange={(event) => patch({ baseUrl: event.target.value })}
                placeholder={defaultBaseUrlPlaceholder(draft.api)}
                spellCheck={false}
              />
              {preview && <em className="models-field-hint">请求端点预览：<code>{preview}</code></em>}
            </label>
            <label className="wide models-editor-inline">
              <Toggle checked={draft.authHeader} label="Authorization Bearer" onChange={(value) => patch({ authHeader: value })} />
              <span>
                <span>强制注入 <code>Authorization: Bearer</code> 请求头</span>
                <small>仅当非标准反向代理网关要求时开启。</small>
              </span>
            </label>
          </div>

          <div className="models-editor-models">
            <div className="models-editor-models-head">
              <h3>
                已选模型
                <span>仅同步保留已选的 {draft.models.length} 个模型</span>
              </h3>
              <div className="models-editor-head-actions">
                {discovered.length > 0 && !pickerOpen && (
                  <button type="button" className="models-subtle-link" onClick={() => setPickerOpen(true)}>
                    <span>展开 API 候选（{discovered.length}）</span>
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={discovering || (requiresBaseUrl(draft.api) && !draft.baseUrl.trim())}
                  onClick={() => void discover()}
                >
                  {discovering ? <LoaderCircle size={13} className="spinner-icon" /> : <CloudDownload size={13} />}
                  <span>{discovering ? "正在获取…" : "从 API 获取"}</span>
                </button>
              </div>
            </div>

            <div className="models-key-row">
              <span className="models-key-input">
                <Plus size={13} />
                <input
                  value={manualId}
                  spellCheck={false}
                  onChange={(event) => setManualId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addManual();
                    }
                  }}
                  placeholder="手动输入模型 ID，回车添加"
                />
              </span>
              {manualId.trim() && (
                <button type="button" className="secondary-button" onClick={addManual}>
                  <span>添加 ID</span>
                </button>
              )}
            </div>

            {pickerOpen && discovered.length > 0 && (
              <ApiCandidatePicker
                discovered={discovered}
                filteredDiscovered={filteredDiscovered}
                selectedIds={selectedIds}
                sources={sources}
                modelQuery={modelQuery}
                onChangeQuery={setModelQuery}
                onToggleModel={toggleModel}
                onClosePicker={() => setPickerOpen(false)}
              />
            )}

            <SelectedModelsList
              models={draft.models}
              discoveredCount={discovered.length}
              sources={sources}
              expanded={expanded}
              onSetExpanded={setExpanded}
              onChangeModel={changeModel}
              onRemoveModel={removeSelectedModel}
            />
          </div>
        </div>
        <footer>
          {error ? (
            <span className="models-field-error">
              <CircleAlert size={13} />
              <span>{error}</span>
            </span>
          ) : (
            <span className="models-hint">配置将持久化保存至 ~/.qianji/providers.json</span>
          )}
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="primary-button" onClick={() => void save()} disabled={busy}>
            {busy && <LoaderCircle size={13} className="spinner-icon" />}
            <span>{editing ? "保存" : "添加"}</span>
          </button>
        </footer>
      </motion.div>
    </motion.div>
  );
}
