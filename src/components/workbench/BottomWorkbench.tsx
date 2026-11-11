import { useCallback, useState } from "react";
import { Plus, TerminalSquare, X } from "lucide-react";
import { usePanelResize } from "../../hooks/usePanelResize";
import { useClientContributions } from "../../lib/clientContributions";
import {
  BOTTOM_PANEL_BOUNDS,
  BOTTOM_PANEL_HEIGHT_KEY,
  BOTTOM_PANEL_KEYS,
  bottomPanelMaxHeight,
} from "../../lib/panelLayout";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import { SlotEntryHost } from "../common/ErrorBoundary";
import { TerminalPanel } from "./TerminalPanel";

export interface BottomWorkbenchProps {
  cwd: string;
  sessionFile: string | null;
  layoutScale: number;
}

export function BottomWorkbench({ cwd, sessionFile, layoutScale }: BottomWorkbenchProps) {
  const bottomOpen = useWorkbenchStore((state) => state.bottomOpen);
  const activeBottomTab = useWorkbenchStore((state) => state.activeBottomTab);
  const setActiveBottomTab = useWorkbenchStore((state) => state.setActiveBottomTab);
  const setBottomOpen = useWorkbenchStore((state) => state.setBottomOpen);
  const requestNewTerminal = useWorkbenchStore((state) => state.requestNewTerminal);
  const contributions = useClientContributions();

  const [everOpened, setEverOpened] = useState(bottomOpen);
  if (bottomOpen && !everOpened) {
    setEverOpened(true);
  }

  const maxSize = useCallback(
    () => bottomPanelMaxHeight(window.innerHeight, layoutScale),
    [layoutScale],
  );

  const resize = usePanelResize({
    storageKey: BOTTOM_PANEL_HEIGHT_KEY,
    bounds: BOTTOM_PANEL_BOUNDS,
    keys: BOTTOM_PANEL_KEYS,
    axis: "y",
    growsWithPointer: false,
    resizingClass: "bottom-panel-is-resizing",
    scale: layoutScale,
    maxSize,
  });

  if (!everOpened) return null;

  const activePluginTab = contributions.bottomPanelTabs.find((tab) => tab.id === activeBottomTab);
  const terminalVisible = bottomOpen && !activePluginTab;

  return (
    <section
      className="pid-bottom-workbench"
      hidden={!bottomOpen}
      style={{ height: `${Math.round(resize.size)}px` }}
      aria-label="底部工作台"
    >
      <div
        className="pid-bottom-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整底部面板高度"
        aria-valuemin={BOTTOM_PANEL_BOUNDS.min}
        aria-valuemax={BOTTOM_PANEL_BOUNDS.max}
        aria-valuenow={Math.round(resize.size)}
        tabIndex={0}
        onPointerDown={resize.beginResize}
        onKeyDown={resize.resizeWithKeyboard}
      />
      <header className="pid-bottom-header">
        <div className="pid-bottom-tabs" role="tablist" aria-label="底部面板视图">
          <button
            type="button"
            role="tab"
            aria-selected={!activePluginTab}
            className={`pid-wb-tab-btn${!activePluginTab ? " active" : ""}`}
            onClick={() => setActiveBottomTab("terminal")}
          >
            <TerminalSquare size={13} />
            <span>终端</span>
          </button>
          {contributions.bottomPanelTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeBottomTab === tab.id}
              className={`pid-wb-tab-btn${activeBottomTab === tab.id ? " active" : ""}`}
              onClick={() => setActiveBottomTab(tab.id)}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
        <div className="pid-wb-subbar-actions">
          {!activePluginTab && (
            <button
              type="button"
              className="pid-wb-icon-btn"
              title="新建终端"
              onClick={requestNewTerminal}
            >
              <Plus size={14} />
            </button>
          )}
          <button
            type="button"
            className="pid-wb-icon-btn"
            title="隐藏底部面板 (Ctrl+J)"
            onClick={() => setBottomOpen(false)}
          >
            <X size={14} />
          </button>
        </div>
      </header>
      <div className="pid-bottom-body">
        <div className="pid-bottom-terminal-pane" hidden={Boolean(activePluginTab)}>
          <TerminalPanel cwd={cwd} visible={terminalVisible} />
        </div>
        {activePluginTab ? (
          <SlotEntryHost
            entry={activePluginTab}
            context={{ cwd, sessionFile }}
            slotName="bottomPanelTabs"
          />
        ) : null}
      </div>
    </section>
  );
}
