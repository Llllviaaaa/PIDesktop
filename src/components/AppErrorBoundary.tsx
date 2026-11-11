import { Component, type ErrorInfo, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle, Minus, RefreshCw, RotateCcw, Square, X } from "lucide-react";
import { extractErrorDetails, reportFrontendError } from "../lib/crashLogger";

interface AppErrorBoundaryProps {
  children: ReactNode;
  onReportError?: (error: Error, componentStack?: string) => void;
}

interface AppErrorBoundaryState {
  error: Error | null;
  componentStack: string;
}

function safeCurrentWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = {
    error: null,
    componentStack: "",
  };

  static getDerivedStateFromError(error: unknown): Partial<AppErrorBoundaryState> {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return { error: normalized };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? "";
    this.setState({ componentStack });
    console.error("[AppErrorBoundary] Renderer caught fatal UI error:", error);
    if (this.props.onReportError) {
      this.props.onReportError(error, componentStack || undefined);
    } else {
      void reportFrontendError("react.error_boundary", error, {
        ...(componentStack ? { extraStack: componentStack } : {}),
      });
    }
  }

  private readonly handleRetry = (): void => {
    this.setState({ error: null, componentStack: "" });
  };

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) {
      return this.props.children;
    }

    const details = extractErrorDetails(error, componentStack || undefined);
    const appWindow = safeCurrentWindow();

    return (
      <div
        className="app-shell codex-shot"
        role="alert"
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "var(--app, #14161e)",
          color: "var(--text, #dce0ea)",
        }}
      >
        <header
          className="window-menubar"
          data-tauri-drag-region
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            height: 36,
            paddingLeft: 14,
            paddingRight: 132,
            borderBottom: "1px solid var(--border, #2a2d38)",
            userSelect: "none",
          }}
        >
          <span style={{ fontSize: 12, color: "var(--text-2, #8a90a0)", fontWeight: 500 }}>
            千机 — 界面异常恢复
          </span>
          <div className="window-controls" style={{ height: 36 }}>
            <button
              type="button"
              className="window-control"
              style={{ height: 36 }}
              onClick={() => void appWindow?.minimize()}
              title="最小化"
              aria-label="最小化窗口"
            >
              <Minus size={15} strokeWidth={1.6} />
            </button>
            <button
              type="button"
              className="window-control"
              style={{ height: 36 }}
              onClick={() => void appWindow?.toggleMaximize()}
              title="最大化或还原"
              aria-label="最大化或还原窗口"
            >
              <Square size={12} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              className="window-control close"
              style={{ height: 36 }}
              onClick={() => void appWindow?.close()}
              title="关闭"
              aria-label="关闭窗口"
            >
              <X size={15} strokeWidth={1.6} />
            </button>
          </div>
        </header>

        <main
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            overflowY: "auto",
          }}
        >
          <div
            style={{
              width: "min(620px, 100%)",
              padding: 24,
              borderRadius: 16,
              border: "1px solid var(--border, #2a2d38)",
              background: "var(--panel, #1a1c24)",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <AlertTriangle size={20} style={{ color: "var(--red, #dc2626)", flexShrink: 0 }} />
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
                界面渲染遇到未预期错误
              </h2>
            </div>

            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--text-2, #8a90a0)" }}>
              后台 Harness Host 与会话数据仍受保护，错误详情已脱敏写入本地诊断日志（
              <code>~/.qianji/logs/desktop-*.log</code>）。你可以先尝试恢复当前界面，或重新加载窗口。
            </p>

            <div
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                background: "var(--panel-soft, #1e2028)",
                border: "1px solid var(--border, #2a2d38)",
                fontFamily: "var(--code-font, monospace)",
                fontSize: 12,
                lineHeight: 1.5,
                wordBreak: "break-word",
                maxHeight: 200,
                overflowY: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {details.message}
              {details.stack ? `\n\n${details.stack}` : ""}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={this.handleRetry}
                style={{
                  height: 34,
                  padding: "0 14px",
                  borderRadius: 9,
                  border: "1px solid var(--border-strong, #3a3e4b)",
                  background: "var(--panel-strong, #262831)",
                  color: "var(--text, #dce0ea)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                <RotateCcw size={14} />
                尝试恢复界面
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                style={{
                  height: 34,
                  padding: "0 14px",
                  borderRadius: 9,
                  border: 0,
                  background: "var(--accent, #6366f1)",
                  color: "var(--accent-text, #ffffff)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                <RefreshCw size={14} />
                重新加载窗口
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }
}
