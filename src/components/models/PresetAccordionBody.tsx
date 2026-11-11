import { useState, type FormEvent } from "react";
import { Eye, EyeOff, KeyRound, LoaderCircle, SlidersHorizontal } from "lucide-react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { inferModelThinkingLevels } from "../../lib/modelProviders";
import { preferredThinkingLevelForModel } from "../../lib/thinkingLevels";
import type { BuiltinProviderPreset } from "../ProviderBrandIcon";
import type { AppSettings } from "../../types";
import { modelTraitBadges } from "./modelPageHelpers";

export function PresetAccordionBody({
  preset,
  form,
  busy,
  hasHost,
  onActivate,
  onOpenAdvanced,
}: {
  preset: BuiltinProviderPreset;
  form: AppSettings;
  busy: boolean;
  hasHost: boolean;
  onActivate: (apiKey: string, baseUrl: string, selectedIds: ReadonlySet<string>) => void;
  onOpenAdvanced: (selectedIds: ReadonlySet<string>) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [showCustomUrl, setShowCustomUrl] = useState(Boolean(preset.keyless));
  const [reveal, setReveal] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(preset.models.map((m) => m.id)));

  useSyncOnChange([preset.id], () => {
    setApiKey("");
    setBaseUrl(preset.baseUrl);
    setShowCustomUrl(Boolean(preset.keyless));
    setReveal(false);
    setSelectedIds(new Set(preset.models.map((m) => m.id)));
  });

  const canSubmit = hasHost && !busy && selectedIds.size > 0 && (Boolean(preset.keyless) || Boolean(apiKey.trim()));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) onActivate(apiKey, baseUrl, selectedIds);
  };

  const togglePresetModel = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size > 1) next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="models-acc-drawer">
      <form className="models-drawer-form" onSubmit={submit}>
        <div className="models-key-row">
          <span className="models-key-input">
            <KeyRound size={13} />
            <input
              type={reveal ? "text" : "password"}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={preset.keyless ? "本地服务免密钥（可直接启用）" : `输入 ${preset.name} API Key（sk-... 或 $ENV_VAR）`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={busy}
            />
            {apiKey && (
              <button
                type="button"
                className="models-key-eye"
                onClick={() => setReveal((v) => !v)}
                title={reveal ? "隐藏密钥" : "显示密钥"}
              >
                {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            )}
          </span>
          <button type="submit" className="primary-button" disabled={!canSubmit}>
            {busy && <LoaderCircle size={13} className="spinner-icon" />}
            <span>保存并启用</span>
          </button>
        </div>

        <div className="models-drawer-meta-bar">
          <button
            type="button"
            className="models-subtle-link"
            onClick={() => setShowCustomUrl((v) => !v)}
          >
            <span>{showCustomUrl ? "收起代理地址" : `自定义代理地址（默认 ${preset.baseUrl}）`}</span>
          </button>

          <button
            type="button"
            className="models-subtle-link"
            onClick={() => onOpenAdvanced(selectedIds)}
            disabled={!hasHost}
          >
            <SlidersHorizontal size={12} />
            <span>从 API 拉取 / 高级模型配置</span>
          </button>
        </div>

        {showCustomUrl && (
          <div className="models-url-override">
            <input
              className="models-plain-input"
              value={baseUrl}
              spellCheck={false}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={preset.baseUrl}
              disabled={busy}
            />
          </div>
        )}
      </form>

      <div className="models-mini-list">
        {preset.models.map((model) => {
          const checked = selectedIds.has(model.id);
          const resolvedLevel = model.reasoning
            ? preferredThinkingLevelForModel(model, form, preset.id, inferModelThinkingLevels(model.id, model.reasoning))
            : "off";
          const badges = modelTraitBadges(model.reasoning, resolvedLevel, model.input, model.contextWindow);
          return (
            <label key={model.id} className={`models-mini-row is-checkable ${checked ? "" : "is-muted"}`}>
              <span className="models-mini-name">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => togglePresetModel(model.id)}
                />
                <strong>{model.name}</strong>
                {model.name !== model.id && <code>{model.id}</code>}
              </span>
              <span className="models-capability-badges">
                {badges.map((badge) => (
                  <span key={badge.key} className={`models-cap-pill is-${badge.tone}`}>{badge.label}</span>
                ))}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
