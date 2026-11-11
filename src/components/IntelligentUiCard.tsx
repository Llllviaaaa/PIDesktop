import { useCallback, useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { showToast } from "../notifications";
import {
  buildInitialWidgetState,
  INTELLIGENT_UI_CANVAS_TAB_ID,
  serializeWidgetSource,
  type IntelligentUiStateMap,
  type IntelligentUiStateValue,
  type IntelligentUiVersionGroup,
} from "../lib/intelligentUi";
import { useIntelligentUiStore } from "../stores/intelligentUiStore";
import { useWorkbenchStore } from "../stores/workbenchStore";
import { DeclarativeBlocksRenderer } from "./intelligent-ui/DeclarativeBlocksRenderer";
import { IntelligentUiHeader } from "./intelligent-ui/IntelligentUiHeader";
import {
  presetHeightCap,
  SandboxedHtmlRenderer,
  type HtmlSandboxHeightPreset,
} from "./intelligent-ui/SandboxedHtmlRenderer";

export type { HtmlSandboxHeightPreset };

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
      <IntelligentUiHeader
        group={group}
        activeArtifact={activeArtifact}
        mode={mode}
        isCollapsedArtifactCard={isCollapsedArtifactCard}
        isFocusedInCanvas={isFocusedInCanvas}
        isDirty={isDirty}
        viewMode={viewMode}
        setViewMode={setViewMode}
        copied={copied}
        copySource={copySource}
        setInlineExpanded={setInlineExpanded}
        heightPreset={heightPreset}
        manualHeight={manualHeight}
        htmlHasOverflow={htmlHasOverflow}
        selectHeightPreset={selectHeightPreset}
        resetState={resetState}
        selectVersion={selectVersion}
        openInCanvas={openInCanvas}
      />

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
