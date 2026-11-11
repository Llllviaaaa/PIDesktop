import {
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  Eye,
  Layers,
  Maximize2,
  RotateCcw,
} from "lucide-react";
import type { IntelligentUiArtifact, IntelligentUiVersionGroup } from "../../lib/intelligentUi";
import type { HtmlSandboxHeightPreset } from "./SandboxedHtmlRenderer";

export interface IntelligentUiHeaderProps {
  group: IntelligentUiVersionGroup;
  activeArtifact: IntelligentUiArtifact;
  mode: "inline" | "canvas";
  isCollapsedArtifactCard: boolean;
  isFocusedInCanvas: boolean;
  isDirty: boolean;
  viewMode: "preview" | "source";
  setViewMode: (next: "preview" | "source") => void;
  copied: boolean;
  copySource: () => void;
  setInlineExpanded: (next: boolean) => void;
  heightPreset: HtmlSandboxHeightPreset;
  manualHeight: number | null;
  htmlHasOverflow: boolean;
  selectHeightPreset: (preset: HtmlSandboxHeightPreset) => void;
  resetState: () => void;
  selectVersion: (id: string, version: number) => void;
  openInCanvas: (id: string, version: number) => void;
}

export function IntelligentUiHeader({
  group,
  activeArtifact,
  mode,
  isCollapsedArtifactCard,
  isFocusedInCanvas,
  isDirty,
  viewMode,
  setViewMode,
  copied,
  copySource,
  setInlineExpanded,
  heightPreset,
  manualHeight,
  htmlHasOverflow,
  selectHeightPreset,
  resetState,
  selectVersion,
  openInCanvas,
}: IntelligentUiHeaderProps) {
  return (
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
  );
}
