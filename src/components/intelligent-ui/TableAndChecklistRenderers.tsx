import { useMemo, useState } from "react";
import { Search, Send } from "lucide-react";
import {
  interpolateTemplate,
  type IntelligentUiBlock,
  type IntelligentUiStateMap,
} from "../../lib/intelligentUi";

export function TableRenderer({
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

export function ChecklistRenderer({
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
