import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, ChevronRight, Image as ImageIcon, Plus, Search, X } from "lucide-react";
import type { ModelInfo } from "../types";
import { useAppStore } from "../store";
import {
  customThinkingLevelsForModel,
  effectiveThinkingLevel,
  modelThinkingKey,
  normalizeThinkingLevelId,
  resolveThinkingLevels,
  thinkingLabel,
  withModelCustomThinkingLevels,
} from "../lib/thinkingLevels";

interface ModelPickerProps {
  model: ModelInfo | null;
  models: ModelInfo[];
  thinkingLevel: string;
  /** Levels Pi reported for the active runtime; may be empty before a runtime exists. */
  thinkingLevels: string[];
  disabled?: boolean;
  isSwitchingModel?: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onModelChange: (model: ModelInfo) => void;
  onThinkingChange: (level: string) => void;
}

/**
 * Composer model + thinking-level picker. Layout follows Vetta's selector: search on top,
 * one "思考等级" row that flies out the level list, then single-line models grouped by provider.
 * The thinking row is hidden for models that cannot reason, so the header and the options never disagree.
 */
export function ModelPicker({
  model,
  models,
  thinkingLevel,
  thinkingLevels,
  disabled = false,
  isSwitchingModel = false,
  open,
  onToggle,
  onClose,
  onModelChange,
  onThinkingChange,
}: ModelPickerProps) {
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const [localCustomByModel, setLocalCustomByModel] = useState<Record<string, string[]>>({});
  const activeModelKey = model ? modelThinkingKey(model.provider, model.id) : "";

  const customLevels = useMemo(() => {
    if (!model) return [];
    const merged = new Set<string>(customThinkingLevelsForModel(settings, model.provider, model.id));
    for (const item of localCustomByModel[activeModelKey] ?? []) merged.add(item);
    return [...merged];
  }, [activeModelKey, localCustomByModel, model, settings]);

  const baseLevels = useMemo(
    () => new Set(resolveThinkingLevels(thinkingLevels, model, null)),
    [model, thinkingLevels],
  );
  const levels = useMemo(
    () => resolveThinkingLevels(thinkingLevels, model, customLevels),
    [customLevels, model, thinkingLevels],
  );
  const removableCustomLevels = useMemo(() => {
    const set = new Set<string>();
    for (const item of customLevels) {
      if (!baseLevels.has(item)) set.add(item);
    }
    return set;
  }, [baseLevels, customLevels]);

  const currentLevel = effectiveThinkingLevel(thinkingLevel, levels);
  const modelName = model ? (model.name || model.id) : null;

  const handleAddCustomLevel = (raw: string) => {
    const normalized = normalizeThinkingLevelId(raw);
    if (!normalized || !model) return;
    setLocalCustomByModel((prev) => {
      const existing = prev[activeModelKey] ?? [];
      if (existing.includes(normalized)) return prev;
      return { ...prev, [activeModelKey]: [...existing, normalized] };
    });
    const latestSettings = useAppStore.getState().settings;
    if (latestSettings) {
      const existing = customThinkingLevelsForModel(latestSettings, model.provider, model.id);
      if (!existing.includes(normalized)) {
        void saveSettings(
          withModelCustomThinkingLevels(latestSettings, model.provider, model.id, [...existing, normalized]),
        );
      }
    }
    onClose();
    if (normalized !== currentLevel) {
      onThinkingChange(normalized);
    }
  };

  const handleRemoveCustomLevel = (target: string) => {
    if (!model) return;
    setLocalCustomByModel((prev) => {
      const existing = prev[activeModelKey];
      if (!existing) return prev;
      return { ...prev, [activeModelKey]: existing.filter((item) => item !== target) };
    });
    const latestSettings = useAppStore.getState().settings;
    if (latestSettings) {
      const existing = customThinkingLevelsForModel(latestSettings, model.provider, model.id);
      void saveSettings(
        withModelCustomThinkingLevels(
          latestSettings,
          model.provider,
          model.id,
          existing.filter((item) => item !== target),
        ),
      );
    }
    if (currentLevel === target) {
      const remaining = levels.filter((item) => item !== target);
      const fallback = remaining.includes("medium")
        ? "medium"
        : remaining.find((item) => item !== "off") ?? "off";
      onThinkingChange(fallback);
    }
  };

  return (
    <div className="model-picker-wrap">
      <button
        type="button"
        className={`model-combo ${open ? "active" : ""} ${isSwitchingModel ? "switching" : ""}`}
        title={isSwitchingModel ? "正在确认模型切换" : model ? `${model.provider}/${model.id}` : "选择模型"}
        disabled={disabled || models.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="model-combo-text">{modelName ?? (models.length ? "选择模型" : "模型")}</span>
        {modelName && currentLevel && currentLevel !== "off" && (
          <span className="model-combo-level">{thinkingLabel(currentLevel)}</span>
        )}
        <ChevronDown size={12} strokeWidth={1.75} />
      </button>
      {open && (
        <ModelPickerMenu
          model={model}
          models={models}
          levels={levels}
          removableCustomLevels={removableCustomLevels}
          currentLevel={currentLevel}
          onClose={onClose}
          onModelChange={onModelChange}
          onThinkingChange={onThinkingChange}
          onAddCustomLevel={handleAddCustomLevel}
          onRemoveCustomLevel={handleRemoveCustomLevel}
        />
      )}
    </div>
  );
}

type LevelsOpen = false | "pointer" | "keyboard";

const ITEM_SELECTOR = "[data-picker-item]";

function ModelPickerMenu({
  model,
  models,
  levels,
  removableCustomLevels,
  currentLevel,
  onClose,
  onModelChange,
  onThinkingChange,
  onAddCustomLevel,
  onRemoveCustomLevel,
}: {
  model: ModelInfo | null;
  models: ModelInfo[];
  levels: string[];
  removableCustomLevels: ReadonlySet<string>;
  currentLevel: string | null;
  onClose: () => void;
  onModelChange: (model: ModelInfo) => void;
  onThinkingChange: (level: string) => void;
  onAddCustomLevel: (raw: string) => void;
  onRemoveCustomLevel: (level: string) => void;
}) {
  // Query and flyout state live here so they reset for free whenever the menu unmounts.
  const [query, setQuery] = useState("");
  const [levelsOpen, setLevelsOpen] = useState<LevelsOpen>(false);
  const [customInputOpen, setCustomInputOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const thinkingRowRef = useRef<HTMLButtonElement>(null);

  const groups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const byProvider = new Map<string, ModelInfo[]>();
    for (const candidate of models) {
      if (normalized
        && !candidate.provider.toLowerCase().includes(normalized)
        && !candidate.id.toLowerCase().includes(normalized)
        && !candidate.name.toLowerCase().includes(normalized)) continue;
      const group = byProvider.get(candidate.provider) || [];
      group.push(candidate);
      byProvider.set(candidate.provider, group);
    }
    return [...byProvider.entries()];
  }, [models, query]);

  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView({ block: "nearest" });
  }, []);

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.tagName === "INPUT" && target !== searchRef.current) return;
    const inSearch = target === searchRef.current;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (inSearch && (event.key === "Home" || event.key === "End")) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Home") return items[0].focus();
    if (event.key === "End") return items[items.length - 1].focus();
    if (event.key === "ArrowDown") return items[index < 0 ? 0 : Math.min(index + 1, items.length - 1)].focus();
    if (index <= 0) return searchRef.current?.focus();
    items[index - 1].focus();
  };

  const closeLevelsOnPointer = () => {
    if (customInputOpen || levelsOpen === "keyboard") return;
    setLevelsOpen(false);
  };

  const closeLevelsOnFocus = () => {
    if (customInputOpen) return;
    setLevelsOpen(false);
  };

  return (
    <div ref={menuRef} className="model-picker-menu" role="dialog" aria-label="选择模型和思考等级" onKeyDown={moveFocus}>
      <label className="model-picker-search" onPointerEnter={closeLevelsOnPointer} onFocus={closeLevelsOnFocus}>
        <Search size={13} strokeWidth={1.75} />
        <input
          ref={searchRef}
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模型或提供商"
          aria-label="搜索模型或提供商"
        />
        {query && (
          <button
            type="button"
            className="model-picker-search-clear"
            aria-label="清除搜索"
            onClick={() => {
              setQuery("");
              searchRef.current?.focus();
            }}
          >
            <X size={12} strokeWidth={2} />
          </button>
        )}
      </label>

      {levels.length > 0 && (
        <div className="model-picker-thinking">
          <button
            ref={thinkingRowRef}
            type="button"
            data-picker-item=""
            className={`model-picker-thinking-row ${levelsOpen ? "open" : ""}`}
            aria-haspopup="menu"
            aria-expanded={Boolean(levelsOpen)}
            onPointerEnter={() => setLevelsOpen((value) => value || "pointer")}
            onClick={() => setLevelsOpen((value) => (value === "keyboard" ? false : "keyboard"))}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              setLevelsOpen("keyboard");
            }}
          >
            <span className="model-picker-thinking-label">思考等级</span>
            <span className="model-picker-thinking-value">{currentLevel ? thinkingLabel(currentLevel) : "未设置"}</span>
            <ChevronRight size={13} strokeWidth={1.75} />
          </button>
          {levelsOpen && (
            <ThinkingLevelMenu
              levels={levels}
              removableCustomLevels={removableCustomLevels}
              currentLevel={currentLevel}
              focusOnOpen={levelsOpen === "keyboard"}
              onCustomInputOpenChange={setCustomInputOpen}
              onDismiss={() => {
                setCustomInputOpen(false);
                setLevelsOpen(false);
                thinkingRowRef.current?.focus();
              }}
              onSelect={(level) => {
                onClose();
                if (level !== currentLevel) onThinkingChange(level);
              }}
              onAddCustom={onAddCustomLevel}
              onRemoveCustom={onRemoveCustomLevel}
            />
          )}
        </div>
      )}
      {levels.length > 0 && <div className="model-picker-separator" />}

      <div
        ref={listRef}
        className="model-picker-list"
        role="menu"
        aria-label="模型"
        onPointerEnter={closeLevelsOnPointer}
        onFocus={closeLevelsOnFocus}
      >
        {groups.map(([provider, providerModels]) => (
          <section className="model-picker-group" key={provider} aria-label={provider}>
            <div className="model-picker-provider">{provider}</div>
            {providerModels.map((candidate) => {
              const selected = model?.provider === candidate.provider && model.id === candidate.id;
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  data-picker-item=""
                  className={selected ? "active" : ""}
                  key={`${candidate.provider}/${candidate.id}`}
                  title={`${candidate.provider}/${candidate.id}`}
                  onClick={() => {
                    onClose();
                    if (!selected) onModelChange(candidate);
                  }}
                >
                  <span className="model-picker-name">{candidate.name || candidate.id}</span>
                  {candidate.input?.includes("image") && (
                    <ImageIcon className="model-picker-badge" size={12} strokeWidth={1.75} aria-label="支持图片" />
                  )}
                  {selected && <Check className="model-picker-check" size={13} strokeWidth={2} />}
                </button>
              );
            })}
          </section>
        ))}
        {groups.length === 0 && (
          <div className="model-picker-empty">
            <Search size={15} strokeWidth={1.75} />
            <strong>没有匹配的模型</strong>
            <span>试试模型 ID 或提供商名称</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingLevelMenu({
  levels,
  removableCustomLevels,
  currentLevel,
  focusOnOpen,
  onCustomInputOpenChange,
  onDismiss,
  onSelect,
  onAddCustom,
  onRemoveCustom,
}: {
  levels: string[];
  removableCustomLevels: ReadonlySet<string>;
  currentLevel: string | null;
  focusOnOpen: boolean;
  onCustomInputOpenChange: (open: boolean) => void;
  onDismiss: () => void;
  onSelect: (level: string) => void;
  onAddCustom: (raw: string) => void;
  onRemoveCustom: (level: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [addingCustom, setAddingCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState("");

  useEffect(() => {
    onCustomInputOpenChange(addingCustom);
  }, [addingCustom, onCustomInputOpenChange]);

  useLayoutEffect(() => {
    const el = menuRef.current;
    const anchor = el?.parentElement;
    if (!el || !anchor || window.getComputedStyle(el).position !== "absolute") return;
    el.style.top = "";
    el.style.right = "";
    const anchorRect = anchor.getBoundingClientRect();
    const margin = 12;
    const defaultTop = anchorRect.top - 5;
    const overflowBottom = defaultTop + el.offsetHeight - (window.innerHeight - margin);
    if (overflowBottom > 0) {
      const maxShiftUp = Math.max(0, defaultTop - margin);
      el.style.top = `${-5 - Math.min(overflowBottom, maxShiftUp)}px`;
    }
    const defaultLeft = anchorRect.left - 9 - el.offsetWidth;
    if (defaultLeft < margin) {
      el.style.right = `calc(100% + ${Math.round(9 - (margin - defaultLeft))}px)`;
    }
  }, [addingCustom, levels.length]);

  useEffect(() => {
    if (!focusOnOpen) return;
    const buttons = menuRef.current?.querySelectorAll<HTMLElement>("button");
    (menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? buttons?.[0])?.focus();
  }, [focusOnOpen]);

  const normalizedDraft = normalizeThinkingLevelId(customDraft);

  return (
    <div
      ref={menuRef}
      className="model-picker-levels"
      role="menu"
      aria-label="思考等级"
      onKeyDown={(event) => {
        if ((event.target as HTMLElement | null)?.tagName === "INPUT") {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setAddingCustom(false);
            setCustomDraft("");
          }
          return;
        }
        if (event.key === "Escape" || event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        event.stopPropagation();
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        buttons[(index + step + buttons.length) % buttons.length]?.focus();
      }}
    >
      <div className="model-picker-levels-heading">思考等级</div>
      {levels.map((level) => {
        const isRemovable = removableCustomLevels.has(level);
        return (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={level === currentLevel}
            className={level === currentLevel ? "active" : ""}
            key={level}
            onClick={() => onSelect(level)}
          >
            <span>{thinkingLabel(level)}</span>
            {isRemovable && (
              <span
                role="button"
                tabIndex={-1}
                aria-label={`移除思考等级 ${level}`}
                title={`移除自定义等级 ${level}`}
                className="model-picker-level-remove"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveCustom(level);
                }}
              >
                <X size={11} strokeWidth={2} />
              </span>
            )}
            {level === currentLevel && <Check size={13} strokeWidth={2} />}
          </button>
        );
      })}
      <div className="model-picker-separator" />
      {!addingCustom ? (
        <button
          type="button"
          className="model-picker-level-add-btn"
          onClick={() => setAddingCustom(true)}
        >
          <Plus size={12} strokeWidth={2} />
          <span>新增思考等级…</span>
        </button>
      ) : (
        <form
          className="model-picker-level-custom-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!normalizedDraft) return;
            onAddCustom(normalizedDraft);
          }}
        >
          <input
            autoFocus
            value={customDraft}
            onChange={(event) => setCustomDraft(event.target.value)}
            placeholder="如 xhigh / auto / 16384"
            aria-label="自定义思考等级"
            spellCheck={false}
          />
          <button type="submit" disabled={!normalizedDraft}>
            添加
          </button>
        </form>
      )}
    </div>
  );
}
