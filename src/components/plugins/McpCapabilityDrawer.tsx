import { useState } from "react";
import type { McpServerStatus } from "@qianji/protocol";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AppSettings, McpServerConfig } from "../../types";
import {
  MCP_PRESET_TEMPLATES,
  parseKeyValuePairs,
  parseShellArgLine,
  type McpPresetTemplate,
  type Notice,
} from "./pluginHelpers";

export interface McpCapabilityDrawerProps {
  cwd: string;
  form: AppSettings;
  onSyncAppSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  mcpStatuses: readonly McpServerStatus[];
  mcpReconnecting: boolean;
  onReconnectMcp: (serverId?: string) => void;
  onMcpServersUpdated: () => void;
  onNotify: (notice: Notice) => void;
}

export function McpCapabilityDrawer({
  cwd,
  form,
  onSyncAppSetting,
  mcpStatuses,
  mcpReconnecting,
  onReconnectMcp,
  onMcpServersUpdated,
  onNotify,
}: McpCapabilityDrawerProps) {
  const [mcpTransport, setMcpTransport] = useState<"stdio" | "http">("stdio");
  const [mcpName, setMcpName] = useState("");
  const [mcpCmdLine, setMcpCmdLine] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpEnvLine, setMcpEnvLine] = useState("");
  const [mcpReadOnly, setMcpReadOnly] = useState(false);

  const servers = form.mcpServers ?? [];
  const statusMap = new Map(mcpStatuses.map((s) => [s.id, s]));

  const addMcpServer = (server: McpServerConfig) => {
    const next = [...servers.filter((item) => item.id !== server.id), server];
    onSyncAppSetting("mcpServers", next);
    onMcpServersUpdated();
    onNotify({ kind: "success", text: `已添加 MCP 服务 "${server.name}"，正在自动连接…` });
  };

  const handleAddPreset = (preset: McpPresetTemplate) => {
    if (servers.some((s) => s.id === preset.id)) return;
    addMcpServer({
      id: preset.id,
      name: preset.name,
      enabled: true,
      transport: "stdio",
      command: preset.command,
      args: preset.buildArgs(cwd),
      cwd: cwd.trim(),
      env: {},
      inheritEnvironment: true,
      url: "",
      headers: {},
      trustedReadOnly: preset.trustedReadOnly ?? false,
    });
  };

  const handleAddCustomMcp = () => {
    const cleanName = mcpName.trim();
    if (mcpTransport === "stdio") {
      const tokens = parseShellArgLine(mcpCmdLine.trim());
      if (tokens.length === 0) {
        onNotify({ kind: "error", text: "请填写 STDIO 启动命令（例如 npx -y @playwright/mcp@latest）。" });
        return;
      }
      const [command, ...args] = tokens;
      const baseId = (cleanName || command).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "mcp";
      const uniqueId = servers.some((s) => s.id === baseId) ? `${baseId}-${Date.now().toString(36).slice(-4)}` : baseId;
      addMcpServer({
        id: uniqueId,
        name: cleanName || command,
        enabled: true,
        transport: "stdio",
        command,
        args,
        cwd: cwd.trim(),
        env: parseKeyValuePairs(mcpEnvLine),
        inheritEnvironment: true,
        url: "",
        headers: {},
        trustedReadOnly: mcpReadOnly,
      });
      setMcpName("");
      setMcpCmdLine("");
      setMcpEnvLine("");
      setMcpReadOnly(false);
      return;
    }

    const trimmedUrl = mcpUrl.trim();
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      onNotify({ kind: "error", text: "请填写以 http:// 或 https:// 开头的远程 MCP 地址。" });
      return;
    }
    const hostFallback = (() => {
      try {
        return new URL(trimmedUrl).hostname;
      } catch {
        return "remote-mcp";
      }
    })();
    const baseId = (cleanName || hostFallback).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "http-mcp";
    const uniqueId = servers.some((s) => s.id === baseId) ? `${baseId}-${Date.now().toString(36).slice(-4)}` : baseId;
    addMcpServer({
      id: uniqueId,
      name: cleanName || hostFallback,
      enabled: true,
      transport: "http",
      command: "",
      args: [],
      cwd: "",
      env: {},
      inheritEnvironment: false,
      url: trimmedUrl,
      headers: parseKeyValuePairs(mcpEnvLine),
      trustedReadOnly: mcpReadOnly,
    });
    setMcpName("");
    setMcpUrl("");
    setMcpEnvLine("");
    setMcpReadOnly(false);
  };

  return (
    <div className="plugin-mcp-hub">
      <div className="plugin-mcp-topbar">
        <div className="plugin-structured-copy">
          <strong>工具调用安全确认</strong>
          <small>开启后，非只读 MCP 工具在首次执行副作用操作前会请求你的批准</small>
        </div>
        <div className="plugin-structured-control">
          <button
            type="button"
            role="switch"
            aria-checked={form.mcpConfirmTools}
            aria-label="MCP 工具调用前确认"
            className={`settings-switch ${form.mcpConfirmTools ? "on" : ""}`}
            onClick={() => onSyncAppSetting("mcpConfirmTools", !form.mcpConfirmTools)}
          >
            <span />
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={mcpReconnecting || servers.length === 0}
            onClick={() => onReconnectMcp(undefined)}
          >
            <RefreshCw size={12.5} />
            <span>重连全部</span>
          </button>
        </div>
      </div>

      {servers.length > 0 && (
        <div className="plugin-mcp-server-list">
          {servers.map((srv) => {
            const st = statusMap.get(srv.id);
            const cmdSummary = srv.transport === "http" ? srv.url : [srv.command, ...srv.args].join(" ");
            return (
              <div key={srv.id} className="plugin-mcp-server-item">
                <div className="plugin-mcp-server-main">
                  <div className="plugin-mcp-server-title">
                    <strong>{srv.name || srv.id}</strong>
                    <span className="plugin-quiet-pill">{srv.transport.toUpperCase()}</span>
                    {srv.trustedReadOnly && <span className="plugin-quiet-pill">只读免确认</span>}
                    {!srv.enabled ? (
                      <span className="plugin-op-chip">已停用</span>
                    ) : st?.connected ? (
                      <span className="plugin-op-chip tone-green">已连接 · {st.toolCount} 个工具</span>
                    ) : st?.error ? (
                      <span className="plugin-op-chip tone-warn" title={st.error}>连接失败：{st.error.slice(0, 38)}</span>
                    ) : (
                      <span className="plugin-op-chip">待连接</span>
                    )}
                  </div>
                  <div className="plugin-mcp-server-cmd" title={cmdSummary}>{cmdSummary}</div>
                </div>

                <div className="plugin-mcp-server-actions">
                  <button
                    type="button"
                    className="plugin-ghost-btn icon-only"
                    title="重新连接该服务"
                    aria-label={`重新连接 ${srv.name || srv.id}`}
                    disabled={mcpReconnecting || !srv.enabled}
                    onClick={() => onReconnectMcp(srv.id)}
                  >
                    <RefreshCw size={12.5} />
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={srv.enabled}
                    aria-label={`${srv.enabled ? "停用" : "启用"} MCP ${srv.name || srv.id}`}
                    className={`settings-switch ${srv.enabled ? "on" : ""}`}
                    onClick={() => {
                      const next = servers.map((item) => (
                        item.id === srv.id ? { ...item, enabled: !item.enabled } : item
                      ));
                      onSyncAppSetting("mcpServers", next);
                      onMcpServersUpdated();
                    }}
                  >
                    <span />
                  </button>
                  <button
                    type="button"
                    className="plugin-ghost-btn danger icon-only"
                    title="移除该 MCP 服务"
                    aria-label={`移除 ${srv.name || srv.id}`}
                    onClick={() => {
                      onSyncAppSetting("mcpServers", servers.filter((item) => item.id !== srv.id));
                      onMcpServersUpdated();
                    }}
                  >
                    <Trash2 size={12.5} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="plugin-mcp-templates">
        <span className="plugin-mcp-section-label">一键挂载官方常用连接器</span>
        <div className="plugin-mcp-template-row">
          {MCP_PRESET_TEMPLATES.map((preset) => {
            const exists = servers.some((s) => s.id === preset.id);
            return (
              <button
                key={preset.id}
                type="button"
                className="plugin-mcp-template-pill"
                disabled={exists}
                onClick={() => handleAddPreset(preset)}
              >
                <span>{exists ? `✓ ${preset.name}` : preset.badge}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="plugin-mcp-add-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span className="plugin-mcp-section-label">添加自定义 MCP 服务</span>
          <div className="settings-segmented">
            <button
              type="button"
              className={mcpTransport === "stdio" ? "active" : ""}
              onClick={() => setMcpTransport("stdio")}
            >
              {mcpTransport === "stdio" && <span className="settings-segmented-thumb" />}
              <span>STDIO 命令行</span>
            </button>
            <button
              type="button"
              className={mcpTransport === "http" ? "active" : ""}
              onClick={() => setMcpTransport("http")}
            >
              {mcpTransport === "http" && <span className="settings-segmented-thumb" />}
              <span>HTTP 远程</span>
            </button>
          </div>
        </div>

        <div className="plugin-mcp-add-grid">
          <input
            placeholder="显示名称（如 Postgres）"
            value={mcpName}
            onChange={(event) => setMcpName(event.target.value)}
          />
          {mcpTransport === "stdio" ? (
            <input
              className="mono"
              placeholder="启动命令，例如 npx -y @modelcontextprotocol/server-postgres postgresql://..."
              value={mcpCmdLine}
              onChange={(event) => setMcpCmdLine(event.target.value)}
            />
          ) : (
            <input
              className="mono"
              placeholder="远程 MCP Endpoint，例如 https://mcp.example.com/mcp"
              value={mcpUrl}
              onChange={(event) => setMcpUrl(event.target.value)}
            />
          )}
        </div>

        <input
          className="mono"
          placeholder={
            mcpTransport === "stdio"
              ? "环境变量（可选，格式 KEY=VALUE，多项用逗号分隔，例如 GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...）"
              : "请求头（可选，格式 Authorization=Bearer xxx，多项用逗号分隔）"
          }
          value={mcpEnvLine}
          onChange={(event) => setMcpEnvLine(event.target.value)}
        />

        <div className="plugin-mcp-add-foot">
          <label className="plugin-watch-toggle">
            <input
              type="checkbox"
              checked={mcpReadOnly}
              onChange={(event) => setMcpReadOnly(event.target.checked)}
            />
            <span>信任为只读查询服务（工具调用免弹窗确认）</span>
          </label>
          <button type="button" className="primary-button" onClick={handleAddCustomMcp}>
            <Plus size={13} />
            <span>添加连接器</span>
          </button>
        </div>
      </div>
    </div>
  );
}
