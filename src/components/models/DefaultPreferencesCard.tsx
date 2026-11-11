import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import type { ProviderModelSummary, ProviderSummary } from "../../lib/harnessProviders";
import { inferModelThinkingLevels, modelKey } from "../../lib/modelProviders";
import { preferredThinkingLevelForModel } from "../../lib/thinkingLevels";
import type { AppSettings } from "../../types";
import type { Update } from "./modelPageHelpers";

export function DefaultPreferencesCard({
  providers,
  hidden,
  form,
  update,
}: {
  providers: ProviderSummary[];
  hidden: ReadonlySet<string>;
  form: AppSettings;
  update: Update;
}) {
  const connected = providers.filter((provider) => provider.configured);
  const options = connected
    .map((provider) => ({
      provider,
      models: provider.models.filter(
        (model) => !hidden.has(modelKey(provider.id, model.id)) || (provider.id === form.provider && model.id === form.model),
      ),
    }))
    .filter((group) => group.models.length > 0);
  const currentProvider = providers.find((provider) => provider.id === form.provider);
  const staleDefault = Boolean(form.provider && form.model && providers.length > 0 && !currentProvider?.configured);

  return (
    <section className="settings-layered-section">
      <h2>默认偏好</h2>
      <div className="settings-soft-card">
        <div className="setting-row">
          <span>
            <strong>默认对话模型</strong>
            <small>新对话与后台自动化任务默认选用的模型；思考等级按模型在下方独立配置</small>
          </span>
          <div>
            <ModelCombobox
              groups={options}
              providerId={form.provider}
              modelId={form.model}
              warning={staleDefault}
              onChange={(provider, model) => {
                update("provider", provider);
                update("model", model);
                const picked = options
                  .find((g) => g.provider.id === provider)
                  ?.models.find((m) => m.id === model);
                if (picked) {
                  const resolved = preferredThinkingLevelForModel(
                    picked,
                    form,
                    provider,
                    inferModelThinkingLevels(picked.id, picked.reasoning),
                  );
                  update("thinkingLevel", resolved);
                }
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function ModelCombobox({
  groups,
  providerId,
  modelId,
  warning,
  onChange,
}: {
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
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const needle = query.trim().toLowerCase();
  const filtered = groups
    .map((group) => ({
      ...group,
      models: group.models.filter(
        (model) =>
          !needle ||
          model.name.toLowerCase().includes(needle) ||
          model.id.toLowerCase().includes(needle) ||
          group.provider.name.toLowerCase().includes(needle),
      ),
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
        <span>{current?.name ?? (modelId || "跟随会话选择")}</span>
        {modelId && <small>{providerName}</small>}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="models-combo-popover" data-escape-layer>
          <label className="models-inline-search full">
            <Search size={13} />
            <input autoFocus placeholder="搜索已启用模型…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="models-combo-scroll" role="listbox">
            {!needle && (
              <button
                type="button"
                role="option"
                aria-selected={!modelId}
                className={`models-combo-option ${!modelId ? "selected" : ""}`}
                onClick={() => choose("", "")}
              >
                <span>
                  <strong>跟随会话选择</strong>
                  <small className="plain">沿用对话输入框最近选择的模型</small>
                </span>
                {!modelId && <Check size={13} />}
              </button>
            )}
            {filtered.map((group) => (
              <section key={group.provider.id}>
                <h4>{group.provider.name}</h4>
                {group.models.map((model) => {
                  const active = group.provider.id === providerId && model.id === modelId;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`models-combo-option ${active ? "selected" : ""}`}
                      onClick={() => choose(group.provider.id, model.id)}
                    >
                      <span>
                        <strong>{model.name}</strong>
                        <small>{model.id}</small>
                      </span>
                      {active && <Check size={13} />}
                    </button>
                  );
                })}
              </section>
            ))}
            {groups.length === 0 && <div className="models-combo-empty">启用至少一个服务商后可指定默认模型</div>}
            {groups.length > 0 && filtered.length === 0 && needle && <div className="models-combo-empty">没有匹配的模型</div>}
          </div>
        </div>
      )}
    </div>
  );
}
