import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, ChevronRight, Image as ImageIcon, Search, X } from "lucide-react";
import type { ModelInfo } from "../types";
import { effectiveThinkingLevel, resolveThinkingLevels, thinkingLabel } from "../lib/thinkingLevels";

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
  const levels = useMemo(() => resolveThinkingLevels(thinkingLevels, model), [model, thinkingLevels]);
  const currentLevel = effectiveThinkingLevel(thinkingLevel, levels);
  const modelName = model ? (model.name || model.id) : null;

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
          currentLevel={currentLevel}
          onClose={onClose}
          onModelChange={onModelChange}
          onThinkingChange={onThinkingChange}
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
  currentLevel,
  onClose,
  onModelChange,
  onThinkingChange,
}: {
  model: ModelInfo | null;
  models: ModelInfo[];
  levels: string[];
  currentLevel: string | null;
  onClose: () => void;
  onModelChange: (model: ModelInfo) => void;
  onThinkingChange: (level: string) => void;
}) {
  // Query and flyout state live here so they reset for free whenever the menu unmounts.
  const [query, setQuery] = useState("");
  const [levelsOpen, setLevelsOpen] = useState<LevelsOpen>(false);
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
    const inSearch = event.target === searchRef.current;
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

  const closeLevels = () => setLevelsOpen(false);

  return (
    <div ref={menuRef} className="model-picker-menu" role="dialog" aria-label="选择模型和思考等级" onKeyDown={moveFocus}>
      <label className="model-picker-search" onPointerEnter={closeLevels} onFocus={closeLevels}>
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
            onClick={() => setLevelsOpen((value) => value || "keyboard")}
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
              currentLevel={currentLevel}
              focusOnOpen={levelsOpen === "keyboard"}
              onDismiss={() => {
                setLevelsOpen(false);
                thinkingRowRef.current?.focus();
              }}
              onSelect={(level) => {
                onClose();
                if (level !== currentLevel) onThinkingChange(level);
              }}
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
        onPointerEnter={closeLevels}
        onFocus={closeLevels}
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
  currentLevel,
  focusOnOpen,
  onDismiss,
  onSelect,
}: {
  levels: string[];
  currentLevel: string | null;
  focusOnOpen: boolean;
  onDismiss: () => void;
  onSelect: (level: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusOnOpen) return;
    const buttons = menuRef.current?.querySelectorAll<HTMLElement>("button");
    (menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? buttons?.[0])?.focus();
  }, [focusOnOpen]);

  return (
    <div
      ref={menuRef}
      className="model-picker-levels"
      role="menu"
      aria-label="思考等级"
      onKeyDown={(event) => {
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
      {levels.map((level) => (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={level === currentLevel}
          className={level === currentLevel ? "active" : ""}
          key={level}
          onClick={() => onSelect(level)}
        >
          <span>{thinkingLabel(level)}</span>
          {level === currentLevel && <Check size={13} strokeWidth={2} />}
        </button>
      ))}
    </div>
  );
}
