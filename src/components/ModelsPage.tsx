import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSyncOnChange } from "../hooks/useSyncOnChange";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/queries";
import { describeError } from "../lib/errors";
import {
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CloudDownload,
  Image,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { agent } from "../lib/agent";
import { harnessProviders, type ProviderModelSummary, type ProviderSummary } from "../lib/harnessProviders";
import {
  buildModelCatalog,
  canDisconnect,
  credentialSourceText,
  endpointPreview,
  enrichModel,
  formatCost,
  formatTokenCount,
  groupProviders,
  isCustomProvider,
  modelKey,
  PROVIDER_APIS,
  providerHue,
  providerMonogram,
  slugifyProviderId,
  type CapabilitySource,
  type EnrichedModel,
  type ModelCatalog,
} from "../lib/modelProviders";
import { useAppStore } from "../store";
import type { AppSettings, ModelProviderConfig, ModelProviderInput, ModelProviderModel } from "../types";

type Update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

const THINKING_LEVELS: Array<[string, string]> = [
  ["off", "关闭"], ["minimal", "最少"], ["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "极高"], ["max", "最高"],
];

interface CheckState {
  providerId: string;
  status: "checking" | "ok" | "error";
  message: string;
}

type Notice = { kind: "success" | "error"; text: string } | null;

function errorText(error: unknown): string {
  return describeError(error);
}

const NO_PROVIDERS: ProviderSummary[] = [];
const NO_CONFIGS: ModelProviderConfig[] = [];

export function ModelsPage({ form, update }: { form: AppSettings; update: Update }) {
  const isTauri = "__TAURI_INTERNALS__" in window;
  const reloadProviderCatalog = useAppStore((state) => state.reloadProviderCatalog);
  const queryClient = useQueryClient();
  const providersQuery = useQuery({
    queryKey: queryKeys.modelProviders(),
    queryFn: () => harnessProviders.list(),
    enabled: isTauri,
  });
  // models.json only marks which providers are custom; it never holds up the list.
  const configsQuery = useQuery({
    queryKey: queryKeys.modelConfigs(),
    queryFn: () => agent.listModelProviders(),
    enabled: isTauri,
  });
  const providers = providersQuery.data ?? NO_PROVIDERS;
  const configs = configsQuery.data ?? NO_CONFIGS;
  // The Host reads providers.json on every change, so refreshing is reading it again.
  const refreshMutation = useMutation({
    mutationFn: async () => {
      await Promise.all([
        queryClient.fetchQuery({ queryKey: queryKeys.modelProviders(), queryFn: () => harnessProviders.list(), staleTime: 0 }),
        queryClient.invalidateQueries({ queryKey: queryKeys.modelConfigs() }),
      ]);
    },
  });
  const refresh = () => refreshMutation.mutateAsync().catch(() => undefined);
  const retry = () => {
    refreshMutation.reset();
    void providersQuery.refetch();
    void configsQuery.refetch();
  };
  const loading = providersQuery.isFetching || refreshMutation.isPending;
  const failure = refreshMutation.error ?? providersQuery.error;
  const loadError = failure ? errorText(failure) : "";
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The provider whose key is being saved. */
  const [connecting, setConnecting] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [editor, setEditor] = useState<ModelProviderInput | null>(null);
  const modelsJsonIds = useMemo(() => new Set(configs.map((config) => config.id)), [configs]);
  const catalog = useMemo(() => buildModelCatalog(providers), [providers]);
  const groups = useMemo(() => groupProviders(providers, query), [providers, query]);
  const selected = providers.find((provider) => provider.id === selectedId) ?? groups[0]?.providers[0] ?? null;
  const hidden = useMemo(() => new Set(form.hiddenModels ?? []), [form.hiddenModels]);

  const applyProviders = (next: ProviderSummary[], text: string) => {
    queryClient.setQueryData(queryKeys.modelProviders(), next);
    setNotice({ kind: "success", text });
    void reloadProviderCatalog();
  };

  const connect = async (provider: ProviderSummary, apiKey: string) => {
    if (connecting !== null) return;
    setConnecting(provider.id);
    setNotice(null);
    setCheck(null);
    try {
      await harnessProviders.setKey(provider.id, apiKey);
      applyProviders(await harnessProviders.list(), `已连接 ${provider.name}`);
    } catch (error) {
      setNotice({ kind: "error", text: `连接 ${provider.name} 失败：${errorText(error)}` });
    } finally {
      setConnecting(null);
    }
  };

  const disconnect = async (provider: ProviderSummary) => {
    if (!window.confirm(`删除已保存的 API 密钥并断开 ${provider.name}？`)) return;
    try {
      await harnessProviders.setKey(provider.id, "");
      applyProviders(await harnessProviders.list(), `已断开 ${provider.name}`);
      setCheck(null);
    } catch (error) {
      setNotice({ kind: "error", text: `断开失败：${errorText(error)}` });
    }
  };

  /** Asks the provider for its models: a cheap call that proves the key and the address. */
  const runCheck = async (provider: ProviderSummary) => {
    setCheck({ providerId: provider.id, status: "checking", message: "" });
    const started = Date.now();
    const result = await harnessProviders.check(provider.id);
    setCheck({
      providerId: provider.id,
      status: result.ok ? "ok" : "error",
      message: result.ok ? `${result.message}，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒` : result.message,
    });
  };

  const setModelsVisible = (provider: ProviderSummary, modelIds: readonly string[], visible: boolean) => {
    const next = new Set(hidden);
    for (const id of modelIds) {
      if (visible) next.delete(modelKey(provider.id, id));
      else next.add(modelKey(provider.id, id));
    }
    update("hiddenModels", [...next].sort());
  };

  const afterConfigChange = async (text: string, nextSelected?: string) => {
    await refresh();
    if (nextSelected) setSelectedId(nextSelected);
    setNotice({ kind: "success", text });
    void reloadProviderCatalog();
  };

  const deleteCustom = async (provider: ProviderSummary) => {
    if (!window.confirm(`从 models.json 删除自定义提供商“${provider.name}”及其模型？`)) return;
    try {
      await agent.deleteModelProvider(provider.id);
      setSelectedId(null);
      await afterConfigChange(`已删除 ${provider.name}`);
    } catch (error) {
      setNotice({ kind: "error", text: `删除失败：${errorText(error)}` });
    }
  };

  const config = selected ? configs.find((item) => item.id === selected.id) : undefined;

  return (
    <div className="models-page">
      <div className="settings-page-heading models-heading">
        <div>
          <h1>模型</h1>
          <p>连接模型提供商，选择新任务默认使用的模型，并决定哪些模型出现在输入框的模型选择器中。</p>
        </div>
        <button className="secondary-button compact" disabled={loading || !isTauri} onClick={() => void refresh()} title="重新读取凭据和 models.json">
          <RefreshCw size={13} className={loading ? "spinner-icon" : ""} />刷新
        </button>
      </div>

      <DefaultModelCard providers={providers} hidden={hidden} form={form} update={update} />

      {notice && (
        <div className={`models-notice ${notice.kind}`} role="status">
          {notice.kind === "success" ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
          <span>{notice.text}</span>
          <button className="icon-button" onClick={() => setNotice(null)} title="关闭"><X size={13} /></button>
        </div>
      )}

      <div className="models-workspace">
        <aside className="models-list" aria-label="模型提供商">
          <label className="models-search">
            <Search size={13} />
            <input placeholder="搜索提供商或模型" value={query} onChange={(event) => setQuery(event.target.value)} />
            {query && <button type="button" onClick={() => setQuery("")} title="清除"><X size={12} /></button>}
          </label>
          <div className="models-list-scroll">
            {loading && providers.length === 0 && <div className="models-list-empty"><LoaderCircle size={14} className="spinner-icon" />正在读取提供商…</div>}
            {groups.map((group) => (
              <section key={group.id}>
                <h3>{group.label}<span>{group.providers.length}</span></h3>
                {group.providers.map((provider) => (
                  <button
                    key={provider.id}
                    className={`models-list-item ${selected?.id === provider.id ? "active" : ""}`}
                    onClick={() => { setSelectedId(provider.id); setCheck(null); }}
                  >
                    <ProviderAvatar provider={provider} />
                    <span>
                      <strong>{provider.name}</strong>
                      <small>{`${provider.models.length} 个模型`}</small>
                    </span>
                    {provider.configured && <i className="models-dot" aria-label="已连接" />}
                  </button>
                ))}
              </section>
            ))}
            {!loading && groups.length === 0 && !loadError && <div className="models-list-empty">没有匹配的提供商</div>}
          </div>
          <button className="models-add" onClick={() => setEditor(emptyDraft())} disabled={!isTauri}>
            <Plus size={13} />添加自定义提供商
          </button>
        </aside>

        <section className="models-detail">
          {loadError ? (
            <div className="models-empty-state">
              <CircleAlert size={20} />
              <strong>无法读取模型提供商</strong>
              <p>{loadError}</p>
              <button className="secondary-button compact" onClick={retry}>重试</button>
            </div>
          ) : !selected ? (
            <div className="models-empty-state">
              {loading ? <LoaderCircle size={20} className="spinner-icon" /> : <KeyRound size={20} />}
              <strong>{loading ? "正在启动模型服务…" : "选择一个提供商"}</strong>
              <p>{isTauri ? "左侧列出了支持的全部提供商。" : "模型设置需要在桌面应用中打开。"}</p>
            </div>
          ) : (
            <ProviderDetail
              key={selected.id}
              provider={selected}
              custom={isCustomProvider(selected, modelsJsonIds)}
              config={config}
              connecting={connecting === selected.id}
              check={check?.providerId === selected.id ? check : null}
              hidden={hidden}
              onConnect={(apiKey) => void connect(selected, apiKey)}
              onDisconnect={() => void disconnect(selected)}
              onCheck={() => void runCheck(selected)}
              onVisibility={(modelIds, visible) => setModelsVisible(selected, modelIds, visible)}
              onEdit={() => config && setEditor(draftFromConfig(config))}
              onDelete={() => void deleteCustom(selected)}
            />
          )}
        </section>
      </div>

      {editor && (
        <CustomProviderEditor
          initial={editor}
          takenIds={new Set(providers.map((provider) => provider.id).filter((id) => id !== editor.originalId))}
          catalog={catalog}
          onClose={() => setEditor(null)}
          onSaved={async (saved) => {
            setEditor(null);
            await afterConfigChange(saved.originalId ? `已更新 ${saved.name || saved.id}` : `已添加 ${saved.name || saved.id}`, saved.id);
          }}
        />
      )}
    </div>
  );
}

function ProviderAvatar({ provider, large = false }: { provider: ProviderSummary; large?: boolean }) {
  const hue = providerHue(provider.id);
  return (
    <span className={`models-avatar ${large ? "large" : ""}`} style={{ ["--avatar-hue" as string]: String(hue) }} aria-hidden="true">
      {providerMonogram(provider.name)}
    </span>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`settings-switch models-switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

function DefaultModelCard({ providers, hidden, form, update }: { providers: ProviderSummary[]; hidden: ReadonlySet<string>; form: AppSettings; update: Update }) {
  const connected = providers.filter((provider) => provider.configured);
  const options = connected
    .map((provider) => ({
      provider,
      models: provider.models.filter((model) => !hidden.has(modelKey(provider.id, model.id))
        || (provider.id === form.provider && model.id === form.model)),
    }))
    .filter((group) => group.models.length > 0);
  const currentProvider = providers.find((provider) => provider.id === form.provider);
  const staleDefault = Boolean(form.provider && form.model && providers.length > 0 && !currentProvider?.configured);
  return (
    <section className="models-default">
      <div className="models-default-row">
        <span>
          <strong>默认模型</strong>
          <small>{staleDefault ? "当前默认模型的提供商尚未连接，新任务需要在输入框中选择模型。" : "新任务使用的模型；在输入框中切换模型后，这里会更新为最后一次的选择。"}</small>
        </span>
        <ModelCombobox
          groups={options}
          providerId={form.provider}
          modelId={form.model}
          warning={staleDefault}
          onChange={(provider, model) => {
            update("provider", provider);
            update("model", model);
          }}
        />
      </div>
      <div className="models-default-row">
        <span>
          <strong>推理等级</strong>
          <small>模型支持时生效；在输入框中调整后，新任务也会沿用。</small>
        </span>
        <select value={form.thinkingLevel} onChange={(event) => update("thinkingLevel", event.target.value)}>
          {THINKING_LEVELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
    </section>
  );
}

function ModelCombobox({ groups, providerId, modelId, warning, onChange }: {
  groups: Array<{ provider: ProviderSummary; models: ProviderModelSummary[] }>;
  providerId: string;
  modelId: string;
  warning: boolean;
  onChange: (providerId: string, modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const needle = query.trim().toLowerCase();
  const filtered = groups
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => !needle
        || model.name.toLowerCase().includes(needle)
        || model.id.toLowerCase().includes(needle)
        || group.provider.name.toLowerCase().includes(needle)),
    }))
    .filter((group) => group.models.length > 0);
  const current = groups.find((group) => group.provider.id === providerId)?.models.find((model) => model.id === modelId);
  const providerName = groups.find((group) => group.provider.id === providerId)?.provider.name ?? providerId;
  const choose = (nextProvider: string, nextModel: string) => {
    onChange(nextProvider, nextModel);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="models-combo" ref={rootRef}>
      <button
        type="button"
        className={`models-combo-trigger ${warning ? "warning" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{current?.name ?? (modelId || "不设默认模型")}</span>
        {modelId && <small>{providerName}</small>}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="models-combo-popover" data-escape-layer>
          <label className="models-search">
            <Search size={13} />
            <input autoFocus placeholder="搜索模型" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="models-combo-scroll" role="listbox">
            {!needle && (
              <button role="option" aria-selected={!modelId} className={`models-combo-option ${!modelId ? "selected" : ""}`} onClick={() => choose("", "")}>
                <span><strong>不设默认模型</strong><small className="plain">新任务需要在输入框中选择模型</small></span>
                {!modelId && <Check size={13} />}
              </button>
            )}
            {filtered.map((group) => (
              <section key={group.provider.id}>
                <h4>{group.provider.name}</h4>
                {group.models.map((model) => {
                  const active = group.provider.id === providerId && model.id === modelId;
                  return (
                    <button key={model.id} role="option" aria-selected={active} className={`models-combo-option ${active ? "selected" : ""}`} onClick={() => choose(group.provider.id, model.id)}>
                      <span><strong>{model.name}</strong><small>{model.id}</small></span>
                      {active && <Check size={13} />}
                    </button>
                  );
                })}
              </section>
            ))}
            {groups.length === 0 && <div className="models-combo-empty">先在下方连接一个提供商</div>}
            {groups.length > 0 && filtered.length === 0 && needle && <div className="models-combo-empty">没有匹配的模型</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderDetail({
  provider, custom, config, connecting, check, hidden,
  onConnect, onDisconnect, onCheck, onVisibility, onEdit, onDelete,
}: {
  provider: ProviderSummary;
  custom: boolean;
  config: ModelProviderConfig | undefined;
  connecting: boolean;
  check: CheckState | null;
  hidden: ReadonlySet<string>;
  onConnect: (apiKey: string) => void;
  onDisconnect: () => void;
  onCheck: () => void;
  onVisibility: (modelIds: readonly string[], visible: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [replacingKey, setReplacingKey] = useState(false);
  // Saving a key, or the provider's configured state changing, ends key replacement.
  useSyncOnChange([connecting, provider.configured], () => {
    if (!connecting) setReplacingKey(false);
  });

  return (
    <div className="models-detail-scroll">
      <header className="models-detail-header">
        <ProviderAvatar provider={provider} large />
        <div>
          <h2>{provider.name}{custom && <span className="models-tag">自定义</span>}</h2>
          <p><code>{provider.id}</code>{provider.baseUrl && <span title={provider.baseUrl}>{provider.baseUrl}</span>}</p>
        </div>
        <span className={`models-status ${provider.configured ? "on" : ""}`}>{provider.configured ? "已连接" : "未连接"}</span>
      </header>

      <div className="models-block">
        <h3>连接</h3>
        {provider.configured && !replacingKey ? (
          <ConnectedState provider={provider} custom={custom} onDisconnect={onDisconnect} onReplaceKey={() => setReplacingKey(true)} onEdit={onEdit} />
        ) : (
          <ConnectForm
            custom={custom}
            busy={connecting}
            replacing={replacingKey}
            onConnect={onConnect}
            onCancelReplace={() => setReplacingKey(false)}
            onEdit={onEdit}
          />
        )}
      </div>

      {provider.configured && (
        <div className="models-block">
          <h3>检查连接</h3>
          <div className="models-check">
            <button className="secondary-button compact" disabled={check?.status === "checking"} onClick={onCheck}>
              {check?.status === "checking" ? <LoaderCircle size={13} className="spinner-icon" /> : <CircleCheck size={13} />}
              {check?.status === "checking" ? "正在检查" : "检查连接"}
            </button>
          </div>
          {check && check.status !== "checking" && (
            <p className={`models-check-result ${check.status}`}>
              {check.status === "ok" ? <CircleCheck size={13} /> : <CircleAlert size={13} />}
              <span>{check.message}</span>
            </p>
          )}
          <small className="models-hint">会向提供商请求模型列表，不调用模型，不产生费用。</small>
        </div>
      )}

      <ModelList provider={provider} hidden={hidden} custom={custom} onVisibility={onVisibility} onEdit={onEdit} />

      {custom && config && (
        <div className="models-block">
          <h3>配置</h3>
          <dl className="models-config">
            <div><dt>协议</dt><dd>{PROVIDER_APIS.find(([value]) => value === config.api)?.[1] ?? (config.api || "默认")}</dd></div>
            <div><dt>API 地址</dt><dd><code>{config.baseUrl || "—"}</code></dd></div>
            {config.baseUrl && <div><dt>请求地址</dt><dd><code>{endpointPreview(config.api, config.baseUrl)}</code></dd></div>}
          </dl>
          <div className="models-actions">
            <button className="secondary-button compact" onClick={onEdit}><Pencil size={13} />编辑配置</button>
            <button className="secondary-button compact danger" onClick={onDelete}><Trash2 size={13} />删除提供商</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectedState({ provider, custom, onDisconnect, onReplaceKey, onEdit }: {
  provider: ProviderSummary;
  custom: boolean;
  onDisconnect: () => void;
  onReplaceKey: () => void;
  onEdit: () => void;
}) {
  const hint = provider.keySource === "environment"
    ? "密钥来自环境变量引用（$变量），由 Harness 在使用时读取。如需更换，请修改环境变量后重启应用。"
    : "密钥加密保存在本机的 ~/.pid/secrets.dat，只供本应用使用。";
  return (
    <div className="models-connected">
      <CircleCheck size={16} />
      <span>
        <strong>{credentialSourceText(provider)}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <div className="models-actions">
        {provider.keySource === "stored" && <button className="secondary-button compact" onClick={onReplaceKey}><KeyRound size={13} />更换密钥</button>}
        {custom && provider.keySource === "environment" && <button className="secondary-button compact" onClick={onEdit}><Pencil size={13} />编辑配置</button>}
        {canDisconnect(provider) && <button className="secondary-button compact danger" onClick={onDisconnect}>删除密钥</button>}
      </div>
    </div>
  );
}

function ConnectForm({ custom, busy, replacing, onConnect, onCancelReplace, onEdit }: {
  custom: boolean;
  busy: boolean;
  replacing: boolean;
  onConnect: (apiKey: string) => void;
  onCancelReplace: () => void;
  onEdit: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (apiKey.trim()) onConnect(apiKey.trim());
  };
  return (
    <div className="models-connect">
      <form className="models-key-form" onSubmit={submit}>
        <div className="models-key-row">
          <span className="models-key-input">
            <KeyRound size={13} />
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder="API 密钥"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={busy}
            />
          </span>
          <button type="submit" className="primary-button compact" disabled={busy || !apiKey.trim()}>
            {busy ? <LoaderCircle size={13} className="spinner-icon" /> : null}{replacing ? "保存" : "连接"}
          </button>
          {replacing && <button type="button" className="secondary-button compact" onClick={onCancelReplace}>取消</button>}
        </div>
        <small className="models-hint">
          {custom
            ? <>密钥加密保存在本机的 ~/.pid/secrets.dat。也可以在 <button type="button" className="models-link" onClick={onEdit}>编辑配置</button> 中填写 $环境变量。</>
            : "密钥加密保存在本机的 ~/.pid/secrets.dat，只供本应用使用。"}
        </small>
      </form>
    </div>
  );
}

function ModelList({ provider, hidden, custom, onVisibility, onEdit }: {
  provider: ProviderSummary;
  hidden: ReadonlySet<string>;
  custom: boolean;
  onVisibility: (modelIds: readonly string[], visible: boolean) => void;
  onEdit: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const models = provider.models.filter((model) => !needle || model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle));
  const visibleCount = provider.models.filter((model) => !hidden.has(modelKey(provider.id, model.id))).length;
  return (
    <div className="models-block">
      <div className="models-block-header">
        <h3>模型 <span>{visibleCount === provider.models.length ? provider.models.length : `${visibleCount} / ${provider.models.length}`}</span></h3>
        {provider.models.length > 8 && (
          <label className="models-search compact">
            <Search size={12} />
            <input placeholder="筛选模型" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        )}
        {provider.models.length > 1 && (
          <div className="models-text-actions">
            <button onClick={() => onVisibility(models.map((model) => model.id), true)}>全部显示</button>
            <button onClick={() => onVisibility(models.map((model) => model.id), false)}>全部隐藏</button>
          </div>
        )}
      </div>
      <small className="models-hint">
        {provider.configured ? "关闭的模型不会出现在输入框的模型选择器中。" : "连接后，开启的模型会出现在输入框的模型选择器中。"}
      </small>
      {provider.models.length === 0 ? (
        <div className="models-model-empty">
          {custom ? <>还没有配置模型。<button className="models-link" onClick={onEdit}>添加模型</button></> : "内置目录中还没有此提供商的模型，连接后刷新即可获取。"}
        </div>
      ) : (
        <div className="models-model-list">
          {models.map((model) => {
            const visible = !hidden.has(modelKey(provider.id, model.id));
            const context = formatTokenCount(model.contextWindow);
            const cost = formatCost(model.cost);
            return (
              <div key={model.id} className={`models-model ${visible ? "" : "off"}`}>
                <span className="models-model-name">
                  <strong>{model.name}</strong>
                  {model.name !== model.id && <code>{model.id}</code>}
                </span>
                <span className="models-caps">
                  {model.reasoning && <em title="支持推理"><Brain size={11} />推理</em>}
                  {model.input.includes("image") && <em title="支持图片输入"><Image size={11} />图片</em>}
                  {context && <em title="上下文窗口">{context}</em>}
                  {cost && <em title="每百万 token 输入 / 输出价格">{cost}</em>}
                </span>
                <Toggle checked={visible} label={`在模型选择器中显示 ${model.name}`} onChange={(value) => onVisibility([model.id], value)} />
              </div>
            );
          })}
          {models.length === 0 && <div className="models-model-empty">没有匹配的模型</div>}
        </div>
      )}
    </div>
  );
}

function emptyDraft(): ModelProviderInput {
  return { originalId: null, id: "", name: "", baseUrl: "", api: "openai-completions", apiKey: "", keepExistingApiKey: false, authHeader: false, models: [] };
}

function draftFromConfig(config: ModelProviderConfig): ModelProviderInput {
  return {
    originalId: config.id,
    id: config.id,
    name: config.name === config.id ? "" : config.name,
    baseUrl: config.baseUrl,
    api: config.api || "openai-completions",
    apiKey: "",
    keepExistingApiKey: config.hasApiKey,
    authHeader: config.authHeader,
    models: config.models.map((model) => ({ ...model, input: [...model.input] })),
  };
}

const SOURCE_LABELS: Record<Exclude<CapabilitySource, "api">, { label: string; hint: string }> = {
  catalog: { label: "内置目录", hint: "能力和上下文来自内置目录中的同名模型" },
  guess: { label: "按名称推测", hint: "内置目录中没有同名模型，能力按模型名称推测，上下文使用默认值，请确认" },
  default: { label: "默认值", hint: "无法识别此模型，使用自定义模型的默认值，请按实际情况修改" },
};

function CapabilitySourceTag({ entry }: { entry: EnrichedModel | undefined }) {
  if (!entry || entry.source === "api") return null;
  const { label, hint } = SOURCE_LABELS[entry.source];
  const title = entry.match ? `${hint}：${entry.match.providerId}/${entry.match.model.id}` : hint;
  return <em className={`models-source ${entry.source}`} title={title}>{label}</em>;
}

function CustomProviderEditor({ initial, takenIds, catalog, onClose, onSaved }: {
  initial: ModelProviderInput;
  takenIds: ReadonlySet<string>;
  catalog: ModelCatalog;
  onClose: () => void;
  onSaved: (saved: ModelProviderInput) => Promise<void>;
}) {
  const editing = Boolean(initial.originalId);
  const [draft, setDraft] = useState<ModelProviderInput>(initial);
  const [idTouched, setIdTouched] = useState(editing);
  const [discovered, setDiscovered] = useState<ModelProviderModel[]>([]);
  // How each fetched or added model's capabilities were filled; cleared once the user edits them.
  const [sources, setSources] = useState<Record<string, EnrichedModel>>({});
  const [discovering, setDiscovering] = useState(false);
  const [manualId, setManualId] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const patch = (next: Partial<ModelProviderInput>) => setDraft((current) => ({ ...current, ...next }));
  const setName = (name: string) => patch(idTouched ? { name } : { name, id: slugifyProviderId(name) });
  const selectedIds = new Set(draft.models.map((model) => model.id));
  const candidates = [...draft.models, ...discovered.filter((model) => !selectedIds.has(model.id))];
  const needle = modelQuery.trim().toLowerCase();
  const shown = candidates.filter((model) => !needle || model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle));
  const preview = endpointPreview(draft.api, draft.baseUrl);
  const idError = !draft.id.trim()
    ? ""
    : !/^[a-z0-9][a-z0-9._-]*$/i.test(draft.id) ? "只能包含字母、数字、点、下划线和连字符"
      : takenIds.has(draft.id) ? "该 ID 已被其他提供商使用" : "";

  const toggleModel = (model: ModelProviderModel) => {
    patch({ models: selectedIds.has(model.id) ? draft.models.filter((item) => item.id !== model.id) : [...draft.models, model] });
  };
  const changeModel = (id: string, next: Partial<ModelProviderModel>) => {
    patch({ models: draft.models.map((model) => model.id === id ? { ...model, ...next } : model) });
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
      // Most OpenAI-compatible relays list only IDs; fill capabilities the way other clients do.
      const enriched = (await agent.discoverModelProviderModels({ ...draft, id: draft.id || "discover" }))
        .map((model) => enrichModel(model, catalog));
      const models = enriched.map((entry) => entry.model);
      setSources((current) => ({ ...current, ...Object.fromEntries(enriched.map((entry) => [entry.model.id, entry])) }));
      setDiscovered(models);
      if (models.length === 0) setError("该接口没有返回模型列表，请手动添加模型 ID。");
    } catch (nextError) {
      setError(`获取模型失败：${errorText(nextError)}`);
    } finally {
      setDiscovering(false);
    }
  };
  const save = async () => {
    if (!draft.id.trim() || idError) return setError(idError || "请填写提供商 ID");
    if (!draft.baseUrl.trim()) return setError("请填写 API 地址");
    if (draft.models.length === 0) return setError("至少选择或添加一个模型");
    setBusy(true);
    setError("");
    try {
      await agent.saveModelProvider(draft);
      await onSaved(draft);
    } catch (nextError) {
      setError(errorText(nextError));
      setBusy(false);
    }
  };

  return (
    <div className="models-editor-backdrop" data-escape-layer onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="models-editor" role="dialog" aria-modal="true" aria-label={editing ? "编辑自定义提供商" : "添加自定义提供商"}>
        <header>
          <strong>{editing ? `编辑 ${initial.name || initial.id}` : "添加自定义提供商"}</strong>
          <button className="icon-button" onClick={onClose} disabled={busy} title="关闭"><X size={16} /></button>
        </header>
        <div className="models-editor-body">
          <div className="models-editor-fields">
            <label>
              <span>名称</span>
              <input autoFocus={!editing} value={draft.name} onChange={(event) => setName(event.target.value)} placeholder="例如 公司网关 或 本地 Ollama" />
            </label>
            <label>
              <span>提供商 ID</span>
              <input
                value={draft.id}
                disabled={editing}
                onChange={(event) => { setIdTouched(true); patch({ id: event.target.value.trim() }); }}
                placeholder="根据名称自动生成"
              />
              {idError && <em className="models-field-error">{idError}</em>}
            </label>
            <label>
              <span>接口协议</span>
              <select value={draft.api} onChange={(event) => patch({ api: event.target.value })}>
                {PROVIDER_APIS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
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
                  onChange={(event) => patch({ apiKey: event.target.value, keepExistingApiKey: event.target.value ? false : draft.keepExistingApiKey })}
                  placeholder={draft.keepExistingApiKey ? "已配置，留空则保留" : "sk-…、$ENV_VAR 或 !command"}
                />
              </span>
            </label>
            <label className="wide">
              <span>API 地址</span>
              <input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" spellCheck={false} />
              {preview && <em className="models-field-hint">请求会发到 <code>{preview}</code></em>}
            </label>
            <label className="wide models-editor-inline">
              <Toggle checked={draft.authHeader} label="Authorization Bearer" onChange={(value) => patch({ authHeader: value })} />
              <span><span>自动添加 <code>Authorization: Bearer</code> 请求头</span><small>仅当非标准接口要求时开启。</small></span>
            </label>
          </div>

          <div className="models-editor-models">
            <div className="models-block-header">
              <h3>模型 <span>已选 {draft.models.length}</span></h3>
              <button className="secondary-button compact" disabled={discovering || !draft.baseUrl.trim()} onClick={() => void discover()}>
                {discovering ? <LoaderCircle size={13} className="spinner-icon" /> : <CloudDownload size={13} />}
                {discovering ? "正在获取" : "从 API 获取"}
              </button>
            </div>
            <div className="models-key-row">
              <span className="models-key-input">
                <Plus size={13} />
                <input
                  value={manualId}
                  spellCheck={false}
                  onChange={(event) => setManualId(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManual(); } }}
                  placeholder="手动输入模型 ID，回车添加"
                />
              </span>
              {candidates.length > 8 && (
                <label className="models-search compact">
                  <Search size={12} />
                  <input placeholder="筛选" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} />
                </label>
              )}
            </div>
            <div className="models-editor-model-list">
              {candidates.length === 0 && <div className="models-model-empty">填写 API 地址后点击「从 API 获取」，或手动添加模型 ID。</div>}
              {shown.map((model) => {
                const selected = selectedIds.has(model.id);
                const current = draft.models.find((item) => item.id === model.id) ?? model;
                return (
                  <div key={model.id} className={`models-editor-model ${selected ? "selected" : ""}`}>
                    <div className="models-editor-model-row">
                      <label>
                        <input type="checkbox" checked={selected} onChange={() => toggleModel(model)} />
                        <span><strong>{current.name || current.id}</strong>{current.name && current.name !== current.id && <code>{current.id}</code>}</span>
                      </label>
                      <span className="models-caps">
                        {current.reasoning && <em><Brain size={11} />推理</em>}
                        {current.input.includes("image") && <em><Image size={11} />图片</em>}
                        {current.contextWindow ? <em>{formatTokenCount(current.contextWindow)}</em> : null}
                        <CapabilitySourceTag entry={sources[model.id]} />
                      </span>
                      {selected && <button className="models-link" onClick={() => setExpanded(expanded === model.id ? null : model.id)}>{expanded === model.id ? "收起" : "详情"}</button>}
                    </div>
                    {selected && expanded === model.id && (
                      <div className="models-editor-model-details">
                        <label><span>显示名称</span><input value={current.name} onChange={(event) => changeModel(model.id, { name: event.target.value })} placeholder={current.id} /></label>
                        <label><span>上下文</span><input type="number" min="1" value={current.contextWindow ?? ""} onChange={(event) => changeModel(model.id, { contextWindow: event.target.value ? Number(event.target.value) : null })} /></label>
                        <label><span>最大输出</span><input type="number" min="1" value={current.maxTokens ?? ""} onChange={(event) => changeModel(model.id, { maxTokens: event.target.value ? Number(event.target.value) : null })} /></label>
                        <label className="models-editor-inline"><Toggle checked={current.reasoning} label="推理模型" onChange={(value) => changeModel(model.id, { reasoning: value })} /><span>推理</span></label>
                        <label className="models-editor-inline"><Toggle checked={current.input.includes("image")} label="支持图片" onChange={(value) => changeModel(model.id, { input: value ? ["text", "image"] : ["text"] })} /><span>图片</span></label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <footer>
          {error ? <span className="models-field-error"><CircleAlert size={13} />{error}</span> : <span className="models-hint">保存到 ~/.pid/providers.json</span>}
          <button className="secondary-button compact" onClick={onClose} disabled={busy}>取消</button>
          <button className="primary-button compact" onClick={() => void save()} disabled={busy}>
            {busy && <LoaderCircle size={13} className="spinner-icon" />}{editing ? "保存" : "添加"}
          </button>
        </footer>
      </div>
    </div>
  );
}
