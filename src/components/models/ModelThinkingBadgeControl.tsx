import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import type { ProviderModelSummary } from "../../lib/harnessProviders";
import { inferModelThinkingLevels } from "../../lib/modelProviders";
import {
  customThinkingLevelsForModel,
  mergeThinkingLevels,
  normalizeThinkingLevelId,
  preferredThinkingLevelForModel,
  resolveThinkingLevels,
  thinkingLabel,
} from "../../lib/thinkingLevels";
import type { AppSettings } from "../../types";
import { ALL_THINKING_LABELS } from "./modelPageHelpers";

export function ModelThinkingBadgeControl({
  providerId,
  model,
  form,
  onSelectLevel,
  onUpdateCustomLevels,
}: {
  providerId: string;
  model: ProviderModelSummary;
  form: AppSettings;
  onSelectLevel: (level: string) => void;
  onUpdateCustomLevels: (levels: readonly string[], nextSelected?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const inferred = useMemo(
    () => inferModelThinkingLevels(model.id, model.reasoning),
    [model.id, model.reasoning],
  );
  const customLevels = useMemo(
    () => customThinkingLevelsForModel(form, providerId, model.id),
    [form, model.id, providerId],
  );
  const baseLevels = useMemo(
    () =>
      resolveThinkingLevels(
        inferred,
        {
          id: model.id,
          name: model.name,
          provider: providerId,
          reasoning: model.reasoning,
          ...(model.thinkingLevels && model.thinkingLevels.length > 0
            ? { thinkingLevels: model.thinkingLevels }
            : {}),
        },
        null,
      ),
    [inferred, model.id, model.name, model.reasoning, model.thinkingLevels, providerId],
  );
  const levels = useMemo(
    () => mergeThinkingLevels(baseLevels, customLevels),
    [baseLevels, customLevels],
  );
  const baseSet = useMemo(() => new Set(baseLevels), [baseLevels]);

  const currentLevel = preferredThinkingLevelForModel(model, form, providerId, inferred);
  const shortLabel = ALL_THINKING_LABELS[currentLevel] ?? thinkingLabel(currentLevel);
  const normalizedDraft = normalizeThinkingLevelId(customDraft);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const hostRoot = document.getElementById("root");
    const viewW = hostRoot?.clientWidth || window.innerWidth;
    const viewH = hostRoot?.clientHeight || window.innerHeight;
    const rect = trigger.getBoundingClientRect();
    const popWidth = popoverRef.current?.offsetWidth || 236;
    const popHeight = popoverRef.current?.offsetHeight || 260;
    const left = Math.min(
      Math.max(12, rect.right - popWidth),
      Math.max(12, viewW - popWidth - 12),
    );
    const spaceBelow = viewH - rect.bottom - 12;
    const top = spaceBelow >= popHeight || rect.top < popHeight
      ? rect.bottom + 6
      : Math.max(12, rect.top - popHeight - 6);
    setCoords({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [levels.length, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || popoverRef.current?.contains(target))) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onScroll = (event: Event) => {
      if (popoverRef.current?.contains(event.target as Node | null)) return;
      updatePosition();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, updatePosition]);

  const handleAddCustom = (event: FormEvent) => {
    event.preventDefault();
    if (!normalizedDraft) return;
    if (normalizedDraft === "off") {
      onSelectLevel("off");
      setCustomDraft("");
      setOpen(false);
      return;
    }
    const nextCustom = customLevels.includes(normalizedDraft)
      ? customLevels
      : [...customLevels, normalizedDraft];
    onUpdateCustomLevels(nextCustom, normalizedDraft);
    setCustomDraft("");
    setOpen(false);
  };

  const handleRemoveCustom = (target: string) => {
    const nextCustom = customLevels.filter((item) => item !== target);
    if (currentLevel === target) {
      const remaining = levels.filter((item) => item !== target);
      const fallback = remaining.includes("medium")
        ? "medium"
        : (remaining.find((item) => item !== "off") ?? "off");
      onUpdateCustomLevels(nextCustom, fallback);
    } else {
      onUpdateCustomLevels(nextCustom);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`models-cap-pill models-think-trigger ${currentLevel === "off" ? "is-think-off" : "is-think"} ${open ? "is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${model.name} 思考等级：${thinkingLabel(currentLevel)}`}
        title={`点击配置 ${model.name} 的思考等级`}
        onClick={() => setOpen((value) => !value)}
      >
        <span>思考·{shortLabel}</span>
        <ChevronDown size={11} strokeWidth={2} />
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popoverRef}
            className="models-think-popover"
            role="dialog"
            aria-label={`${model.name} 思考等级设置`}
            data-escape-layer
            style={{
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              visibility: coords ? "visible" : "hidden",
            }}
          >
            <div className="models-think-popover-head">
              <strong>{model.name}</strong>
              <small>模型思考等级</small>
            </div>

            <div className="models-think-popover-list" role="radiogroup" aria-label={`${model.name} 思考等级`}>
              {levels.map((lvl) => {
                const active = lvl === currentLevel;
                const removable = !baseSet.has(lvl) && customLevels.includes(lvl);
                const label = thinkingLabel(lvl);
                return (
                  <div
                    key={lvl}
                    className={`models-think-option-row ${active ? "is-active" : ""}`}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className="models-think-option-btn"
                      onClick={() => {
                        onSelectLevel(lvl);
                        setOpen(false);
                      }}
                    >
                      <span className="models-think-option-label">
                        <span>{label}</span>
                        {label !== lvl && <code>{lvl}</code>}
                      </span>
                      {active && <Check size={13} strokeWidth={2.2} />}
                    </button>
                    {removable && (
                      <button
                        type="button"
                        className="models-think-option-remove"
                        aria-label={`移除 ${model.name} 自定义思考等级 ${lvl}`}
                        title={`移除自定义档位 ${lvl}`}
                        onClick={() => handleRemoveCustom(lvl)}
                      >
                        <X size={11} strokeWidth={2} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <form className="models-think-popover-custom" onSubmit={handleAddCustom}>
              <input
                value={customDraft}
                onChange={(event) => setCustomDraft(event.target.value)}
                placeholder="新增档位，如 auto / 16384"
                aria-label={`${model.name} 新增自定义思考等级`}
                spellCheck={false}
              />
              <button type="submit" disabled={!normalizedDraft}>
                <Plus size={12} strokeWidth={2} />
                <span>添加</span>
              </button>
            </form>
          </div>,
          document.getElementById("root") ?? document.body,
        )}
    </>
  );
}
