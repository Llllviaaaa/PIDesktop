import { useState, type FormEvent } from "react";
import {
  CircleAlert,
  CircleCheck,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Pencil,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import type { ProviderSummary } from "../../lib/harnessProviders";
import {
  canDisconnect,
  credentialSourceText,
  formatTokenCount,
  modelKey,
} from "../../lib/modelProviders";
import type { AppSettings, ModelProviderConfig } from "../../types";
import { Toggle, type CheckState } from "./modelPageHelpers";
import { ModelThinkingBadgeControl } from "./ModelThinkingBadgeControl";

export function ProviderAccordionBody({
  provider,
  custom,
  config,
  form,
  connecting,
  check,
  hidden,
  onConnect,
  onDisconnect,
  onCheck,
  onVisibility,
  onModelThinkingChange,
  onModelCustomLevelsChange,
  onEdit,
  onDelete,
}: {
  provider: ProviderSummary;
  custom: boolean;
  config: ModelProviderConfig | undefined;
  form: AppSettings;
  connecting: boolean;
  check: CheckState | null;
  hidden: ReadonlySet<string>;
  onConnect: (apiKey: string) => void;
  onDisconnect: () => void;
  onCheck: () => void;
  onVisibility: (modelIds: readonly string[], visible: boolean) => void;
  onModelThinkingChange: (modelId: string, level: string) => void;
  onModelCustomLevelsChange: (modelId: string, levels: readonly string[], nextSelected?: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [replacingKey, setReplacingKey] = useState(false);
  useSyncOnChange([connecting, provider.configured], () => {
    if (!connecting) setReplacingKey(false);
  });

  const effectiveUrl = config?.baseUrl || provider.baseUrl || "";

  return (
    <div className="models-acc-drawer">
      {check && check.status !== "checking" && (
        <div className={`models-check-banner ${check.status}`}>
          {check.status === "ok" ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
          <span>{check.message}</span>
        </div>
      )}

      {provider.configured && !replacingKey ? (
        <div className="models-connected-bar">
          <div className="models-connected-info">
            <span className="models-masked-key">••••••••••••••••••••</span>
            <small>{credentialSourceText(provider)}</small>
          </div>
          <div className="models-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={check?.status === "checking"}
              onClick={onCheck}
            >
              {check?.status === "checking" ? <LoaderCircle size={13} className="spinner-icon" /> : <CircleCheck size={13} />}
              <span>{check?.status === "checking" ? "检测中…" : "测试连接"}</span>
            </button>
            {provider.keySource === "stored" && (
              <button type="button" className="secondary-button" onClick={() => setReplacingKey(true)}>
                <span>更换密钥</span>
              </button>
            )}
            {custom && config && (
              <button type="button" className="secondary-button" onClick={onEdit}>
                <Pencil size={12} />
                <span>管理</span>
              </button>
            )}
            {canDisconnect(provider) && (
              <button type="button" className="secondary-button danger" onClick={onDisconnect}>
                <span>断开</span>
              </button>
            )}
            {custom && config && (
              <button type="button" className="icon-button" onClick={onDelete} title="移除提供商">
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <ConnectForm
          busy={connecting}
          replacing={replacingKey}
          providerName={provider.name}
          onConnect={onConnect}
          onCancelReplace={() => setReplacingKey(false)}
        />
      )}

      {effectiveUrl && (
        <div className="models-drawer-meta-bar">
          <span className="models-endpoint-inline">
            端点：<code>{effectiveUrl}</code>
          </span>
          {custom && config && (
            <button type="button" className="models-subtle-link" onClick={onEdit}>
              <SlidersHorizontal size={12} />
              <span>编辑地址与模型</span>
            </button>
          )}
        </div>
      )}

      {provider.models.length > 0 && (
        <div className="models-mini-list">
          {provider.models.map((model) => {
            const visible = !hidden.has(modelKey(provider.id, model.id));
            const ctxBadge = formatTokenCount(model.contextWindow ?? null);
            const hasVision = model.input.includes("image");
            return (
              <div key={model.id} className={`models-mini-row ${visible ? "" : "is-muted"}`}>
                <span className="models-mini-name">
                  <strong>{model.name}</strong>
                  {model.name !== model.id && <code>{model.id}</code>}
                </span>
                <span className="models-mini-right">
                  {(ctxBadge || model.reasoning || hasVision) && (
                    <span className="models-capability-badges">
                      {ctxBadge && (
                        <span className="models-cap-pill is-ctx">上下文 {ctxBadge}</span>
                      )}
                      {model.reasoning && (
                        <ModelThinkingBadgeControl
                          providerId={provider.id}
                          model={model}
                          form={form}
                          onSelectLevel={(level) => onModelThinkingChange(model.id, level)}
                          onUpdateCustomLevels={(levels, nextSelected) =>
                            onModelCustomLevelsChange(model.id, levels, nextSelected)
                          }
                        />
                      )}
                      {hasVision && (
                        <span className="models-cap-pill is-vision">支持图片</span>
                      )}
                    </span>
                  )}
                  <Toggle
                    checked={visible}
                    label={`在模型选择器中显示 ${model.name}`}
                    onChange={(value) => onVisibility([model.id], value)}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConnectForm({
  busy,
  replacing,
  providerName,
  onConnect,
  onCancelReplace,
}: {
  busy: boolean;
  replacing: boolean;
  providerName: string;
  onConnect: (apiKey: string) => void;
  onCancelReplace: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (apiKey.trim()) onConnect(apiKey.trim());
  };
  return (
    <form className="models-key-row" onSubmit={submit}>
      <span className="models-key-input">
        <KeyRound size={13} />
        <input
          type={reveal ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={`输入 ${providerName} API Key（如 sk-...）`}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
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
      <button type="submit" className="primary-button" disabled={busy || !apiKey.trim()}>
        {busy && <LoaderCircle size={13} className="spinner-icon" />}
        <span>{replacing ? "保存密钥" : "保存并启用"}</span>
      </button>
      {replacing && (
        <button type="button" className="secondary-button" onClick={onCancelReplace}>
          取消
        </button>
      )}
    </form>
  );
}
