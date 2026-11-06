import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  Bot,
  CheckCircle2,
  Circle,
  Clock,
  Download,
  FolderOpen,
  ListChecks,
  Plug,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import type { HostInfoResult, PlanGetResult } from "@pid/protocol";
import { agent } from "../../lib/agent";
import {
  deriveSubagentActivities,
  deriveTaskOutputs,
  deriveTaskPlan,
  summarizeSubagents,
} from "../../lib/envSources";
import { describeError } from "../../lib/errors";
import {
  HARNESS_SESSION_PREFIX,
  harnessRuntimes,
  isHarnessSessionFile,
  isRpcMethodNotFound,
} from "../../lib/harnessRuntime";
import { useAppStore } from "../../store";
import { useWorkbenchStore } from "../../stores/workbenchStore";

export interface TaskSummaryTabProps {
  cwd: string;
  sessionFile: string | null;
}

interface DiagnosticsLogsResult {
  dir: string;
}

interface DiagnosticsExportResult {
  path: string;
  files: string[];
}

export function TaskSummaryTab({ cwd, sessionFile }: TaskSummaryTabProps) {
  const messages = useAppStore((state) => state.messages);
  const stats = useAppStore((state) => state.stats);
  const logs = useAppStore((state) => state.hostLog);
  const summaryFocus = useWorkbenchStore((state) => state.summaryFocus);
  const diagnosticsRef = useRef<HTMLElement>(null);
  const [logFilter, setLogFilter] = useState<"all" | "warn" | "error">("all");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (summaryFocus === "diagnostics") {
      diagnosticsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [summaryFocus]);

  const hostSessionId = sessionFile && isHarnessSessionFile(sessionFile)
    ? sessionFile.slice(HARNESS_SESSION_PREFIX.length)
    : undefined;

  const planQuery = useQuery({
    queryKey: ["workbench-plan", hostSessionId, messages.length],
    queryFn: async (): Promise<PlanGetResult> => {
      try {
        return await harnessRuntimes.call<PlanGetResult>("plan.get", { sessionId: hostSessionId });
      } catch (error) {
        if (isRpcMethodNotFound(error)) return { plan: { explanation: "", items: [] } };
        throw error;
      }
    },
    enabled: Boolean(hostSessionId),
    staleTime: 4_000,
  });

  const usageQuery = useQuery({
    queryKey: ["workbench-usage", messages.length],
    queryFn: () => agent.usageSummary(),
    staleTime: 10_000,
  });

  const mcpQuery = useQuery({
    queryKey: ["workbench-mcp"],
    queryFn: () => agent.mcpStatus(),
    staleTime: 10_000,
  });

  const hostInfoQuery = useQuery({
    queryKey: ["workbench-host-info"],
    queryFn: () => harnessRuntimes.call<HostInfoResult>("host.info"),
    staleTime: 30_000,
  });

  const diagLogsQuery = useQuery({
    queryKey: ["workbench-diag-dir"],
    queryFn: async (): Promise<DiagnosticsLogsResult> => {
      try {
        return await harnessRuntimes.call<DiagnosticsLogsResult>("diagnostics.logs");
      } catch (error) {
        if (isRpcMethodNotFound(error)) return { dir: "" };
        throw error;
      }
    },
    staleTime: 60_000,
  });

  const derivedPlan = deriveTaskPlan(messages);
  const rpcPlan = planQuery.data?.plan;
  const planSteps = (rpcPlan && rpcPlan.items.length > 0)
    ? rpcPlan.items
    : (derivedPlan?.steps ?? []);
  const planExplanation = rpcPlan?.explanation || derivedPlan?.explanation || "";

  const subagents = deriveSubagentActivities(messages);
  const subagentSummary = summarizeSubagents(subagents);
  const outputs = deriveTaskOutputs(messages, 20);

  const filteredLogs = logs.filter((line) => {
    if (logFilter === "all") return true;
    const lower = line.toLowerCase();
    if (logFilter === "error") return lower.includes("error") || lower.includes("失败") || lower.includes("异常");
    return lower.includes("warn") || lower.includes("error") || lower.includes("失败");
  });

  const handleExportDiagnostics = useCallback(async () => {
    const destination = await saveDialog({
      defaultPath: `pi-desktop-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: "ZIP 归档", extensions: ["zip"] }],
    });
    if (!destination) return;
    setExporting(true);
    try {
      const result = await harnessRuntimes.call<DiagnosticsExportResult>("diagnostics.export", {
        path: destination,
        desktop: { cwd, sessionFile, recentLogs: logs.slice(-200) },
      });
      useAppStore.getState().showToast(`已导出诊断包（含 ${result.files.length} 个文件）`, "info");
    } catch (error) {
      useAppStore.getState().showToast(`导出诊断包失败：${describeError(error)}`, "error");
    } finally {
      setExporting(false);
    }
  }, [cwd, logs, sessionFile]);

  const handleReconnectMcp = useCallback(async (serverId?: string) => {
    try {
      await agent.mcpReconnect(serverId);
      await mcpQuery.refetch();
      useAppStore.getState().showToast("已重新连接 MCP 服务", "info");
    } catch (error) {
      useAppStore.getState().showToast(`重连 MCP 失败：${describeError(error)}`, "error");
    }
  }, [mcpQuery]);

  return (
    <div className="pid-wb-pane">
      <div className="pid-wb-scroll pid-wb-summary-scroll">
        {/* 1. Task Plan */}
        <section className="pid-wb-card">
          <header className="pid-wb-card-header">
            <div className="pid-wb-card-title">
              <ListChecks size={14} />
              <span>任务计划</span>
            </div>
            {planSteps.length > 0 && (
              <span className="pid-wb-badge">
                {planSteps.filter((step) => step.status === "completed").length}/{planSteps.length}
              </span>
            )}
          </header>
          {planExplanation && <p className="pid-wb-card-desc">{planExplanation}</p>}
          {planSteps.length === 0 ? (
            <div className="pid-wb-card-empty">当前会话尚未创建结构化计划。</div>
          ) : (
            <ul className="pid-wb-plan-list">
              {planSteps.map((step) => (
                <li key={step.id} className={`pid-wb-plan-item status-${step.status}`}>
                  {step.status === "completed" ? (
                    <CheckCircle2 size={14} className="pid-wb-plan-icon done" />
                  ) : step.status === "in_progress" ? (
                    <Clock size={14} className="pid-wb-plan-icon active" />
                  ) : (
                    <Circle size={14} className="pid-wb-plan-icon" />
                  )}
                  <span>{step.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 2. Subagent Status Cards */}
        <section className="pid-wb-card">
          <header className="pid-wb-card-header">
            <div className="pid-wb-card-title">
              <Bot size={14} />
              <span>子代理协作</span>
            </div>
            {subagentSummary.total > 0 && (
              <span className="pid-wb-badge">
                运行 {subagentSummary.running} · 完成 {subagentSummary.completed}
                {subagentSummary.failed > 0 ? ` · 失败 ${subagentSummary.failed}` : ""}
              </span>
            )}
          </header>
          {subagents.length === 0 ? (
            <div className="pid-wb-card-empty">当前任务未派发子代理。</div>
          ) : (
            <div className="pid-wb-subagent-list">
              {subagents.map((item) => (
                <div key={item.id} className={`pid-wb-subagent-card status-${item.status}`}>
                  <div className="pid-wb-subagent-top">
                    <strong>{item.label}</strong>
                    <span className="pid-wb-badge">{item.role}</span>
                    <span className={`pid-wb-status-pill ${item.status}`}>
                      {item.status === "running"
                        ? "运行中"
                        : item.status === "completed"
                          ? "已完成"
                          : item.status === "failed"
                            ? "失败"
                            : "排队中"}
                    </span>
                  </div>
                  <p className="pid-wb-subagent-task">{item.task}</p>
                  {item.error && <p className="pid-wb-subagent-error">{item.error}</p>}
                  {item.output && !item.error && (
                    <p className="pid-wb-subagent-output">{item.output.slice(0, 220)}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 3. Written Files */}
        {outputs.length > 0 && (
          <section className="pid-wb-card">
            <header className="pid-wb-card-header">
              <div className="pid-wb-card-title">
                <Activity size={14} />
                <span>本轮产出文件 ({outputs.length})</span>
              </div>
            </header>
            <ul className="pid-wb-output-list">
              {outputs.map((output) => (
                <li key={output.id}>
                  <button
                    type="button"
                    className="pid-wb-output-btn"
                    onClick={() => {
                      if (cwd) void useWorkbenchStore.getState().openFile(cwd, output.path);
                    }}
                  >
                    <span>{output.path}</span>
                    <span className="pid-wb-muted">{output.activity === "written" ? "写入" : "修改"} ×{output.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 4. Token Usage & Cost */}
        <section className="pid-wb-card">
          <header className="pid-wb-card-header">
            <div className="pid-wb-card-title">
              <Activity size={14} />
              <span>用量统计</span>
            </div>
            <button
              type="button"
              className="pid-wb-icon-btn"
              title="刷新用量"
              onClick={() => void usageQuery.refetch()}
            >
              <RefreshCw size={12} />
            </button>
          </header>
          <div className="pid-wb-kv-grid">
            <div>
              <span className="pid-wb-kv-label">当前会话 Token</span>
              <strong>{(stats?.tokens.total ?? 0).toLocaleString()}</strong>
            </div>
            <div>
              <span className="pid-wb-kv-label">当前会话估算费用</span>
              <strong>${(stats?.cost ?? 0).toFixed(4)}</strong>
            </div>
            <div>
              <span className="pid-wb-kv-label">累计总会话 / Token</span>
              <strong>
                {usageQuery.data?.sessions ?? 0} / {(usageQuery.data?.totalTokens ?? 0).toLocaleString()}
              </strong>
            </div>
            <div>
              <span className="pid-wb-kv-label">累计估算费用</span>
              <strong>${(usageQuery.data?.totalCost ?? 0).toFixed(4)}</strong>
            </div>
          </div>
        </section>

        {/* 5. MCP Servers */}
        <section className="pid-wb-card">
          <header className="pid-wb-card-header">
            <div className="pid-wb-card-title">
              <Plug size={14} />
              <span>MCP 服务</span>
            </div>
            <button
              type="button"
              className="pid-wb-icon-btn"
              title="重连全部 MCP 服务"
              onClick={() => void handleReconnectMcp()}
            >
              <RefreshCw size={12} />
            </button>
          </header>
          {(mcpQuery.data?.length ?? 0) === 0 ? (
            <div className="pid-wb-card-empty">暂未配置启用的 MCP 服务。</div>
          ) : (
            <ul className="pid-wb-mcp-list">
              {(mcpQuery.data ?? []).map((server) => (
                <li key={server.id} className="pid-wb-mcp-row">
                  <div>
                    <strong>{server.name}</strong>
                    <span className="pid-wb-muted"> ({server.transport} · {server.toolCount} 工具)</span>
                    {server.error && <div className="pid-wb-subagent-error">{server.error}</div>}
                  </div>
                  <span className={`pid-wb-status-pill ${server.connected ? "completed" : "failed"}`}>
                    {server.connected ? "已连接" : "断开"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 6. Host Diagnostics & Logs */}
        <section ref={diagnosticsRef} className="pid-wb-card" data-diagnostics-section>
          <header className="pid-wb-card-header">
            <div className="pid-wb-card-title">
              <TerminalSquare size={14} />
              <span>宿主诊断与日志</span>
            </div>
            <div className="pid-wb-subbar-actions">
              {diagLogsQuery.data?.dir && (
                <button
                  type="button"
                  className="pid-wb-icon-btn"
                  title={`打开日志目录：${diagLogsQuery.data.dir}`}
                  onClick={() => void agent.openWorkspaceInFileManager(diagLogsQuery.data?.dir ?? "")}
                >
                  <FolderOpen size={12} />
                </button>
              )}
              <button
                type="button"
                className="pid-wb-btn small"
                disabled={exporting}
                onClick={() => void handleExportDiagnostics()}
              >
                <Download size={12} />
                <span>{exporting ? "导出中…" : "导出诊断包"}</span>
              </button>
            </div>
          </header>
          {hostInfoQuery.data && (
            <div className="pid-wb-meta-strip">
              <span>Host v{hostInfoQuery.data.version}</span>
              <span className="pid-wb-muted">协议 v{hostInfoQuery.data.protocolVersion}</span>
            </div>
          )}
          <div className="pid-wb-filter-pills">
            <button
              type="button"
              className={`pid-wb-pill${logFilter === "all" ? " active" : ""}`}
              onClick={() => setLogFilter("all")}
            >
              全部 ({logs.length})
            </button>
            <button
              type="button"
              className={`pid-wb-pill${logFilter === "warn" ? " active" : ""}`}
              onClick={() => setLogFilter("warn")}
            >
              警告/错误
            </button>
            <button
              type="button"
              className={`pid-wb-pill${logFilter === "error" ? " active" : ""}`}
              onClick={() => setLogFilter("error")}
            >
              仅错误
            </button>
          </div>
          {filteredLogs.length === 0 ? (
            <div className="pid-wb-card-empty">暂无匹配的运行日志记录。</div>
          ) : (
            <pre className="pid-wb-log-box">
              {filteredLogs.slice(-120).join("\n")}
            </pre>
          )}
        </section>
      </div>
    </div>
  );
}
