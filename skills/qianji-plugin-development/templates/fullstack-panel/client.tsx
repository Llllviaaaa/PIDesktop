import { Blocks, RefreshCw } from "lucide-react";
import type { Context } from "@deepseek-ai/cordis";
import {
  openWorkbenchTab,
  showToast,
  useActiveSession,
  useHostRpcQuery,
  usePluginConfig,
} from "@qianji/client";

interface DemoPanelConfig {
  heading: string;
}

interface SummaryResult {
  cwd: string;
  timestamp: string;
}

const PANEL_TAB_ID = "demo-panel-tab";

const PANEL_CSS = `
.panel-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  color: var(--qj-text-primary);
}
.panel-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border-radius: var(--qj-radius-md);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-surface);
}
.panel-meta {
  font-size: 12px;
  color: var(--qj-text-secondary);
}
.panel-btn {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: var(--qj-radius-sm);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-elevated);
  color: var(--qj-text-primary);
  font-size: 12px;
  cursor: pointer;
}
.panel-btn:hover {
  background: var(--qj-bg-hover);
}
`;

function DemoPanelView() {
  const session = useActiveSession();
  const config = usePluginConfig<DemoPanelConfig>("demo-panel", { heading: "Demo Panel" });
  const query = useHostRpcQuery<SummaryResult>("demo_panel.summary", { cwd: session.cwd });

  return (
    <div className="panel-root">
      <div className="panel-card">
        <strong>{config.heading}</strong>
        <span className="panel-meta">Workspace: {session.cwd || "None"}</span>
        {query.data && <span className="panel-meta">Synced: {query.data.timestamp}</span>}
        {query.error && <span className="panel-meta">RPC: {query.error}</span>}
        <button
          type="button"
          className="panel-btn"
          onClick={() => {
            query.refetch();
            showToast("Panel refreshed", "info");
          }}
        >
          <RefreshCw size={12} />
          <span>Refresh</span>
        </button>
      </div>
    </div>
  );
}

export const name = "demo-panel-client";
export const inject = ["contributions", "styles"];

export function apply(ctx: Context): void {
  ctx.styles.inject(PANEL_CSS, "panel");

  ctx.contributions.registerRightWorkbenchTab({
    id: PANEL_TAB_ID,
    label: "Demo Panel",
    icon: <Blocks size={13} />,
    render: () => <DemoPanelView />,
  });

  ctx.contributions.registerTopbarAction({
    id: "demo-panel-open",
    render: () => (
      <button
        type="button"
        className="panel-btn"
        onClick={() => openWorkbenchTab(PANEL_TAB_ID)}
      >
        <Blocks size={12} />
        <span>Demo Panel</span>
      </button>
    ),
  });
}
