/**
 * Scoped stylesheet for `observability` (`系统可观测与诊断`).
 *
 * Injected via `ctx.styles.inject(OBSERVABILITY_CSS, "observability-styles")`,
 * wrapped in `@layer plugin-ui { @scope ([data-qj-plugin="observability"]) { ... } }`.
 * Exclusively uses `--qj-*` semantic design tokens for light/dark/skin adaptation.
 */
export const OBSERVABILITY_CSS = `
.obs-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--qj-text-secondary);
  font-family: var(--qj-font-sans);
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}
.obs-status-pill:hover { background: var(--qj-bg-hover); color: var(--qj-text-primary); }
.obs-status-pill.warn {
  background: color-mix(in srgb, var(--qj-status-warning) 12%, transparent);
  border-color: color-mix(in srgb, var(--qj-status-warning) 28%, transparent);
  color: var(--qj-status-warning);
}
.obs-status-pill.warn:hover { background: color-mix(in srgb, var(--qj-status-warning) 18%, transparent); }
.obs-status-pill.danger {
  background: color-mix(in srgb, var(--qj-status-danger) 13%, transparent);
  border-color: color-mix(in srgb, var(--qj-status-danger) 30%, transparent);
  color: var(--qj-status-danger);
  font-weight: 600;
}
.obs-status-pill.danger:hover { background: color-mix(in srgb, var(--qj-status-danger) 20%, transparent); }

.obs-dot { width: 6px; height: 6px; border-radius: 999px; flex-shrink: 0; background: var(--qj-status-success); }
.obs-dot.warn { background: var(--qj-status-warning); }
.obs-dot.danger {
  background: var(--qj-status-danger);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--qj-status-danger) 22%, transparent);
}

.obs-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: var(--qj-bg-surface);
  color: var(--qj-text-primary);
  font-family: var(--qj-font-sans);
  font-size: 12.5px;
}

.obs-subnav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--qj-border-default);
  background: var(--qj-bg-surface);
  flex-shrink: 0;
}
.obs-subtabs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  border-radius: var(--qj-radius-sm);
  background: var(--qj-bg-subtle);
  min-width: 0;
}
.obs-subtab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 25px;
  padding: 0 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--qj-text-secondary);
  font-family: var(--qj-font-sans);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease;
}
.obs-subtab:hover { color: var(--qj-text-primary); }
.obs-subtab.active {
  background: var(--qj-bg-surface);
  color: var(--qj-text-primary);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.obs-tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  background: var(--qj-bg-active);
  color: var(--qj-text-secondary);
}
.obs-tab-badge.danger { background: color-mix(in srgb, var(--qj-status-danger) 16%, transparent); color: var(--qj-status-danger); }
.obs-tab-badge.warn { background: color-mix(in srgb, var(--qj-status-warning) 16%, transparent); color: var(--qj-status-warning); }

.obs-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.obs-metrics-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.obs-metric-card {
  padding: 9px 11px;
  border-radius: var(--qj-radius-md);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-subtle);
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.obs-metric-label { font-size: 11px; color: var(--qj-text-muted); display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.obs-metric-val { font-size: 13.5px; font-weight: 650; font-variant-numeric: tabular-nums; color: var(--qj-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.obs-metric-sub { font-size: 11px; color: var(--qj-text-secondary); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.obs-card {
  padding: 10px 12px;
  border-radius: var(--qj-radius-md);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-surface);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.obs-card.danger-tint {
  border-color: color-mix(in srgb, var(--qj-status-danger) 32%, var(--qj-border-default));
  background: color-mix(in srgb, var(--qj-status-danger) 4%, var(--qj-bg-surface));
}
.obs-card.warn-tint { border-color: color-mix(in srgb, var(--qj-status-warning) 32%, var(--qj-border-default)); }

.obs-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; font-weight: 600; color: var(--qj-text-primary); }
.obs-row-wrap { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }

.obs-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 25px;
  padding: 0 9px;
  border-radius: var(--qj-radius-sm);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-elevated);
  color: var(--qj-text-primary);
  font-family: var(--qj-font-sans);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.obs-btn:hover:not(:disabled) { background: var(--qj-bg-hover); border-color: var(--qj-border-strong); }
.obs-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.obs-btn.primary { background: var(--qj-brand-soft); border-color: color-mix(in srgb, var(--qj-brand-primary) 30%, transparent); color: var(--qj-brand-primary); }
.obs-btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--qj-brand-primary) 20%, transparent); }
.obs-btn.danger { color: var(--qj-status-danger); border-color: color-mix(in srgb, var(--qj-status-danger) 30%, transparent); background: color-mix(in srgb, var(--qj-status-danger) 8%, transparent); }
.obs-btn.ghost { background: transparent; border-color: transparent; color: var(--qj-text-secondary); padding: 0 6px; }
.obs-btn.ghost:hover:not(:disabled) { background: var(--qj-bg-hover); color: var(--qj-text-primary); }

.obs-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 19px;
  padding: 0 6px;
  border-radius: 5px;
  font-size: 10.5px;
  font-weight: 600;
  background: var(--qj-bg-subtle);
  color: var(--qj-text-secondary);
  border: 1px solid var(--qj-border-subtle);
  white-space: nowrap;
}
.obs-badge.success { color: var(--qj-status-success); background: color-mix(in srgb, var(--qj-status-success) 12%, transparent); }
.obs-badge.warn { color: var(--qj-status-warning); background: color-mix(in srgb, var(--qj-status-warning) 13%, transparent); }
.obs-badge.danger { color: var(--qj-status-danger); background: color-mix(in srgb, var(--qj-status-danger) 13%, transparent); }
.obs-badge.info { color: var(--qj-brand-primary); background: var(--qj-brand-soft); }
.obs-badge.mono { font-family: var(--qj-font-mono); font-weight: 500; }
.obs-badge.clickable { cursor: pointer; }

.obs-mono-path { font-family: var(--qj-font-mono); font-size: 11px; color: var(--qj-text-secondary); padding: 5px 8px; border-radius: var(--qj-radius-sm); background: var(--qj-bg-subtle); border: 1px solid var(--qj-border-subtle); word-break: break-all; }
.obs-code-box { margin: 0; padding: 8px 10px; border-radius: var(--qj-radius-sm); background: var(--qj-bg-subtle); border: 1px solid var(--qj-border-default); color: var(--qj-text-secondary); font-family: var(--qj-font-mono); font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow-y: auto; }
.obs-empty { padding: 20px 14px; border-radius: var(--qj-radius-md); border: 1px dashed var(--qj-border-default); background: var(--qj-bg-subtle); color: var(--qj-text-secondary); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; text-align: center; font-size: 12px; }

.obs-logs-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.obs-filter-bar { padding: 8px 12px; border-bottom: 1px solid var(--qj-border-default); background: var(--qj-bg-subtle); display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.obs-input, .obs-select { height: 26px; padding: 0 8px; border-radius: var(--qj-radius-sm); border: 1px solid var(--qj-border-default); background: var(--qj-bg-surface); color: var(--qj-text-primary); font-family: var(--qj-font-sans); font-size: 11.5px; outline: none; }
.obs-input:focus, .obs-select:focus { border-color: var(--qj-brand-primary); }
.obs-log-meta-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 12px; border-bottom: 1px solid var(--qj-border-subtle); font-size: 11px; color: var(--qj-text-muted); flex-shrink: 0; }
.obs-log-list { flex: 1; min-height: 0; overflow-y: auto; font-family: var(--qj-font-mono); font-size: 11px; line-height: 1.45; }
.obs-log-entry { padding: 5px 12px; border-bottom: 1px solid var(--qj-border-subtle); display: flex; flex-direction: column; gap: 4px; }
.obs-log-entry:hover { background: var(--qj-bg-hover); }
.obs-log-line { display: flex; align-items: flex-start; gap: 6px; min-width: 0; }
.obs-log-time { color: var(--qj-text-muted); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.obs-log-msg { flex: 1; min-width: 0; color: var(--qj-text-primary); word-break: break-word; white-space: pre-wrap; }
`;
