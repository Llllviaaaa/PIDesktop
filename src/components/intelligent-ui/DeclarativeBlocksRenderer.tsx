import { useState } from "react";
import { Send } from "lucide-react";
import {
  formatStatValue,
  interpolateTemplate,
  type IntelligentUiBlock,
  type IntelligentUiStateMap,
  type IntelligentUiStateValue,
} from "../../lib/intelligentUi";
import { ChartRenderer } from "./ChartRenderer";
import { ControlField } from "./ControlField";
import { ChecklistRenderer, TableRenderer } from "./TableAndChecklistRenderers";

export function DeclarativeBlocksRenderer({
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
