/**
 * JSON-RPC methods for dynamic plugin management and workspace trust (ADR 0016):
 * `plugin.list`, `plugin.enable`, `plugin.disable`, `plugin.configure`,
 * `plugin.reload`, `plugin.install`, `plugin.update`, `plugin.remove`,
 * `plugin.clientBundle`, `workspace.trust.list`, `workspace.trust.set`.
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  ErrorCode,
  type PluginClientBundleResult,
  type PluginInstallChannel,
  type PluginListResult,
  type PluginMutationResult,
  type WorkspaceTrustListResult,
} from "@qianji/protocol";
import type { PluginManager } from "./plugin-manager.ts";
import { RpcError } from "./rpc.ts";

export const name = "qianji-plugins-rpc";
export const inject = ["rpc"];

export interface PluginsRpcConfig {
  manager: PluginManager;
}

const CHANNELS: readonly PluginInstallChannel[] = ["local", "archive", "git", "npm"];

function asObject(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function requiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new RpcError(ErrorCode.InvalidParams, `${key} must be a string`);
  }
  return value.trim() === "" ? undefined : value.trim();
}

function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new RpcError(ErrorCode.InvalidParams, `${key} must be a boolean`);
  }
  return value;
}

async function wrapPluginAction<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RpcError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Workspace is not trusted:")) {
      throw new RpcError(ErrorCode.PermissionDenied, message);
    }
    throw new RpcError(ErrorCode.InvalidParams, message);
  }
}

export function apply(ctx: Context, config: PluginsRpcConfig): void {
  const { manager } = config;

  const methods: Record<string, (params: unknown) => unknown> = {
    "plugin.list": async (params): Promise<PluginListResult> => {
      const p = asObject(params);
      if (p.workspace !== undefined && typeof p.workspace !== "string") {
        throw new RpcError(ErrorCode.InvalidParams, "workspace must be a string");
      }
      const workspace = typeof p.workspace === "string" ? p.workspace.trim() : undefined;
      return { plugins: await manager.list(workspace) };
    },

    "plugin.enable": (params): Promise<PluginMutationResult> => {
      const p = asObject(params);
      const id = requiredString(p, "id");
      const workspace = optionalString(p, "workspace");
      const watch = optionalBoolean(p, "watch");
      return wrapPluginAction(() => manager.setEnabled(id, true, {
        ...(workspace === undefined ? {} : { workspace }),
        ...(watch === undefined ? {} : { watch }),
      }));
    },

    "plugin.disable": (params): Promise<PluginMutationResult> => {
      const p = asObject(params);
      const id = requiredString(p, "id");
      const workspace = optionalString(p, "workspace");
      const watch = optionalBoolean(p, "watch");
      return wrapPluginAction(() => manager.setEnabled(id, false, {
        ...(workspace === undefined ? {} : { workspace }),
        ...(watch === undefined ? {} : { watch }),
      }));
    },

    "plugin.configure": (params): Promise<PluginMutationResult> => {
      const p = asObject(params);
      const id = requiredString(p, "id");
      const rawConfig = p.config;
      if (typeof rawConfig !== "object" || rawConfig === null || Array.isArray(rawConfig)) {
        throw new RpcError(ErrorCode.InvalidParams, "config must be a JSON object");
      }
      const workspace = optionalString(p, "workspace");
      const watch = optionalBoolean(p, "watch");
      return wrapPluginAction(() => manager.configure(id, rawConfig as Record<string, unknown>, {
        ...(workspace === undefined ? {} : { workspace }),
        ...(watch === undefined ? {} : { watch }),
      }));
    },

    "plugin.reload": (params): Promise<PluginMutationResult> => {
      const p = asObject(params);
      const id = optionalString(p, "id");
      const workspace = optionalString(p, "workspace");
      return wrapPluginAction(() => manager.reload(id, workspace));
    },

    "plugin.install": (params): Promise<PluginMutationResult> => {
      const p = asObject(params);
      const channel = requiredString(p, "channel") as PluginInstallChannel;
      if (!CHANNELS.includes(channel)) {
        throw new RpcError(ErrorCode.InvalidParams, `channel must be one of ${CHANNELS.join(", ")}`);
      }
      const spec = requiredString(p, "spec");
      const link = optionalBoolean(p, "link");
      const watch = optionalBoolean(p, "watch");
      return wrapPluginAction(() => manager.install({
        channel,
        spec,
        ...(link === undefined ? {} : { link }),
        ...(watch === undefined ? {} : { watch }),
      }));
    },

    "plugin.update": (params): Promise<PluginMutationResult> => {
      const p = asObject(params);
      const id = optionalString(p, "id");
      return wrapPluginAction(() => manager.update(id));
    },

    "plugin.remove": (params): Promise<PluginMutationResult> => {
      const p = asObject(params);
      const id = requiredString(p, "id");
      const workspace = optionalString(p, "workspace");
      return wrapPluginAction(() => manager.remove(id, workspace));
    },

    "plugin.clientBundle": (params): Promise<PluginClientBundleResult> => {
      const p = asObject(params);
      const id = requiredString(p, "id");
      const workspace = optionalString(p, "workspace");
      const ifNoneMatch = optionalString(p, "ifNoneMatch");
      return wrapPluginAction(() => manager.clientBundle(id, {
        ...(workspace === undefined ? {} : { workspace }),
        ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
      }));
    },

    "workspace.trust.list": (params): WorkspaceTrustListResult => {
      const p = asObject(params);
      const workspace = optionalString(p, "workspace");
      return manager.workspaceTrustList(workspace);
    },

    "workspace.trust.set": (params): Promise<WorkspaceTrustListResult> => {
      const p = asObject(params);
      const workspace = requiredString(p, "workspace");
      const trusted = optionalBoolean(p, "trusted");
      if (trusted === undefined) {
        throw new RpcError(ErrorCode.InvalidParams, "trusted must be a boolean");
      }
      return wrapPluginAction(() => manager.workspaceTrustSet(workspace, trusted));
    },
  };

  for (const [method, handler] of Object.entries(methods)) {
    ctx.effect(() => ctx.rpc.method(method, handler), `${name}: ${method}`);
  }
}
