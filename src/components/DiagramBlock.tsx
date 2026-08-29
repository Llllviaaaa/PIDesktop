import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DOMPurify from "dompurify";
import { Check, Code2, Copy, Download, Eye, LoaderCircle, Maximize2, Minus, Plus, RotateCcw, TriangleAlert, X } from "lucide-react";

export type DiagramKind = "mermaid" | "plantuml";

interface DiagramState {
  status: "loading" | "ready" | "error";
  svg: string;
  error: string;
}

let diagramSequence = 0;
let mermaidQueue: Promise<void> = Promise.resolve();
let plantUmlQueue: Promise<void> = Promise.resolve();
let vizLoader: Promise<void> | null = null;
let plantUmlLoader: Promise<typeof import("@plantuml/core")> | null = null;

export function diagramKindForLanguage(language: string): DiagramKind | null {
  const normalized = language.trim().toLowerCase();
  if (normalized === "mermaid") return "mermaid";
  if (normalized === "plantuml" || normalized === "puml" || normalized === "uml") return "plantuml";
  return null;
}

function darkThemeActive(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
}

function sanitizePlantUmlSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
  });
}

function downloadDiagramSvg(kind: DiagramKind, svg: string): void {
  const portableSvg = /<svg\b[^>]*\bxmlns=/.test(svg)
    ? svg
    : svg.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  const blob = new Blob([portableSvg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `pidesktop-${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.svg`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function renderMermaid(source: string, dark: boolean): Promise<string> {
  let rendered = "";
  const task = mermaidQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: dark ? "dark" : "default",
      flowchart: { htmlLabels: false },
    });
    const result = await mermaid.render(`pidesktop-diagram-${++diagramSequence}`, source);
    rendered = result.svg;
  });
  mermaidQueue = task.catch(() => undefined);
  await task;
  return rendered;
}

function loadVizGlobal(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("图形渲染仅支持桌面页面"));
  if ((window as Window & { Viz?: unknown }).Viz) return Promise.resolve();
  if (vizLoader) return vizLoader;
  vizLoader = import("@plantuml/core/viz-global.js?url").then(({ default: vizGlobalUrl }) => (
    new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>("script[data-pidesktop-plantuml-viz]");
      const script = existing ?? document.createElement("script");
      const loaded = () => resolve();
      const failed = () => reject(new Error("PlantUML 布局引擎加载失败"));
      script.addEventListener("load", loaded, { once: true });
      script.addEventListener("error", failed, { once: true });
      if (!existing) {
        script.src = vizGlobalUrl;
        script.dataset.pidesktopPlantumlViz = "true";
        document.head.appendChild(script);
      }
    })
  ));
  return vizLoader;
}

async function renderPlantUmlNow(source: string, dark: boolean): Promise<string> {
  await loadVizGlobal();
  plantUmlLoader ??= import("@plantuml/core");
  const { render } = await plantUmlLoader;
  const normalized = /^\s*@start\w+/mi.test(source)
    ? source
    : `@startuml\n${source}\n@enduml`;
  return new Promise((resolve, reject) => {
    const target = document.createElement("div");
    target.id = `pidesktop-plantuml-${++diagramSequence}`;
    target.style.cssText = "position:absolute;left:-100000px;top:0;width:1px;height:1px;overflow:hidden";
    document.body.appendChild(target);
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      observer.disconnect();
      target.remove();
    };
    const observer = new MutationObserver(() => {
      const svg = target.querySelector("svg");
      if (!svg) return;
      const markup = svg.outerHTML;
      cleanup();
      resolve(markup);
    });
    observer.observe(target, { childList: true, subtree: true });
    timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("PlantUML 渲染超时"));
    }, 20_000);
    try {
      render(normalized.split(/\r\n|\r|\n/), target.id, { dark });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function renderPlantUml(source: string, dark: boolean): Promise<string> {
  let rendered = "";
  const task = plantUmlQueue.then(async () => {
    rendered = await renderPlantUmlNow(source, dark);
  });
  plantUmlQueue = task.catch(() => undefined);
  await task;
  return rendered;
}

export function DiagramBlock({ kind, source }: { kind: DiagramKind; source: string }) {
  const [dark, setDark] = useState(darkThemeActive);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [state, setState] = useState<DiagramState>({ status: "loading", svg: "", error: "" });
  const lightboxViewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(darkThemeActive()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", svg: "", error: "" });
    const renderer = kind === "mermaid" ? renderMermaid(source, dark) : renderPlantUml(source, dark);
    void renderer.then((svg) => {
      if (!cancelled) {
        setState({
          status: "ready",
          svg: kind === "mermaid" ? svg : sanitizePlantUmlSvg(svg),
          error: "",
        });
      }
    }).catch((error) => {
      if (!cancelled) {
        setState({
          status: "error",
          svg: "",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dark, kind, source]);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = lightboxViewportRef.current;
      if (!viewport) return;
      viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
      viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, zoom]);

  const label = kind === "mermaid" ? "Mermaid" : "PlantUML";
  const sourceVisible = showSource || state.status === "error";
  const openExpanded = () => {
    setZoom(1);
    setExpanded(true);
  };
  const zoomOut = () => setZoom((current) => Math.max(0.5, current - 0.25));
  const zoomIn = () => setZoom((current) => Math.min(3, current + 0.25));
  const saveSvg = () => {
    if (!state.svg) return;
    downloadDiagramSvg(kind, state.svg);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  return (
    <section className={`diagram-block diagram-${kind}`} aria-label={`${label} 图形`}>
      <div className="diagram-toolbar">
        <span>{label}</span>
        <div>
          <button
            type="button"
            title="查看大图"
            aria-label={`查看 ${label} 大图`}
            disabled={state.status !== "ready"}
            onClick={openExpanded}
          >
            <Maximize2 size={14} />
          </button>
          <button
            type="button"
            title={saved ? "已保存" : "保存为 SVG"}
            aria-label={saved ? `${label} 已保存` : `保存 ${label} 为 SVG`}
            disabled={state.status !== "ready"}
            onClick={saveSvg}
          >
            {saved ? <Check size={14} /> : <Download size={14} />}
          </button>
          <button
            type="button"
            title={sourceVisible && state.status !== "error" ? "查看图形" : "查看源码"}
            aria-label={sourceVisible && state.status !== "error" ? "查看图形" : "查看源码"}
            disabled={state.status === "error"}
            onClick={() => setShowSource((visible) => !visible)}
          >
            {sourceVisible && state.status !== "error" ? <Eye size={14} /> : <Code2 size={14} />}
          </button>
          <button
            type="button"
            title={copied ? "已复制" : "复制源码"}
            aria-label={copied ? "已复制" : "复制源码"}
            onClick={() => {
              void navigator.clipboard.writeText(source).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              }).catch(() => undefined);
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>
      {state.status === "loading" && (
        <div className="diagram-status" role="status">
          <LoaderCircle className="spin" size={16} />
          <span>正在渲染...</span>
        </div>
      )}
      {state.status === "error" && (
        <div className="diagram-status error" role="alert">
          <TriangleAlert size={16} />
          <span>{state.error}</span>
        </div>
      )}
      {state.status === "ready" && !sourceVisible && (
        <div className="diagram-render" title="双击查看大图" onDoubleClick={openExpanded} dangerouslySetInnerHTML={{ __html: state.svg }} />
      )}
      {sourceVisible && <pre className="diagram-source"><code>{source}</code></pre>}
      {expanded && state.status === "ready" && createPortal(
        <div className="diagram-lightbox" role="presentation" onMouseDown={() => setExpanded(false)}>
          <section
            className="diagram-lightbox-panel"
            role="dialog"
            aria-modal="true"
            aria-label={`${label} 大图`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="diagram-lightbox-header">
              <strong>{label}</strong>
              <div className="diagram-lightbox-actions">
                <div className="diagram-zoom-controls" role="group" aria-label="图形缩放">
                  <button type="button" title="缩小" aria-label="缩小图形" disabled={zoom <= 0.5} onClick={zoomOut}>
                    <Minus size={16} />
                  </button>
                  <span className="diagram-zoom-value" aria-label={`当前缩放比例 ${Math.round(zoom * 100)}%`}>
                    {Math.round(zoom * 100)}%
                  </span>
                  <button type="button" title="放大" aria-label="放大图形" disabled={zoom >= 3} onClick={zoomIn}>
                    <Plus size={16} />
                  </button>
                  <button type="button" title="适应窗口" aria-label="恢复适应窗口" disabled={zoom === 1} onClick={() => setZoom(1)}>
                    <RotateCcw size={15} />
                  </button>
                </div>
                <button type="button" title="保存为 SVG" aria-label={`保存 ${label} 为 SVG`} onClick={saveSvg}>
                  {saved ? <Check size={16} /> : <Download size={16} />}
                </button>
                <button type="button" title="关闭大图" aria-label="关闭大图" autoFocus onClick={() => setExpanded(false)}>
                  <X size={17} />
                </button>
              </div>
            </header>
            <div ref={lightboxViewportRef} className="diagram-lightbox-viewport">
              <div
                className="diagram-lightbox-render"
                style={{ width: `${Math.max(1, zoom) * 100}%`, height: `${Math.max(1, zoom) * 100}%` }}
              >
                <div
                  className="diagram-lightbox-image"
                  style={{ width: `${Math.min(1, zoom) * 100}%`, height: `${Math.min(1, zoom) * 100}%` }}
                  dangerouslySetInnerHTML={{ __html: state.svg }}
                />
              </div>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </section>
  );
}
