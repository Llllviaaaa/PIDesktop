import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UiSandboxUrlResult } from "@qianji/protocol";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  Eye,
  Layers,
  Maximize2,
  RotateCcw,
  Search,
  Send,
} from "lucide-react";
import { showToast } from "../notifications";
import { harnessRuntimes } from "../lib/harnessRuntime";
import {
  buildInitialWidgetState,
  buildSandboxedWidgetHtml,
  evaluateNumericFormula,
  formatStatValue,
  INTELLIGENT_UI_CANVAS_TAB_ID,
  INTELLIGENT_UI_POSTMESSAGE_SOURCE,
  interpolateTemplate,
  serializeWidgetSource,
  type IntelligentUiArtifact,
  type IntelligentUiBlock,
  type IntelligentUiChartDatum,
  type IntelligentUiControlItem,
  type IntelligentUiStateMap,
  type IntelligentUiStateValue,
  type IntelligentUiVersionGroup,
} from "../lib/intelligentUi";
import { useIntelligentUiStore } from "../stores/intelligentUiStore";
import { useWorkbenchStore } from "../stores/workbenchStore";

export type HtmlSandboxHeightPreset = "compact" | "auto" | "full";

const sandboxUrlCache = new Map<string, string>();

async function resolveSandboxFrameSrc(htmlDoc: string): Promise<string> {
  const cached = sandboxUrlCache.get(htmlDoc);
  if (cached) return cached;
  try {
    const res = await harnessRuntimes.call<UiSandboxUrlResult>("ui.sandboxUrl", { html: htmlDoc });
    if (res?.url) {
      if (sandboxUrlCache.size >= 64) {
        const oldest = sandboxUrlCache.keys().next().value;
        if (oldest !== undefined) sandboxUrlCache.delete(oldest);
      }
      sandboxUrlCache.set(htmlDoc, res.url);
      return res.url;
    }
  } catch {
    // Offline or unit-test environment without Host HTTP server: fall back to data: URL.
  }
  return `data:text/html;charset=utf-8,${encodeURIComponent(htmlDoc)}`;
}

function useDocumentDarkTheme(): boolean {
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === "undefined") return false;
    return document.documentElement.dataset.theme === "dark";
  });

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const sync = () => setIsDark(document.documentElement.dataset.theme === "dark");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

function ControlField({
  item,
  value,
  onChange,
}: {
  item: IntelligentUiControlItem;
  value: IntelligentUiStateValue | undefined;
  onChange: (key: string, next: IntelligentUiStateValue) => void;
}) {
  const unitText = item.unit ? ` ${item.unit}` : "";

  if (item.kind === "slider") {
    const min = typeof item.min === "number" ? item.min : 0;
    const max = typeof item.max === "number" ? item.max : 100;
    const step = typeof item.step === "number" && item.step > 0 ? item.step : 1;
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : min;
    return (
      <label className="pi-iui-control pi-iui-control-slider">
        <div className="pi-iui-control-head">
          <span className="pi-iui-control-label">{item.label}</span>
          <output className="pi-iui-control-value">
            {Number.isInteger(step) ? numeric : numeric.toFixed(String(step).split(".")[1]?.length ?? 1)}
            {unitText}
          </output>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={numeric}
          aria-label={item.label}
          onChange={(event) => onChange(item.key, Number(event.target.value))}
        />
        {item.help && <span className="pi-iui-control-help">{item.help}</span>}
      </label>
    );
  }

  if (item.kind === "toggle") {
    const checked = Boolean(value);
    return (
      <label className="pi-iui-control pi-iui-control-toggle">
        <div className="pi-iui-control-toggle-row">
          <div className="pi-iui-control-copy">
            <span className="pi-iui-control-label">{item.label}</span>
            {item.help && <span className="pi-iui-control-help">{item.help}</span>}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={item.label}
            className={`pi-iui-switch${checked ? " is-on" : ""}`}
            onClick={() => onChange(item.key, !checked)}
          >
            <span className="pi-iui-switch-thumb" />
          </button>
        </div>
      </label>
    );
  }

  if (item.kind === "select") {
    const options = item.options ?? [];
    const current = value !== undefined ? String(value) : String(options[0]?.value ?? "");
    return (
      <label className="pi-iui-control">
        <span className="pi-iui-control-label">{item.label}</span>
        <select
          className="pi-iui-input"
          aria-label={item.label}
          value={current}
          onChange={(event) => {
            const raw = event.target.value;
            const matched = options.find((opt) => String(opt.value) === raw);
            onChange(item.key, matched ? matched.value : raw);
          }}
        >
          {options.map((opt) => (
            <option key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>
        {item.help && <span className="pi-iui-control-help">{item.help}</span>}
      </label>
    );
  }

  if (item.kind === "number") {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : 0;
    return (
      <label className="pi-iui-control">
        <div className="pi-iui-control-head">
          <span className="pi-iui-control-label">{item.label}</span>
          {item.unit && <span className="pi-iui-control-unit">{item.unit}</span>}
        </div>
        <input
          type="number"
          className="pi-iui-input"
          aria-label={item.label}
          min={item.min}
          max={item.max}
          step={item.step ?? 1}
          value={numeric}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            onChange(item.key, Number.isFinite(parsed) ? parsed : 0);
          }}
        />
        {item.help && <span className="pi-iui-control-help">{item.help}</span>}
      </label>
    );
  }

  return (
    <label className="pi-iui-control">
      <span className="pi-iui-control-label">{item.label}</span>
      <input
        type="text"
        className="pi-iui-input"
        aria-label={item.label}
        placeholder={item.placeholder}
        value={value !== undefined ? String(value) : ""}
        onChange={(event) => onChange(item.key, event.target.value)}
      />
      {item.help && <span className="pi-iui-control-help">{item.help}</span>}
    </label>
  );
}

function ChartRenderer({
  block,
  state,
}: {
  block: Extract<IntelligentUiBlock, { type: "chart" }>;
  state: IntelligentUiStateMap;
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const kind = block.kind ?? "bar";
  const unit = block.unit ? ` ${block.unit}` : "";

  const computedSeries = useMemo(() => {
    return (block.series ?? []).map((datum: IntelligentUiChartDatum) => ({
      label: datum.label,
      value: evaluateNumericFormula(datum.formula, datum.value, state),
      secondary: datum.secondaryFormula !== undefined || datum.secondaryValue !== undefined
        ? evaluateNumericFormula(datum.secondaryFormula, datum.secondaryValue, state)
        : undefined,
      tone: datum.tone ?? "accent",
    }));
  }, [block.series, state]);

  if (computedSeries.length === 0) return null;

  const maxVal = Math.max(
    1,
    ...computedSeries.map((item) => Math.max(Math.abs(item.value), item.secondary !== undefined ? Math.abs(item.secondary) : 0)),
  );

  if (kind === "donut") {
    const total = Math.max(0.0001, computedSeries.reduce((sum, item) => sum + Math.max(0, item.value), 0));
    const radius = 52;
    const circumference = 2 * Math.PI * radius;
    const palette = ["var(--accent)", "var(--green)", "var(--yellow)", "var(--text-3)", "var(--blue)"];
    const slices = computedSeries.map((item, idx) => {
      const priorSum = computedSeries
        .slice(0, idx)
        .reduce((sum, prev) => sum + Math.max(0, prev.value), 0);
      const fraction = Math.max(0, item.value) / total;
      return {
        item,
        idx,
        dash: fraction * circumference,
        offset: -(priorSum / total) * circumference,
      };
    });

    return (
      <div className="pi-iui-block pi-iui-chart-block">
        {(block.title || block.subtitle) && (
          <div className="pi-iui-block-header">
            {block.title && <h4 className="pi-iui-block-title">{block.title}</h4>}
            {block.subtitle && <span className="pi-iui-block-subtitle">{block.subtitle}</span>}
          </div>
        )}
        <div className="pi-iui-donut-layout">
          <svg viewBox="0 0 140 140" className="pi-iui-donut-svg" role="img" aria-label={block.title ?? "占比图"}>
            <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--border)" strokeWidth="14" />
            {slices.map(({ item, idx, dash, offset }) => (
              <circle
                key={`${item.label}-${idx}`}
                cx="70"
                cy="70"
                r={radius}
                fill="none"
                stroke={palette[idx % palette.length]}
                strokeWidth={hoveredIndex === idx ? "17" : "14"}
                strokeDasharray={`${dash} ${circumference}`}
                strokeDashoffset={offset}
                transform="rotate(-90 70 70)"
                onMouseEnter={() => setHoveredIndex(idx)}
                onMouseLeave={() => setHoveredIndex(null)}
              />
            ))}
            <text x="70" y="67" textAnchor="middle" className="pi-iui-donut-total-label">
              {hoveredIndex !== null ? computedSeries[hoveredIndex]?.label : "总计"}
            </text>
            <text x="70" y="84" textAnchor="middle" className="pi-iui-donut-total-value">
              {hoveredIndex !== null
                ? `${computedSeries[hoveredIndex]?.value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}${unit}`
                : `${total.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}${unit}`}
            </text>
          </svg>
          <div className="pi-iui-donut-legend">
            {computedSeries.map((item, idx) => {
              const pct = ((Math.max(0, item.value) / total) * 100).toFixed(1);
              return (
                <div
                  key={`${item.label}-${idx}`}
                  className={`pi-iui-donut-legend-row${hoveredIndex === idx ? " is-active" : ""}`}
                  onMouseEnter={() => setHoveredIndex(idx)}
                  onMouseLeave={() => setHoveredIndex(null)}
                >
                  <span className="pi-iui-legend-dot" style={{ background: palette[idx % palette.length] }} />
                  <span className="pi-iui-legend-name">{item.label}</span>
                  <span className="pi-iui-legend-val">
                    {item.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
                    {unit} ({pct}%)
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (kind === "line" || kind === "area") {
    const svgWidth = 560;
    const svgHeight = block.height ? Math.max(140, Math.min(320, block.height)) : 196;
    const padLeft = 44;
    const padRight = 18;
    const padTop = 18;
    const padBottom = 30;
    const plotW = svgWidth - padLeft - padRight;
    const plotH = svgHeight - padTop - padBottom;

    const points = computedSeries.map((item, idx) => {
      const x = padLeft + (computedSeries.length === 1 ? plotW / 2 : (idx / (computedSeries.length - 1)) * plotW);
      const y = padTop + plotH - (Math.max(0, item.value) / maxVal) * plotH;
      return { x, y, item, idx };
    });

    const polyline = points.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ");
    const firstPt = points[0];
    const lastPt = points.at(-1);
    const areaPath = firstPt && lastPt
      ? `M ${firstPt.x.toFixed(1)} ${(padTop + plotH).toFixed(1)} L ${points.map((pt) => `${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(" L ")} L ${lastPt.x.toFixed(1)} ${(padTop + plotH).toFixed(1)} Z`
      : "";
    const hoveredDatum = hoveredIndex !== null ? computedSeries[hoveredIndex] : undefined;

    return (
      <div className="pi-iui-block pi-iui-chart-block">
        <div className="pi-iui-block-header">
          {block.title && <h4 className="pi-iui-block-title">{block.title}</h4>}
          <span className="pi-iui-block-subtitle">
            {hoveredDatum
              ? `${hoveredDatum.label}: ${hoveredDatum.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${unit}`
              : (block.subtitle ?? "")}
          </span>
        </div>
        <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="pi-iui-line-svg" role="img" aria-label={block.title ?? "趋势图"}>
          {[0, 0.5, 1].map((ratio) => {
            const y = padTop + plotH * (1 - ratio);
            const labelVal = (maxVal * ratio).toLocaleString("zh-CN", { maximumFractionDigits: 1 });
            return (
              <g key={ratio}>
                <line x1={padLeft} y1={y} x2={svgWidth - padRight} y2={y} stroke="var(--border)" strokeDasharray="3 3" />
                <text x={padLeft - 8} y={y + 4} textAnchor="end" className="pi-iui-svg-axis">
                  {labelVal}
                </text>
              </g>
            );
          })}
          {kind === "area" && areaPath && (
            <path d={areaPath} fill="color-mix(in srgb, var(--accent) 14%, transparent)" />
          )}
          <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={polyline} />
          {points.map((pt) => (
            <g
              key={`${pt.item.label}-${pt.idx}`}
              onMouseEnter={() => setHoveredIndex(pt.idx)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              <circle
                cx={pt.x}
                cy={pt.y}
                r={hoveredIndex === pt.idx ? 5 : 3.5}
                fill="var(--panel)"
                stroke="var(--accent)"
                strokeWidth="2"
              />
              <text x={pt.x} y={svgHeight - 8} textAnchor="middle" className="pi-iui-svg-axis">
                {pt.item.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
    );
  }

  // Default: Horizontal / clean minimalist comparative bar rows (zero clutter, crisp labels)
  return (
    <div className="pi-iui-block pi-iui-chart-block">
      {(block.title || block.subtitle) && (
        <div className="pi-iui-block-header">
          {block.title && <h4 className="pi-iui-block-title">{block.title}</h4>}
          {block.subtitle && <span className="pi-iui-block-subtitle">{block.subtitle}</span>}
        </div>
      )}
      <div className="pi-iui-bars">
        {computedSeries.map((item, idx) => {
          const pct = Math.min(100, Math.max(1.5, (Math.max(0, item.value) / maxVal) * 100));
          return (
            <div key={`${item.label}-${idx}`} className="pi-iui-bar-row" data-tone={item.tone}>
              <div className="pi-iui-bar-meta">
                <span className="pi-iui-bar-label">{item.label}</span>
                <span className="pi-iui-bar-value">
                  {item.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
                  {unit}
                </span>
              </div>
              <div className="pi-iui-bar-track">
                <div className="pi-iui-bar-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TableRenderer({
  block,
  state,
}: {
  block: Extract<IntelligentUiBlock, { type: "table" }>;
  state: IntelligentUiStateMap;
}) {
  const [query, setQuery] = useState("");
  const [sortState, setSortState] = useState<{ key: string; asc: boolean } | null>(null);

  const resolvedRows = useMemo(() => {
    return (block.rows ?? []).map((row) => {
      const next: Record<string, string | number> = {};
      for (const col of block.columns ?? []) {
        const raw = row[col.key];
        if (typeof raw === "number") next[col.key] = raw;
        else if (typeof raw === "string") next[col.key] = interpolateTemplate(raw, state);
        else if (raw !== undefined && raw !== null) next[col.key] = String(raw);
        else next[col.key] = "";
      }
      return next;
    });
  }, [block.columns, block.rows, state]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? resolvedRows.filter((row) =>
          Object.values(row).some((cell) => String(cell).toLowerCase().includes(q)),
        )
      : resolvedRows;
    if (!sortState) return base;
    const { key, asc } = sortState;
    return [...base].sort((a, b) => {
      const va = a[key] ?? "";
      const vb = b[key] ?? "";
      const na = Number(va);
      const nb = Number(vb);
      const cmp = Number.isFinite(na) && Number.isFinite(nb) && va !== "" && vb !== ""
        ? na - nb
        : String(va).localeCompare(String(vb), "zh-CN");
      return asc ? cmp : -cmp;
    });
  }, [query, resolvedRows, sortState]);

  return (
    <div className="pi-iui-block pi-iui-table-block">
      {(block.title || block.searchable) && (
        <div className="pi-iui-block-header">
          {block.title && <h4 className="pi-iui-block-title">{block.title}</h4>}
          {block.searchable && (
            <label className="pi-iui-table-search">
              <Search size={12} strokeWidth={1.8} />
              <input
                type="search"
                placeholder="筛选行…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
        </div>
      )}
      <div className="pi-iui-table-scroll">
        <table className="pi-iui-table">
          <thead>
            <tr>
              {(block.columns ?? []).map((col) => {
                const sortable = col.sortable !== false;
                const active = sortState?.key === col.key;
                return (
                  <th key={col.key} style={{ textAlign: col.align ?? "left" }}>
                    {sortable ? (
                      <button
                        type="button"
                        className={`pi-iui-th-btn${active ? " is-sorted" : ""}`}
                        onClick={() =>
                          setSortState((prev) =>
                            prev?.key === col.key ? { key: col.key, asc: !prev.asc } : { key: col.key, asc: true },
                          )
                        }
                      >
                        <span>{col.label}</span>
                        {active && <span className="pi-iui-sort-arrow">{sortState.asc ? "↑" : "↓"}</span>}
                      </button>
                    ) : (
                      col.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row, idx) => (
              <tr key={idx}>
                {(block.columns ?? []).map((col) => (
                  <td key={col.key} style={{ textAlign: col.align ?? "left" }}>
                    {row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
            {filteredRows.length === 0 && (
              <tr>
                <td colSpan={Math.max(1, block.columns?.length ?? 1)} className="pi-iui-table-empty">
                  暂无匹配数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChecklistRenderer({
  block,
  state,
  onSendPrompt,
}: {
  block: Extract<IntelligentUiBlock, { type: "checklist" }>;
  state: IntelligentUiStateMap;
  onSendPrompt: (prompt: string) => void;
}) {
  const [checkedIds, setCheckedIds] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const item of block.items ?? []) {
      init[item.id] = Boolean(item.checked);
    }
    return init;
  });

  const toggle = (id: string) => {
    setCheckedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const selectedLabels = (block.items ?? [])
    .filter((item) => checkedIds[item.id])
    .map((item) => item.label);

  return (
    <div className="pi-iui-block pi-iui-checklist-block">
      {block.title && (
        <div className="pi-iui-block-header">
          <h4 className="pi-iui-block-title">{block.title}</h4>
          <span className="pi-iui-block-subtitle">
            已选 {selectedLabels.length}/{block.items?.length ?? 0}
          </span>
        </div>
      )}
      <div className="pi-iui-checklist-items">
        {(block.items ?? []).map((item) => {
          const checked = Boolean(checkedIds[item.id]);
          return (
            <label key={item.id} className={`pi-iui-check-row${checked ? " is-checked" : ""}`}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(item.id)}
              />
              <div className="pi-iui-check-copy">
                <span className="pi-iui-check-label">{interpolateTemplate(item.label, state)}</span>
                {item.detail && (
                  <span className="pi-iui-check-detail">{interpolateTemplate(item.detail, state)}</span>
                )}
              </div>
            </label>
          );
        })}
      </div>
      {block.submitLabel && (
        <div className="pi-iui-form-footer">
          <button
            type="button"
            className="pi-iui-submit-btn"
            disabled={selectedLabels.length === 0}
            onClick={() => {
              const joined = selectedLabels.join("、");
              const prompt = block.promptTemplate
                ? interpolateTemplate(block.promptTemplate, { ...state, selected: joined })
                : `我已确认选择以下项：${joined}`;
              onSendPrompt(prompt);
            }}
          >
            <Send size={12} strokeWidth={1.8} />
            <span>{block.submitLabel}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function DeclarativeBlocksRenderer({
  blocks,
  state,
  widgetTitle,
  onChangeState,
  onSendPrompt,
}: {
  blocks: readonly IntelligentUiBlock[];
  state: IntelligentUiStateMap;
  widgetTitle: string;
  onChangeState: (key: string, next: IntelligentUiStateValue) => void;
  onSendPrompt: (prompt: string) => void;
}) {
  const [activeTabs, setActiveTabs] = useState<Record<number, string>>({});

  return (
    <div className="pi-iui-declarative-stack">
      {blocks.map((block, index) => {
        if (block.type === "controls") {
          const cols = block.columns ? Math.min(3, Math.max(1, block.columns)) : undefined;
          const minCardWidth = cols === 1 ? 260 : cols === 3 ? 165 : 190;
          return (
            <div key={index} className="pi-iui-block">
              {block.title && (
                <div className="pi-iui-block-header">
                  <h4 className="pi-iui-block-title">{block.title}</h4>
                </div>
              )}
              <div
                className="pi-iui-controls-grid"
                style={cols ? { gridTemplateColumns: `repeat(auto-fit, minmax(${minCardWidth}px, 1fr))` } : undefined}
              >
                {(block.items ?? []).map((item) => (
                  <ControlField
                    key={item.key}
                    item={item}
                    value={state[item.key]}
                    onChange={onChangeState}
                  />
                ))}
              </div>
            </div>
          );
        }

        if (block.type === "stats") {
          const cols = block.columns ? Math.min(4, Math.max(1, block.columns)) : undefined;
          const minStatWidth = cols === 1 ? 220 : cols && cols >= 3 ? 145 : 165;
          return (
            <div key={index} className="pi-iui-block">
              {block.title && (
                <div className="pi-iui-block-header">
                  <h4 className="pi-iui-block-title">{block.title}</h4>
                </div>
              )}
              <div
                className="pi-iui-stats-grid"
                style={cols ? { gridTemplateColumns: `repeat(auto-fit, minmax(${minStatWidth}px, 1fr))` } : undefined}
              >
                {(block.items ?? []).map((stat, statIdx) => (
                  <div key={`${stat.label}-${statIdx}`} className="pi-iui-stat-card" data-tone={stat.tone ?? "default"}>
                    <span className="pi-iui-stat-label">{stat.label}</span>
                    <strong className="pi-iui-stat-value">{formatStatValue(stat, state)}</strong>
                    {stat.caption && (
                      <span className="pi-iui-stat-caption">{interpolateTemplate(stat.caption, state)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        }

        if (block.type === "chart") {
          return <ChartRenderer key={index} block={block} state={state} />;
        }

        if (block.type === "table") {
          return <TableRenderer key={index} block={block} state={state} />;
        }

        if (block.type === "tabs") {
          const items = block.items ?? [];
          const firstTab = items[0];
          if (!firstTab) return null;
          const activeId = activeTabs[index] ?? firstTab.id;
          const activeTab = items.find((item) => item.id === activeId) ?? firstTab;
          return (
            <div key={index} className="pi-iui-block pi-iui-tabs-block">
              <div className="pi-iui-tab-bar" role="tablist">
                {items.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={tab.id === activeTab.id}
                    className={`pi-iui-tab-btn${tab.id === activeTab.id ? " is-active" : ""}`}
                    onClick={() => setActiveTabs((prev) => ({ ...prev, [index]: tab.id }))}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="pi-iui-tab-panel" role="tabpanel">
                {activeTab.content && (
                  <p className="pi-iui-tab-prose">{interpolateTemplate(activeTab.content, state)}</p>
                )}
                {Array.isArray(activeTab.blocks) && activeTab.blocks.length > 0 && (
                  <DeclarativeBlocksRenderer
                    blocks={activeTab.blocks}
                    state={state}
                    widgetTitle={widgetTitle}
                    onChangeState={onChangeState}
                    onSendPrompt={onSendPrompt}
                  />
                )}
              </div>
            </div>
          );
        }

        if (block.type === "form") {
          return (
            <form
              key={index}
              className="pi-iui-block pi-iui-form-block"
              onSubmit={(event) => {
                event.preventDefault();
                const prompt = block.promptTemplate
                  ? interpolateTemplate(block.promptTemplate, state)
                  : `基于「${widgetTitle}」当前参数继续分析：${Object.entries(state)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(", ")}`;
                onSendPrompt(prompt);
              }}
            >
              {(block.title || block.description) && (
                <div className="pi-iui-form-head">
                  {block.title && <h4 className="pi-iui-block-title">{block.title}</h4>}
                  {block.description && (
                    <p className="pi-iui-form-desc">{interpolateTemplate(block.description, state)}</p>
                  )}
                </div>
              )}
              {Array.isArray(block.fields) && block.fields.length > 0 && (
                <div className="pi-iui-controls-grid">
                  {block.fields.map((field) => (
                    <ControlField
                      key={field.key}
                      item={field}
                      value={state[field.key]}
                      onChange={onChangeState}
                    />
                  ))}
                </div>
              )}
              <div className="pi-iui-form-footer">
                <button type="submit" className="pi-iui-submit-btn">
                  <Send size={12} strokeWidth={1.8} />
                  <span>{block.submitLabel || "应用参数并发送到对话"}</span>
                </button>
              </div>
            </form>
          );
        }

        if (block.type === "callout") {
          return (
            <div key={index} className="pi-iui-callout" data-tone={block.tone ?? "neutral"}>
              {block.title && <strong className="pi-iui-callout-title">{interpolateTemplate(block.title, state)}</strong>}
              <p className="pi-iui-callout-body">{interpolateTemplate(block.body, state)}</p>
            </div>
          );
        }

        if (block.type === "checklist") {
          return <ChecklistRenderer key={index} block={block} state={state} onSendPrompt={onSendPrompt} />;
        }

        return null;
      })}
    </div>
  );
}

function presetHeightCap(mode: "inline" | "canvas", preset: HtmlSandboxHeightPreset): number {
  if (preset === "compact") return mode === "canvas" ? 420 : 320;
  if (preset === "full") return mode === "canvas" ? 1800 : 1200;
  return mode === "canvas" ? 960 : 640;
}

function SandboxedHtmlRenderer({
  artifact,
  mode,
  heightPreset,
  manualHeight,
  contentHeight,
  onContentHeight,
  onManualHeight,
  onResetHeight,
  onSendPrompt,
}: {
  artifact: IntelligentUiArtifact;
  mode: "inline" | "canvas";
  heightPreset: HtmlSandboxHeightPreset;
  manualHeight: number | null;
  contentHeight: number | null;
  onContentHeight: (height: number) => void;
  onManualHeight: (height: number) => void;
  onResetHeight: () => void;
  onSendPrompt: (prompt: string) => void;
}) {
  const isDark = useDocumentDarkTheme();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const htmlDoc = useMemo(
    () =>
      buildSandboxedWidgetHtml({
        html: artifact.html ?? "",
        widgetId: artifact.id,
        title: artifact.title,
        isDark,
      }),
    [artifact.html, artifact.id, artifact.title, isDark],
  );

  const [resolvedEntry, setResolvedEntry] = useState<{ doc: string; src: string } | null>(() => {
    const cached = sandboxUrlCache.get(htmlDoc);
    return cached ? { doc: htmlDoc, src: cached } : null;
  });

  const frameSrc = useMemo(() => {
    const cached = sandboxUrlCache.get(htmlDoc);
    if (cached) return cached;
    return resolvedEntry?.doc === htmlDoc ? resolvedEntry.src : null;
  }, [htmlDoc, resolvedEntry]);

  useEffect(() => {
    if (sandboxUrlCache.has(htmlDoc)) return;
    let cancelled = false;
    void resolveSandboxFrameSrc(htmlDoc).then((url) => {
      if (!cancelled) setResolvedEntry({ doc: htmlDoc, src: url });
    });
    return () => {
      cancelled = true;
    };
  }, [htmlDoc]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const payload = event.data as Record<string, unknown> | null;
      if (!payload || payload.source !== INTELLIGENT_UI_POSTMESSAGE_SOURCE) return;
      if (payload.widgetId !== artifact.id) return;

      if (payload.kind === "resize" && typeof payload.height === "number" && Number.isFinite(payload.height)) {
        onContentHeight(Math.max(96, Math.ceil(payload.height)));
      } else if (payload.kind === "prompt" && typeof payload.prompt === "string" && payload.prompt.trim()) {
        onSendPrompt(payload.prompt.trim());
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [artifact.id, onContentHeight, onSendPrompt]);

  if (mode === "canvas") {
    return (
      <div className="pi-iui-html-frame-wrap is-canvas-stage">
        {frameSrc ? (
          <iframe
            ref={iframeRef}
            className="pi-iui-html-frame is-canvas-stage"
            sandbox="allow-scripts"
            src={frameSrc}
            title={artifact.title}
          />
        ) : (
          <div className="pi-iui-html-frame-placeholder is-canvas-stage" />
        )}
      </div>
    );
  }

  const cap = presetHeightCap(mode, heightPreset);
  const fallbackHeight = Math.min(cap, 380);
  const autoHeight = contentHeight !== null ? Math.min(cap, Math.max(112, contentHeight)) : fallbackHeight;
  const effectiveHeight = manualHeight ?? autoHeight;
  const isClipped = contentHeight !== null && contentHeight > effectiveHeight + 6;

  const minDrag = 180;
  const maxDrag = 960;

  return (
    <div className="pi-iui-html-frame-wrap">
      {frameSrc ? (
        <iframe
          ref={iframeRef}
          className="pi-iui-html-frame"
          sandbox="allow-scripts"
          src={frameSrc}
          title={artifact.title}
          style={{
            height: `${effectiveHeight}px`,
            pointerEvents: isDragging ? "none" : undefined,
          }}
        />
      ) : (
        <div className="pi-iui-html-frame-placeholder" style={{ height: `${effectiveHeight}px` }} />
      )}
      <div
        className={`pi-iui-resize-bar${isDragging ? " is-dragging" : ""}${isClipped ? " is-clipped" : ""}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label="上下拖动调节沙箱高度"
        title="上下拖动调节沙箱高度（双击恢复适中高度）"
        onDoubleClick={onResetHeight}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragStartRef.current = { startY: event.clientY, startHeight: effectiveHeight };
          setIsDragging(true);
        }}
        onPointerMove={(event) => {
          if (!dragStartRef.current) return;
          const delta = event.clientY - dragStartRef.current.startY;
          const next = Math.round(Math.min(maxDrag, Math.max(minDrag, dragStartRef.current.startHeight + delta)));
          onManualHeight(next);
        }}
        onPointerUp={(event) => {
          if (!dragStartRef.current) return;
          dragStartRef.current = null;
          setIsDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={() => {
          dragStartRef.current = null;
          setIsDragging(false);
        }}
      >
        <span className="pi-iui-resize-status">
          {isClipped
            ? "内容超出当前高度 · 可拖底边或点「完整」"
            : manualHeight !== null
              ? `${effectiveHeight}px · 双击恢复适中`
              : ""}
        </span>
        <span className="pi-iui-resize-grip" aria-hidden="true" />
        <span className="pi-iui-resize-spacer" aria-hidden="true" />
      </div>
    </div>
  );
}

export interface IntelligentUiCardProps {
  group: IntelligentUiVersionGroup;
  defaultVersion?: number;
  mode?: "inline" | "canvas";
}

export function IntelligentUiCard({
  group,
  defaultVersion,
  mode = "inline",
}: IntelligentUiCardProps) {
  const selectedVersionOverride = useIntelligentUiStore((s) => s.selectedVersionById[group.id]);
  const selectedCanvasWidgetId = useIntelligentUiStore((s) => s.selectedWidgetId);
  const selectVersion = useIntelligentUiStore((s) => s.selectVersion);
  const openInCanvas = useIntelligentUiStore((s) => s.openInCanvas);
  const dispatchWidgetPrompt = useIntelligentUiStore((s) => s.dispatchWidgetPrompt);
  const isCanvasPaneOpen = useWorkbenchStore(
    (s) => s.rightOpen && s.activeTab === INTELLIGENT_UI_CANVAS_TAB_ID,
  );

  const activeVersionNumber = selectedVersionOverride ?? defaultVersion ?? group.latest.version;
  const activeArtifact = useMemo(
    () => group.versions.find((item) => item.version === activeVersionNumber) ?? group.latest,
    [activeVersionNumber, group.latest, group.versions],
  );

  const initialState = useMemo(
    () => buildInitialWidgetState(activeArtifact.spec),
    [activeArtifact.spec],
  );

  const [stateOverridesByVersion, setStateOverridesByVersion] = useState<Record<number, IntelligentUiStateMap>>({});
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const [inlineExpanded, setInlineExpanded] = useState(false);
  const [heightPreset, setHeightPreset] = useState<HtmlSandboxHeightPreset>("auto");
  const [manualHeightByKey, setManualHeightByKey] = useState<Record<string, number>>({});
  const [contentHeightByKey, setContentHeightByKey] = useState<Record<string, number>>({});

  const artifactKey = `${activeArtifact.id}:${activeArtifact.version}`;
  const manualHeight = manualHeightByKey[artifactKey] ?? null;
  const contentHeight = contentHeightByKey[artifactKey] ?? null;
  const isFocusedInCanvas = isCanvasPaneOpen && (selectedCanvasWidgetId === null || selectedCanvasWidgetId === group.id);

  const handleContentHeight = useCallback(
    (nextHeight: number) => {
      setContentHeightByKey((prev) => (prev[artifactKey] === nextHeight ? prev : { ...prev, [artifactKey]: nextHeight }));
    },
    [artifactKey],
  );

  const handleManualHeight = useCallback(
    (nextHeight: number) => {
      setManualHeightByKey((prev) => ({ ...prev, [artifactKey]: nextHeight }));
    },
    [artifactKey],
  );

  const handleResetHeight = useCallback(() => {
    setManualHeightByKey((prev) => {
      if (!(artifactKey in prev)) return prev;
      const next = { ...prev };
      delete next[artifactKey];
      return next;
    });
    setHeightPreset("auto");
  }, [artifactKey]);

  const selectHeightPreset = (preset: HtmlSandboxHeightPreset) => {
    setManualHeightByKey((prev) => {
      if (!(artifactKey in prev)) return prev;
      const next = { ...prev };
      delete next[artifactKey];
      return next;
    });
    setHeightPreset(preset);
  };

  const currentHtmlCap = presetHeightCap(mode, heightPreset);
  const currentEffectiveHtmlHeight =
    manualHeight ?? (contentHeight !== null ? Math.min(currentHtmlCap, Math.max(112, contentHeight)) : currentHtmlCap);
  const htmlHasOverflow = contentHeight !== null && contentHeight > currentEffectiveHtmlHeight + 6;

  const currentOverrides = stateOverridesByVersion[activeArtifact.version];
  const mergedState = useMemo(
    () => ({ ...initialState, ...(currentOverrides ?? {}) }),
    [currentOverrides, initialState],
  );

  const isDirty = useMemo(() => {
    if (!currentOverrides) return false;
    return Object.entries(currentOverrides).some(([key, val]) => initialState[key] !== val);
  }, [currentOverrides, initialState]);

  const handleStateChange = (key: string, next: IntelligentUiStateValue) => {
    setStateOverridesByVersion((prev) => ({
      ...prev,
      [activeArtifact.version]: {
        ...(prev[activeArtifact.version] ?? {}),
        [key]: next,
      },
    }));
  };

  const resetState = () => {
    setStateOverridesByVersion((prev) => {
      const next = { ...prev };
      delete next[activeArtifact.version];
      return next;
    });
  };

  const handleSendPrompt = (prompt: string) => {
    dispatchWidgetPrompt(prompt);
    showToast("已将交互结果发送至对话", "info");
  };

  const sourceCode = useMemo(() => serializeWidgetSource(activeArtifact), [activeArtifact]);

  const copySource = () => {
    void navigator.clipboard.writeText(sourceCode).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      showToast("已复制组件源码", "info");
    }).catch(() => undefined);
  };

  const isCollapsedArtifactCard =
    mode === "inline" && activeArtifact.engine === "html" && !inlineExpanded;

  return (
    <section
      className={`pi-iui-card pi-iui-card-${mode}${isCollapsedArtifactCard ? " is-artifact-collapsed" : ""}`}
      data-widget-id={group.id}
      data-widget-version={activeArtifact.version}
      data-widget-engine={activeArtifact.engine}
      aria-label={`交互组件：${activeArtifact.title}`}
    >
      <header className="pi-iui-header">
        {isCollapsedArtifactCard ? (
          <button
            type="button"
            className="pi-iui-header-main pi-iui-artifact-launch"
            onClick={() => openInCanvas(group.id, activeArtifact.version)}
            title="点击在右侧画布全屏打开"
          >
            <span className="pi-iui-glyph" aria-hidden="true">
              <Layers size={14} strokeWidth={1.8} />
            </span>
            <div className="pi-iui-titles">
              <div className="pi-iui-title-row">
                <h3 className="pi-iui-title">{activeArtifact.title}</h3>
                <span className="pi-iui-engine-tag">HTML 沙箱</span>
                {activeArtifact.running && <span className="pi-iui-live-pill">生成中</span>}
              </div>
              <p className="pi-iui-subtitle">
                {activeArtifact.subtitle || "交互式微应用 · 点击在右侧画布全高展开"}
              </p>
            </div>
          </button>
        ) : (
          <div className="pi-iui-header-main">
            <span className="pi-iui-glyph" aria-hidden="true">
              <Layers size={14} strokeWidth={1.8} />
            </span>
            <div className="pi-iui-titles">
              <div className="pi-iui-title-row">
                <h3 className="pi-iui-title">{activeArtifact.title}</h3>
                <span className="pi-iui-engine-tag">
                  {activeArtifact.engine === "html" ? "HTML 沙箱" : "交互视图"}
                </span>
                {activeArtifact.running && <span className="pi-iui-live-pill">生成中</span>}
              </div>
              {activeArtifact.subtitle && (
                <p className="pi-iui-subtitle">{activeArtifact.subtitle}</p>
              )}
            </div>
          </div>
        )}

        <div className="pi-iui-toolbar">
          {group.versions.length > 1 && (
            <div className="pi-iui-versions" role="group" aria-label="组件版本历史">
              {group.versions.map((ver) => (
                <button
                  key={ver.version}
                  type="button"
                  className={`pi-iui-version-btn${ver.version === activeArtifact.version ? " is-active" : ""}`}
                  onClick={() => selectVersion(group.id, ver.version)}
                  title={`切换到第 ${ver.version} 版`}
                >
                  v{ver.version}
                </button>
              ))}
            </div>
          )}

          {isCollapsedArtifactCard ? (
            <>
              <button
                type="button"
                className="pi-iui-inline-toggle-btn"
                onClick={() => setInlineExpanded(true)}
                title="在当前消息气泡内展开预览"
              >
                <ChevronDown size={12} strokeWidth={1.8} />
                <span>内联预览</span>
              </button>
              <button
                type="button"
                className={`pi-iui-canvas-btn${isFocusedInCanvas ? " is-active" : ""}`}
                onClick={() => openInCanvas(group.id, activeArtifact.version)}
                title="在右侧画布全高查看"
              >
                <Maximize2 size={12} strokeWidth={1.8} />
                <span>{isFocusedInCanvas ? "画布已展开" : "画布"}</span>
              </button>
            </>
          ) : (
            <>
              {isDirty && viewMode === "preview" && (
                <button
                  type="button"
                  className="pi-iui-icon-btn"
                  onClick={resetState}
                  title="重置为初始参数"
                  aria-label="重置参数"
                >
                  <RotateCcw size={13} strokeWidth={1.8} />
                </button>
              )}

              {mode === "inline" && activeArtifact.engine === "html" && viewMode === "preview" && (
                <div className="pi-iui-seg pi-iui-height-seg" role="group" aria-label="沙箱高度档位">
                  <button
                    type="button"
                    className={`pi-iui-seg-btn${manualHeight === null && heightPreset === "compact" ? " is-active" : ""}`}
                    onClick={() => selectHeightPreset("compact")}
                    title="紧凑高度（不拉长对话）"
                  >
                    <span>紧凑</span>
                  </button>
                  <button
                    type="button"
                    className={`pi-iui-seg-btn${manualHeight === null && heightPreset === "auto" ? " is-active" : ""}`}
                    onClick={() => selectHeightPreset("auto")}
                    title="适中自适应高度"
                  >
                    <span>适中</span>
                  </button>
                  <button
                    type="button"
                    className={`pi-iui-seg-btn${manualHeight === null && heightPreset === "full" ? " is-active" : ""}`}
                    onClick={() => selectHeightPreset("full")}
                    title="完整展开沙箱内容"
                  >
                    <span>完整</span>
                    {htmlHasOverflow && (manualHeight !== null || heightPreset !== "full") && (
                      <span className="pi-iui-overflow-dot" aria-hidden="true" />
                    )}
                  </button>
                </div>
              )}

              <div className="pi-iui-seg" role="group" aria-label="视图切换">
                <button
                  type="button"
                  className={`pi-iui-seg-btn${viewMode === "preview" ? " is-active" : ""}`}
                  onClick={() => setViewMode("preview")}
                  title="交互预览"
                >
                  <Eye size={12} strokeWidth={1.8} />
                  <span>预览</span>
                </button>
                <button
                  type="button"
                  className={`pi-iui-seg-btn${viewMode === "source" ? " is-active" : ""}`}
                  onClick={() => setViewMode("source")}
                  title="查看定义源码"
                >
                  <Code2 size={12} strokeWidth={1.8} />
                  <span>源码</span>
                </button>
              </div>

              <button
                type="button"
                className="pi-iui-icon-btn"
                onClick={copySource}
                title={copied ? "已复制" : "复制组件源码"}
                aria-label="复制组件源码"
              >
                {copied ? <Check size={13} strokeWidth={1.8} /> : <Copy size={13} strokeWidth={1.8} />}
              </button>

              {mode === "inline" && activeArtifact.engine === "html" && (
                <button
                  type="button"
                  className="pi-iui-inline-toggle-btn"
                  onClick={() => setInlineExpanded(false)}
                  title="收起内联预览"
                >
                  <ChevronUp size={12} strokeWidth={1.8} />
                  <span>收起</span>
                </button>
              )}

              {mode === "inline" && (
                <button
                  type="button"
                  className={`pi-iui-canvas-btn${isFocusedInCanvas ? " is-active" : ""}`}
                  onClick={() => openInCanvas(group.id, activeArtifact.version)}
                  title="在右侧画布中展开"
                >
                  <Maximize2 size={12} strokeWidth={1.8} />
                  <span>画布</span>
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {!isCollapsedArtifactCard && (
        <div className="pi-iui-body">
          {viewMode === "source" ? (
            <div className="pi-iui-source-view">
              <pre>
                <code>{sourceCode}</code>
              </pre>
            </div>
          ) : activeArtifact.engine === "html" ? (
            <SandboxedHtmlRenderer
              artifact={activeArtifact}
              mode={mode}
              heightPreset={heightPreset}
              manualHeight={manualHeight}
              contentHeight={contentHeight}
              onContentHeight={handleContentHeight}
              onManualHeight={handleManualHeight}
              onResetHeight={handleResetHeight}
              onSendPrompt={handleSendPrompt}
            />
          ) : (
            <DeclarativeBlocksRenderer
              blocks={activeArtifact.spec?.blocks ?? []}
              state={mergedState}
              widgetTitle={activeArtifact.title}
              onChangeState={handleStateChange}
              onSendPrompt={handleSendPrompt}
            />
          )}
        </div>
      )}

      {mode === "inline" && viewMode === "preview" && activeArtifact.engine === "declarative" && (
        <footer className="pi-iui-footer">
          <span className="pi-iui-footer-hint">支持实时调节参数 · 点击右上角可在右侧画布并排查看</span>
          <button
            type="button"
            className="pi-iui-footer-link"
            onClick={() => {
              const summary = Object.entries(mergedState)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ");
              handleSendPrompt(
                summary
                  ? `请基于「${activeArtifact.title}」的当前参数（${summary}）给出进一步分析或优化建议。`
                  : `请继续优化交互组件「${activeArtifact.title}」。`,
              );
            }}
          >
            <span>以此状态继续追问</span>
            <ArrowUpRight size={12} strokeWidth={1.8} />
          </button>
        </footer>
      )}
    </section>
  );
}
