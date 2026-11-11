import { Sparkles } from "lucide-react";
import type { Context } from "@deepseek-ai/cordis";
import { showToast, useActiveSession, usePluginConfig } from "@qianji/client";

interface DemoWidgetConfig {
  label: string;
}

const WIDGET_CSS = `
.widget-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-surface);
  color: var(--qj-text-secondary);
  font-size: 11px;
  cursor: pointer;
}
.widget-pill:hover {
  background: var(--qj-bg-hover);
  color: var(--qj-text-primary);
}
`;

function StatusBadge() {
  const session = useActiveSession();
  const config = usePluginConfig<DemoWidgetConfig>("demo-widget", { label: "Ready" });
  return (
    <button
      type="button"
      className="widget-pill"
      onClick={() => showToast(`Active session: ${session.sessionId || session.cwd || "New Chat"}`, "info")}
    >
      <Sparkles size={11} />
      <span>{config.label}</span>
    </button>
  );
}

export const name = "demo-widget-client";
export const inject = ["contributions", "styles"];

export function apply(ctx: Context): void {
  ctx.styles.inject(WIDGET_CSS, "widget");
  ctx.contributions.registerStatusBarItem({
    id: "demo-widget-status",
    align: "right",
    render: () => <StatusBadge />,
  });
}
