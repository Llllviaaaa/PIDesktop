import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { McpPromptInfo, McpResourceInfo, McpServerStatus } from "@pid/protocol";
import { BookOpen, Eye, LoaderCircle, MessageSquareText, RefreshCw } from "lucide-react";
import { agent } from "../lib/agent";
import { describeError } from "../lib/errors";
import { queryKeys } from "../lib/queries";

interface McpServerInspectorProps {
  serverId: string;
  status: McpServerStatus | undefined;
}

export function McpServerInspector({ serverId, status }: McpServerInspectorProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"resources" | "prompts">("resources");
  const [resourcePreview, setResourcePreview] = useState<{ uri: string; text: string } | null>(null);
  const [resourceLoadingUri, setResourceLoadingUri] = useState<string | null>(null);
  const [promptArgs, setPromptArgs] = useState<Record<string, Record<string, string>>>({});
  const [promptPreview, setPromptPreview] = useState<{ name: string; markdown: string } | null>(null);
  const [promptLoadingName, setPromptLoadingName] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const canInspectResources = Boolean(status?.connected && status.resources);
  const canInspectPrompts = Boolean(status?.connected && status.prompts);

  const resourcesQuery = useQuery({
    queryKey: queryKeys.mcpResources(serverId),
    queryFn: () => agent.mcpResources(serverId),
    enabled: open && tab === "resources" && canInspectResources,
  });

  const promptsQuery = useQuery({
    queryKey: queryKeys.mcpPrompts(serverId),
    queryFn: () => agent.mcpPrompts(serverId),
    enabled: open && tab === "prompts" && canInspectPrompts,
  });

  if (!status?.connected || (!status.resources && !status.prompts)) {
    return null;
  }

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !canInspectResources && canInspectPrompts) {
      setTab("prompts");
    }
  };

  const handleReadResource = async (item: McpResourceInfo) => {
    setPreviewError(null);
    setResourceLoadingUri(item.uri);
    try {
      const result = await agent.mcpReadResource(serverId, item.uri);
      setResourcePreview({ uri: result.uri, text: result.text });
    } catch (error) {
      setPreviewError(`读取资源失败：${describeError(error)}`);
    } finally {
      setResourceLoadingUri(null);
    }
  };

  const handleGetPrompt = async (item: McpPromptInfo) => {
    setPreviewError(null);
    setPromptLoadingName(item.name);
    try {
      const args = promptArgs[item.name] ?? {};
      const result = await agent.mcpGetPrompt(serverId, item.name, args);
      setPromptPreview({ name: result.name, markdown: result.markdown });
    } catch (error) {
      setPreviewError(`读取提示词失败：${describeError(error)}`);
    } finally {
      setPromptLoadingName(null);
    }
  };

  const resources = resourcesQuery.data ?? [];
  const prompts = promptsQuery.data ?? [];

  return (
    <div className="mcp-inspector">
      <div className="mcp-inspector-bar">
        <button type="button" className="secondary-button compact" onClick={handleToggle}>
          <BookOpen size={13} />
          <span>{open ? "收起资源与提示词面板" : "浏览资源与提示词"}</span>
        </button>
        <small>
          {status.resources ? "支持 Resources" : ""}
          {status.resources && status.prompts ? " · " : ""}
          {status.prompts ? "支持 Prompts" : ""}
        </small>
      </div>

      {open && (
        <div className="mcp-inspector-body">
          <div className="mcp-inspector-tabs">
            {canInspectResources && (
              <button
                type="button"
                className={tab === "resources" ? "active" : ""}
                onClick={() => {
                  setTab("resources");
                  setPreviewError(null);
                }}
              >
                <BookOpen size={13} />
                <span>资源列表</span>
              </button>
            )}
            {canInspectPrompts && (
              <button
                type="button"
                className={tab === "prompts" ? "active" : ""}
                onClick={() => {
                  setTab("prompts");
                  setPreviewError(null);
                }}
              >
                <MessageSquareText size={13} />
                <span>提示词模板</span>
              </button>
            )}
            <button
              type="button"
              className="mcp-inspector-refresh"
              title="刷新列表"
              onClick={() => {
                if (tab === "resources") void resourcesQuery.refetch();
                else void promptsQuery.refetch();
              }}
            >
              <RefreshCw size={12} />
              <span>刷新</span>
            </button>
          </div>

          {previewError && <div className="mcp-inspector-error">{previewError}</div>}

          {tab === "resources" && canInspectResources && (
            <div className="mcp-inspector-section">
              {resourcesQuery.isLoading ? (
                <div className="mcp-inspector-empty">
                  <LoaderCircle className="spinner-icon" size={14} />
                  <span>正在加载资源列表…</span>
                </div>
              ) : resourcesQuery.isError ? (
                <div className="mcp-inspector-error">加载资源失败：{describeError(resourcesQuery.error)}</div>
              ) : resources.length === 0 ? (
                <div className="mcp-inspector-empty">当前服务器未公开任何资源。</div>
              ) : (
                <div className="mcp-inspector-list">
                  {resources.map((item) => (
                    <div className="mcp-inspector-row" key={item.uri}>
                      <div className="mcp-inspector-meta">
                        <strong>{item.title || item.name || item.uri}</strong>
                        <code>{item.uri}</code>
                        {item.description && <small>{item.description}</small>}
                      </div>
                      <button
                        type="button"
                        className="secondary-button compact"
                        disabled={resourceLoadingUri === item.uri}
                        onClick={() => void handleReadResource(item)}
                      >
                        <Eye size={12} />
                        <span>{resourceLoadingUri === item.uri ? "读取中…" : "读取预览"}</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {resourcePreview && (
                <div className="mcp-inspector-preview">
                  <header>
                    <strong>资源预览：<code>{resourcePreview.uri}</code></strong>
                    <button type="button" className="text-link" onClick={() => setResourcePreview(null)}>关闭</button>
                  </header>
                  <pre>{resourcePreview.text || "（空内容）"}</pre>
                </div>
              )}
            </div>
          )}

          {tab === "prompts" && canInspectPrompts && (
            <div className="mcp-inspector-section">
              {promptsQuery.isLoading ? (
                <div className="mcp-inspector-empty">
                  <LoaderCircle className="spinner-icon" size={14} />
                  <span>正在加载提示词模板…</span>
                </div>
              ) : promptsQuery.isError ? (
                <div className="mcp-inspector-error">加载提示词失败：{describeError(promptsQuery.error)}</div>
              ) : prompts.length === 0 ? (
                <div className="mcp-inspector-empty">当前服务器未公开任何提示词模板。</div>
              ) : (
                <div className="mcp-inspector-list">
                  {prompts.map((item) => {
                    const currentArgs = promptArgs[item.name] ?? {};
                    return (
                      <div className="mcp-inspector-row prompt-row" key={item.name}>
                        <div className="mcp-inspector-meta">
                          <strong>{item.title || item.name}</strong>
                          <code>{item.name}</code>
                          {item.description && <small>{item.description}</small>}
                          {item.arguments && item.arguments.length > 0 && (
                            <div className="mcp-prompt-args">
                              {item.arguments.map((arg) => (
                                <input
                                  key={arg.name}
                                  value={currentArgs[arg.name] ?? ""}
                                  placeholder={`${arg.name}${arg.required ? "（必填）" : "（可选）"}`}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    setPromptArgs((prev) => ({
                                      ...prev,
                                      [item.name]: { ...(prev[item.name] ?? {}), [arg.name]: value },
                                    }));
                                  }}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="secondary-button compact"
                          disabled={promptLoadingName === item.name}
                          onClick={() => void handleGetPrompt(item)}
                        >
                          <Eye size={12} />
                          <span>{promptLoadingName === item.name ? "生成中…" : "预览提示词"}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {promptPreview && (
                <div className="mcp-inspector-preview">
                  <header>
                    <strong>提示词预览：<code>{promptPreview.name}</code></strong>
                    <button type="button" className="text-link" onClick={() => setPromptPreview(null)}>关闭</button>
                  </header>
                  <pre>{promptPreview.markdown}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
