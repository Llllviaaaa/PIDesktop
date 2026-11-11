import { Check, Search } from "lucide-react";
import type { EnrichedModel } from "../../lib/modelProviders";
import type { ModelProviderModel } from "../../types";
import { CapabilitySourceTag, modelTraitBadges } from "./modelPageHelpers";

export interface ApiCandidatePickerProps {
  discovered: ModelProviderModel[];
  filteredDiscovered: ModelProviderModel[];
  selectedIds: ReadonlySet<string>;
  sources: Record<string, EnrichedModel>;
  modelQuery: string;
  onChangeQuery: (next: string) => void;
  onToggleModel: (model: ModelProviderModel) => void;
  onClosePicker: () => void;
}

export function ApiCandidatePicker({
  discovered,
  filteredDiscovered,
  selectedIds,
  sources,
  modelQuery,
  onChangeQuery,
  onToggleModel,
  onClosePicker,
}: ApiCandidatePickerProps) {
  const chosenCount = discovered.filter((d) => selectedIds.has(d.id)).length;

  return (
    <div className="models-api-picker-box">
      <div className="models-api-picker-head">
        <span>
          API 可用模型（共 {discovered.length} 个，已选 {chosenCount} 个）
        </span>
        <div className="models-api-picker-tools">
          <label className="models-inline-search">
            <Search size={12} />
            <input
              placeholder="搜索 API 模型…"
              value={modelQuery}
              onChange={(event) => onChangeQuery(event.target.value)}
            />
          </label>
          <button type="button" className="models-picker-done-btn" onClick={onClosePicker}>
            <Check size={12} />
            <span>完成选择</span>
          </button>
        </div>
      </div>
      <div className="models-api-picker-list">
        {filteredDiscovered.length === 0 ? (
          <div className="models-model-empty">没有匹配“{modelQuery}”的候选模型</div>
        ) : (
          filteredDiscovered.map((candidate) => {
            const checked = selectedIds.has(candidate.id);
            const badges = modelTraitBadges(
              candidate.reasoning,
              candidate.thinkingLevel,
              candidate.input,
              candidate.contextWindow,
            );
            return (
              <label key={candidate.id} className={`models-api-candidate ${checked ? "is-checked" : ""}`}>
                <span className="models-api-candidate-left">
                  <input type="checkbox" checked={checked} onChange={() => onToggleModel(candidate)} />
                  <strong>{candidate.name || candidate.id}</strong>
                  {candidate.name && candidate.name !== candidate.id && <code>{candidate.id}</code>}
                </span>
                <span className="models-capability-badges">
                  {badges.map((badge) => (
                    <span key={badge.key} className={`models-cap-pill is-${badge.tone}`}>{badge.label}</span>
                  ))}
                  <CapabilitySourceTag entry={sources[candidate.id]} />
                </span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
