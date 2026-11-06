import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { describeError } from "../lib/errors";
import { pluginClient } from "../lib/pluginClient";
import { queryKeys } from "../lib/queries";
import { useAppStore } from "../store";

/**
 * Prompts the user before executing untrusted workspace-local plugins under
 * `<workspace>/.pid/plugins/*` (ADR 0016 Workspace Trust Gate).
 */
export function WorkspaceTrustBanner({
  workspace,
  onOpenPluginsSettings,
}: {
  workspace: string;
  onOpenPluginsSettings: () => void;
}) {
  const isTauri = "__TAURI_INTERNALS__" in window;
  const trimmed = workspace.trim();
  const queryClient = useQueryClient();
  const [dismissedWorkspace, setDismissedWorkspace] = useState<string | null>(null);

  const trustQuery = useQuery({
    queryKey: queryKeys.workspaceTrust(trimmed),
    queryFn: () => pluginClient.trustList(trimmed),
    enabled: isTauri && trimmed !== "",
  });

  useEffect(() => {
    if (!isTauri || trimmed === "") return undefined;
    const stopTrust = pluginClient.onTrustChanged(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTrust(trimmed) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins(trimmed) });
    });
    const stopPlugins = pluginClient.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTrust(trimmed) });
    });
    return () => {
      stopTrust();
      stopPlugins();
    };
  }, [isTauri, queryClient, trimmed]);

  const trustMutation = useMutation({
    mutationFn: () => pluginClient.setTrust({ workspace: trimmed, trusted: true }),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.workspaceTrust(trimmed), result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins(trimmed) });
      useAppStore.getState().showToast("已信任工作区并启用项目级插件", "info");
    },
    onError: (error) => {
      useAppStore.getState().showToast(`信任工作区失败：${describeError(error)}`, "error");
    },
  });

  const current = trustQuery.data?.current;
  if (
    trimmed === "" ||
    dismissedWorkspace === trimmed ||
    current === undefined ||
    current.trusted ||
    (!current.hasProjectPlugins && !current.hasProjectConfig)
  ) {
    return null;
  }

  const summary = current.pluginIds.length > 0
    ? `检测到当前项目包含 ${current.pluginIds.length} 个项目级插件（${current.pluginIds.join("、")}），出于安全保护默认暂未运行。`
    : "检测到当前项目包含项目级插件配置（.pid/plugins.json），出于安全保护默认暂未生效。";

  return (
    <div className="workspace-trust-banner" role="region" aria-label="工作区插件信任提示">
      <div className="workspace-trust-copy">
        <ShieldAlert size={16} />
        <span>{summary}</span>
      </div>
      <div className="workspace-trust-actions">
        <button
          type="button"
          className="plugin-mini-button"
          onClick={onOpenPluginsSettings}
        >
          查看详情
        </button>
        <button
          type="button"
          className="plugin-mini-button"
          onClick={() => setDismissedWorkspace(trimmed)}
        >
          暂不信任
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={trustMutation.isPending}
          onClick={() => trustMutation.mutate()}
        >
          <ShieldCheck size={14} />
          <span>{trustMutation.isPending ? "正在启用…" : "信任并启用项目插件"}</span>
        </button>
      </div>
    </div>
  );
}
