import { useEffect, useMemo, useRef, useState } from "react";
import { Layers, Maximize2, SlidersHorizontal, Sparkles, Terminal } from "lucide-react";
import { deriveSessionIntelligentUis, INTELLIGENT_UI_CANVAS_TAB_ID } from "../lib/intelligentUi";
import { groupTranscriptMessages } from "../lib/transcriptTurns";
import { useAppStore } from "../store";
import { useWorkbenchStore } from "../stores/workbenchStore";

const QUICK_PROMPTS = [
  {
    label: "插入 /ui 指令",
    hint: "自定义交互组件",
    text: "/ui ",
    icon: Terminal,
  },
  {
    label: "参数计算与模拟器",
    hint: "滑块 + 实时指标",
    text: "/ui 帮我针对当前讨论做一个可拖动滑块调节参数的实时计算器与趋势图",
    icon: SlidersHorizontal,
  },
  {
    label: "方案对比交互看板",
    hint: "图表 + 可排序表",
    text: "/ui 帮我把不同方案整理成可筛选、可排序且带可视化对比图的交互看板",
    icon: Sparkles,
  },
] as const;

export function IntelligentUiComposerAction() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const messages = useAppStore((state) => state.messages);

  const widgetCount = useMemo(() => {
    if (messages.length === 0) return 0;
    return deriveSessionIntelligentUis(groupTranscriptMessages(messages)).orderedGroups.length;
  }, [messages]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && wrapRef.current && !wrapRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className="pi-iui-composer-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`chip pi-iui-composer-chip${open ? " active" : ""}`}
        onClick={() => setOpen((prev) => !prev)}
        title="Intelligent UI：生成交互式组件或打开画布"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Layers size={13} strokeWidth={1.75} />
        <span>交互组件</span>
        {widgetCount > 0 && <em className="pi-iui-composer-count">{widgetCount}</em>}
      </button>

      {open && (
        <div className="pi-iui-composer-menu" role="menu" aria-label="Intelligent UI 快捷操作">
          <div className="pi-iui-composer-menu-head">Intelligent UI</div>
          {QUICK_PROMPTS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className="pi-iui-composer-menu-item"
                onClick={() => {
                  setOpen(false);
                  useAppStore.setState({ composerPrefill: item.text });
                }}
              >
                <Icon size={13} strokeWidth={1.8} />
                <span className="pi-iui-composer-menu-label">{item.label}</span>
                <small>{item.hint}</small>
              </button>
            );
          })}

          <div className="pi-iui-composer-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="pi-iui-composer-menu-item"
            onClick={() => {
              setOpen(false);
              useWorkbenchStore.getState().openTab(INTELLIGENT_UI_CANVAS_TAB_ID);
            }}
          >
            <Maximize2 size={13} strokeWidth={1.8} />
            <span className="pi-iui-composer-menu-label">打开右侧交互画布</span>
            {widgetCount > 0 && <small>{widgetCount} 个组件</small>}
          </button>
        </div>
      )}
    </div>
  );
}
