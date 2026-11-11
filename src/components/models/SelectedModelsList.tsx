import { X } from "lucide-react";
import { formatTokenCount, type EnrichedModel } from "../../lib/modelProviders";
import { thinkingLabel } from "../../lib/thinkingLevels";
import type { ModelProviderModel, ModelThinkingLevel } from "../../types";
import {
  CapabilitySourceTag,
  CONTEXT_WINDOW_PRESETS,
  effectiveModelThinking,
  MODEL_THINKING_OPTIONS,
} from "./modelPageHelpers";
import { ModelThinkingLevelsEditor } from "./ModelThinkingLevelsEditor";

export interface SelectedModelsListProps {
  models: ModelProviderModel[];
  discoveredCount: number;
  sources: Record<string, EnrichedModel>;
  expanded: string | null;
  onSetExpanded: (next: string | null) => void;
  onChangeModel: (id: string, next: Partial<ModelProviderModel>) => void;
  onRemoveModel: (id: string) => void;
}

export function SelectedModelsList({
  models,
  discoveredCount,
  sources,
  expanded,
  onSetExpanded,
  onChangeModel,
  onRemoveModel,
}: SelectedModelsListProps) {
  if (models.length === 0) {
    return (
      <div className="models-editor-model-list">
        <div className="models-model-empty">
          {discoveredCount > 0
            ? "请从上方 API 候选列表中勾选要启用的模型（未选模型不会被同步）。"
            : "填写 API 地址后点击“从 API 获取”按需勾选，或手动输入模型 ID 回车添加。"}
        </div>
      </div>
    );
  }

  return (
    <div className="models-editor-model-list">
      {models.map((current) => {
        const hasImage = current.input.includes("image");
        const currentThinking = effectiveModelThinking(current.reasoning, current.thinkingLevel);
        const currentCtx = current.contextWindow ?? 128_000;
        const hasPresetCtx = CONTEXT_WINDOW_PRESETS.some(([val]) => val === currentCtx);

        return (
          <div key={current.id} className="models-editor-model selected">
            <div className="models-editor-model-row">
              <div className="models-selected-title">
                <strong>{current.name || current.id}</strong>
                {current.name && current.name !== current.id && <code>{current.id}</code>}
                <CapabilitySourceTag entry={sources[current.id]} />
              </div>

              <div className="models-inline-cap-controls">
                <select
                  className="models-cap-select"
                  aria-label={`${current.id} 最大上下文`}
                  title="最大上下文窗口"
                  value={String(currentCtx)}
                  onChange={(event) => onChangeModel(current.id, { contextWindow: Number(event.target.value) })}
                >
                  {!hasPresetCtx && (
                    <option value={String(currentCtx)}>
                      上下文 {formatTokenCount(currentCtx) || currentCtx}
                    </option>
                  )}
                  {CONTEXT_WINDOW_PRESETS.map(([val, label]) => (
                    <option key={val} value={String(val)}>上下文 {label}</option>
                  ))}
                </select>

                <select
                  className={`models-cap-select ${currentThinking !== "off" ? "is-active-think" : ""}`}
                  aria-label={`${current.id} 思考等级`}
                  title="模型思考能力与默认推理等级"
                  value={currentThinking}
                  onChange={(event) => {
                    const nextLevel = event.target.value as ModelThinkingLevel;
                    onChangeModel(current.id, {
                      reasoning: nextLevel !== "off",
                      thinkingLevel: nextLevel,
                    });
                  }}
                >
                  {MODEL_THINKING_OPTIONS.map(([val, label]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                  {Array.from(
                    new Set([
                      ...(current.thinkingLevels ?? []),
                      currentThinking,
                    ]),
                  )
                    .filter((lvl) => lvl && !MODEL_THINKING_OPTIONS.some(([opt]) => opt === lvl))
                    .map((lvl) => (
                      <option key={lvl} value={lvl}>{`思考 · ${thinkingLabel(lvl)}`}</option>
                    ))}
                </select>

                <button
                  type="button"
                  className={`models-cap-toggle ${hasImage ? "is-on" : ""}`}
                  aria-pressed={hasImage}
                  title="切换该模型是否支持图片多模态输入"
                  onClick={() => onChangeModel(current.id, { input: hasImage ? ["text"] : ["text", "image"] })}
                >
                  <span>{hasImage ? "支持图片" : "不支持图片"}</span>
                </button>

                <button
                  type="button"
                  className="models-subtle-link"
                  onClick={() => onSetExpanded(expanded === current.id ? null : current.id)}
                >
                  {expanded === current.id ? "收起" : "详情"}
                </button>

                <button
                  type="button"
                  className="models-remove-selected"
                  title={`移除 ${current.name || current.id}`}
                  aria-label={`移除 ${current.name || current.id}`}
                  onClick={() => onRemoveModel(current.id)}
                >
                  <X size={13} />
                </button>
              </div>
            </div>

            {expanded === current.id && (
              <div className="models-editor-model-details">
                <label>
                  <span>显示名称</span>
                  <input
                    value={current.name}
                    onChange={(event) => onChangeModel(current.id, { name: event.target.value })}
                    placeholder={current.id}
                  />
                </label>
                <label>
                  <span>上下文</span>
                  <input
                    type="number"
                    min="1"
                    value={current.contextWindow ?? ""}
                    onChange={(event) =>
                      onChangeModel(current.id, { contextWindow: event.target.value ? Number(event.target.value) : null })
                    }
                  />
                </label>
                <label>
                  <span>最大输出</span>
                  <input
                    type="number"
                    min="1"
                    value={current.maxTokens ?? ""}
                    onChange={(event) =>
                      onChangeModel(current.id, { maxTokens: event.target.value ? Number(event.target.value) : null })
                    }
                  />
                </label>
                <label>
                  <span>输入单价 ($/M)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={current.cost?.input ?? ""}
                    placeholder="自动估算"
                    onChange={(event) => {
                      const raw = event.target.value;
                      const nextInput = raw === "" ? null : Number(raw);
                      const nextOutput = current.cost?.output ?? 0;
                      onChangeModel(current.id, {
                        cost:
                          nextInput === null && !current.cost?.output
                            ? null
                            : { ...current.cost, input: nextInput ?? 0, output: nextOutput },
                      });
                    }}
                  />
                </label>
                <label>
                  <span>输出单价 ($/M)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={current.cost?.output ?? ""}
                    placeholder="自动估算"
                    onChange={(event) => {
                      const raw = event.target.value;
                      const nextOutput = raw === "" ? null : Number(raw);
                      const nextInput = current.cost?.input ?? 0;
                      onChangeModel(current.id, {
                        cost:
                          nextOutput === null && !current.cost?.input
                            ? null
                            : { ...current.cost, input: nextInput, output: nextOutput ?? 0 },
                      });
                    }}
                  />
                </label>
                {currentThinking !== "off" && (
                  <ModelThinkingLevelsEditor
                    model={current}
                    currentThinking={currentThinking}
                    onChange={(nextLevels, nextDefault) =>
                      onChangeModel(current.id, {
                        thinkingLevels: nextLevels,
                        ...(nextDefault ? { thinkingLevel: nextDefault, reasoning: nextDefault !== "off" } : {}),
                      })
                    }
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
