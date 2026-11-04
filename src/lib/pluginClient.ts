/**
 * Frontend RPC wrapper for the Harness Host's dynamic plugin kernel and
 * workspace trust gate (ADR 0016).
 */
import type {
  PluginChangedNotification,
  PluginClientBundleParams,
  PluginClientBundleResult,
  PluginConfigureParams,
  PluginInfo,
  PluginInstallParams,
  PluginListResult,
  PluginMutationResult,
  PluginReloadParams,
  PluginRemoveParams,
  PluginToggleParams,
  PluginUpdateParams,
  WorkspaceTrustChangedNotification,
  WorkspaceTrustListResult,
  WorkspaceTrustSetParams,
} from "@pid/protocol";
import { harnessRuntimes } from "./harnessRuntime";

type Unsubscribe = () => void;

function withWorkspace(params: Record<string, unknown>, workspace?: string): Record<string, unknown> {
  const raw = typeof params.workspace === "string" ? params.workspace : workspace ?? "";
  const trimmed = raw.trim();
  const next: Record<string, unknown> = { ...params };
  if (trimmed !== "") next.workspace = trimmed;
  else delete next.workspace;
  return next;
}

export const pluginClient = {
  async list(workspace?: string): Promise<PluginInfo[]> {
    const { plugins } = await harnessRuntimes.call<PluginListResult>(
      "plugin.list",
      withWorkspace({}, workspace),
    );
    return plugins;
  },

  enable(params: PluginToggleParams): Promise<PluginMutationResult> {
    return harnessRuntimes.call<PluginMutationResult>("plugin.enable", withWorkspace({ ...params }));
  },

  disable(params: PluginToggleParams): Promise<PluginMutationResult> {
    return harnessRuntimes.call<PluginMutationResult>("plugin.disable", withWorkspace({ ...params }));
  },

  configure(params: PluginConfigureParams): Promise<PluginMutationResult> {
    return harnessRuntimes.call<PluginMutationResult>("plugin.configure", withWorkspace({ ...params }));
  },

  reload(params: PluginReloadParams = {}): Promise<PluginMutationResult> {
    return harnessRuntimes.call<PluginMutationResult>("plugin.reload", withWorkspace({ ...params }));
  },

  install(params: PluginInstallParams): Promise<PluginMutationResult> {
    return harnessRuntimes.call<PluginMutationResult>("plugin.install", { ...params });
  },

  update(params: PluginUpdateParams = {}): Promise<PluginMutationResult> {
    return harnessRuntimes.call<PluginMutationResult>("plugin.update", { ...params });
  },

  remove(params: PluginRemoveParams): Promise<PluginMutationResult> {
    return harnessRuntimes.call<PluginMutationResult>("plugin.remove", withWorkspace({ ...params }));
  },

  clientBundle(params: PluginClientBundleParams): Promise<PluginClientBundleResult> {
    return harnessRuntimes.call<PluginClientBundleResult>("plugin.clientBundle", withWorkspace({ ...params }));
  },

  trustList(workspace?: string): Promise<WorkspaceTrustListResult> {
    return harnessRuntimes.call<WorkspaceTrustListResult>(
      "workspace.trust.list",
      withWorkspace({}, workspace),
    );
  },

  setTrust(params: WorkspaceTrustSetParams): Promise<WorkspaceTrustListResult> {
    return harnessRuntimes.call<WorkspaceTrustListResult>("workspace.trust.set", {
      workspace: params.workspace,
      trusted: params.trusted,
    });
  },

  onChanged(listener: (payload: PluginChangedNotification) => void): Unsubscribe {
    return harnessRuntimes.onNotification("plugin/changed", (params) => {
      listener(params as PluginChangedNotification);
    });
  },

  onTrustChanged(listener: (payload: WorkspaceTrustChangedNotification) => void): Unsubscribe {
    return harnessRuntimes.onNotification("workspace/trustChanged", (params) => {
      listener(params as WorkspaceTrustChangedNotification);
    });
  },
};
