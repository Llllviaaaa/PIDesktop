import { useMemo, useState } from "react";
import {
  evaluateNumericFormula,
  type IntelligentUiBlock,
  type IntelligentUiChartDatum,
  type IntelligentUiStateMap,
} from "../../lib/intelligentUi";

export function ChartRenderer({
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
