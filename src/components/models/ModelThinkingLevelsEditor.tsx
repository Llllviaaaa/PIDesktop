import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { inferModelThinkingLevels } from "../../lib/modelProviders";
import {
  normalizeThinkingLevelId,
  STANDARD_THINKING_LEVELS,
  thinkingLabel,
} from "../../lib/thinkingLevels";
import type { ModelProviderModel } from "../../types";

export function ModelThinkingLevelsEditor({
  model,
  currentThinking,
  onChange,
}: {
  model: ModelProviderModel;
  currentThinking: string;
  onChange: (nextLevels: string[] | undefined, nextDefault?: string) => void;
}) {
  const [customInput, setCustomInput] = useState("");
  const inferred = useMemo(
    () => inferModelThinkingLevels(model.id, true) ?? ["off", "minimal", "low", "medium", "high"],
    [model.id],
  );
  const activeLevels = useMemo(() => {
    const raw = model.thinkingLevels?.length ? model.thinkingLevels : inferred;
    const set = new Set<string>(["off", ...raw]);
    if (currentThinking && currentThinking !== "off") set.add(currentThinking);
    return [...set];
  }, [currentThinking, inferred, model.thinkingLevels]);

  const candidateLevels = useMemo(() => {
    const set = new Set<string>(STANDARD_THINKING_LEVELS.filter((item) => item !== "off"));
    for (const item of activeLevels) {
      if (item !== "off") set.add(item);
    }
    return [...set];
  }, [activeLevels]);

  const toggleTier = (tier: string) => {
    const enabled = activeLevels.includes(tier);
    const nonOff = activeLevels.filter((item) => item !== "off");
    if (enabled && nonOff.length <= 1) return;
    const next = enabled
      ? activeLevels.filter((item) => item !== tier)
      : [...activeLevels, tier];
    const nextDefault = enabled && currentThinking === tier
      ? next.find((item) => item !== "off")
      : undefined;
    onChange(next, nextDefault);
  };

  const addCustomTier = () => {
    const normalized = normalizeThinkingLevelId(customInput);
    if (!normalized || normalized === "off") return;
    const next = activeLevels.includes(normalized)
      ? activeLevels
      : [...activeLevels, normalized];
    onChange(next, normalized);
    setCustomInput("");
  };

  return (
    <div className="models-thinking-levels-field">
      <div className="models-thinking-levels-head">
        <span>支持的思考档位</span>
        {model.thinkingLevels?.length ? (
          <button
            type="button"
            className="models-subtle-link"
            onClick={() => onChange(undefined)}
          >
            恢复自动推断
          </button>
        ) : (
          <small>自动推断（点击可按需增减）</small>
        )}
      </div>
      <div className="models-thinking-levels-chips">
        {candidateLevels.map((tier) => {
          const on = activeLevels.includes(tier);
          return (
            <button
              key={tier}
              type="button"
              aria-pressed={on}
              className={`models-thinking-tier-chip ${on ? "is-on" : ""}`}
              onClick={() => toggleTier(tier)}
              title={`${thinkingLabel(tier)} (${tier})`}
            >
              <span>{thinkingLabel(tier)}</span>
              {thinkingLabel(tier) !== tier && <code>{tier}</code>}
            </button>
          );
        })}
        <span className="models-thinking-tier-custom">
          <input
            value={customInput}
            onChange={(event) => setCustomInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addCustomTier();
              }
            }}
            placeholder="新增档位，如 ultra / 16384"
            aria-label={`${model.id} 新增思考档位`}
            spellCheck={false}
          />
          {normalizeThinkingLevelId(customInput) && (
            <button type="button" onClick={addCustomTier} aria-label="确认添加档位">
              <Plus size={12} />
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
