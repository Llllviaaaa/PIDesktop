import { useMemo } from "react";
import { Download, Layers, Sparkles } from "lucide-react";
import { buildSandboxedWidgetHtml, deriveSessionIntelligentUis, serializeWidgetSource } from "../../lib/intelligentUi";
import { groupTranscriptMessages } from "../../lib/transcriptTurns";
import { showToast } from "../../notifications";
import { useAppStore } from "../../store";
import { useIntelligentUiStore } from "../../stores/intelligentUiStore";
import { IntelligentUiCard } from "../IntelligentUiCard";

const CANVAS_STARTERS = [
  {
    title: "复利与定投收益模拟器",
    desc: "滑块调节本金、年化与年限，实时计算收益曲线",
    prompt: "/ui 做一个复利与月定投收益模拟器，支持滑块调节初始本金、每月定投额、预期年化收益率与投资年限，展示关键指标卡片与增长趋势图，并支持一键把当前配置回传对话。",
  },
  {
    title: "服务架构延迟与成本看板",
    desc: "多指标对比柱状图、可排序表格与流量估算",
    prompt: "/ui 做一个 API 架构方案对比看板（单体 / 微服务 / Serverless），支持拖动日均请求量滑块实时重算月度成本、P99 延迟对比图与可筛选对比表。",
  },
  {
    title: "阻尼弹簧振子物理沙箱",
    desc: "独立 HTML Canvas 实时动画与参数控制",
    prompt: "/ui 使用 html 引擎做一个交互式阻尼简谐振动物理演示，包含 Canvas 实时动画与刚度系数、阻尼比滑块控制。",
  },
] as const;

export function IntelligentUiCanvasTab() {
  const messages = useAppStore((state) => state.messages);
  const selectedWidgetId = useIntelligentUiStore((state) => state.selectedWidgetId);
  const selectedVersionById = useIntelligentUiStore((state) => state.selectedVersionById);
  const setSelectedWidgetId = useIntelligentUiStore((state) => state.setSelectedWidgetId);

  const summary = useMemo(() => {
    const grouped = groupTranscriptMessages(messages);
    return deriveSessionIntelligentUis(grouped);
  }, [messages]);

  const activeGroup = useMemo(() => {
    if (summary.orderedGroups.length === 0) return null;
    if (selectedWidgetId) {
      const matched = summary.groupsById.get(selectedWidgetId);
      if (matched) return matched;
    }
    return summary.orderedGroups.at(-1) ?? null;
  }, [selectedWidgetId, summary]);

  if (!activeGroup) {
    return (
      <div className="pi-iui-canvas-empty">
        <div className="pi-iui-canvas-empty-hero">
          <span className="pi-iui-canvas-empty-icon" aria-hidden="true">
            <Layers size={18} strokeWidth={1.7} />
          </span>
          <h3>交互画布</h3>
          <p>
            对话中由 <code>render_ui</code> 生成的交互式计算器、可视化图表与 HTML 沙箱会在此集中固定展示，支持版本回溯与源码导出。
          </p>
        </div>

        <div className="pi-iui-canvas-starters">
          <span className="pi-iui-canvas-starters-heading">快速填入示例指令</span>
          {CANVAS_STARTERS.map((starter) => (
            <button
              key={starter.title}
              type="button"
              className="pi-iui-starter-card"
              onClick={() => {
                useAppStore.setState({ composerPrefill: starter.prompt });
                showToast("已填入输入框，按回车即可生成交互组件", "info");
              }}
            >
              <div className="pi-iui-starter-title-row">
                <Sparkles size={13} strokeWidth={1.8} />
                <strong>{starter.title}</strong>
              </div>
              <span>{starter.desc}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const activeVerNum = selectedVersionById[activeGroup.id] ?? activeGroup.latest.version;
  const activeArtifact =
    activeGroup.versions.find((item) => item.version === activeVerNum) ?? activeGroup.latest;

  const handleDownload = () => {
    const isDark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
    const isHtml = activeArtifact.engine === "html";
    const content = isHtml
      ? buildSandboxedWidgetHtml({
          html: activeArtifact.html ?? "",
          widgetId: activeArtifact.id,
          title: activeArtifact.title,
          isDark,
        })
      : serializeWidgetSource(activeArtifact);
    const ext = isHtml ? "html" : "json";
    const mime = isHtml ? "text/html;charset=utf-8" : "application/json;charset=utf-8";
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeArtifact.id}-v${activeArtifact.version}.${ext}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${activeArtifact.id}-v${activeArtifact.version}.${ext}`, "info");
  };

  return (
    <div className="pi-iui-canvas-pane">
      <div className="pi-iui-canvas-topbar">
        <div className="pi-iui-canvas-switcher" role="tablist" aria-label="会话组件列表">
          {summary.orderedGroups.map((grp) => {
            const isSelected = grp.id === activeGroup.id;
            return (
              <button
                key={grp.id}
                type="button"
                role="tab"
                aria-selected={isSelected}
                className={`pi-iui-canvas-pill${isSelected ? " is-active" : ""}`}
                onClick={() => setSelectedWidgetId(grp.id)}
              >
                <span className="pi-iui-canvas-pill-title">{grp.latest.title}</span>
                <small>v{grp.latest.version}</small>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className="pi-iui-canvas-export-btn"
          onClick={handleDownload}
          title={activeArtifact.engine === "html" ? "导出独立 HTML 文件" : "导出组件 JSON 定义"}
        >
          <Download size={12} strokeWidth={1.8} />
          <span>导出</span>
        </button>
      </div>

      <div className="pi-iui-canvas-scroll">
        <IntelligentUiCard group={activeGroup} mode="canvas" />
      </div>
    </div>
  );
}
