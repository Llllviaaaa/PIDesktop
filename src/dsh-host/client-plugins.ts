/**
 * Binds the client plugin runtime (`src/lib/clientPluginRuntime.ts`) to
 * PIDesktop's DSH Cordis context and shared browser singletons.
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import {
  createClientPluginRuntime,
  type ClientPluginRuntimeHandle,
  type ClientPluginTransport,
  type ModuleLoaderGlobal,
} from "../lib/clientPluginRuntime";
import { harnessRuntimes } from "../lib/harnessRuntime";
import { pluginClient } from "../lib/pluginClient";

declare global {
  interface Window {
    __ModuleLoader__?: ModuleLoaderGlobal;
  }
}

/** Shared browser singletons exposed via both `ctx.modules.import()` and CJS `require()`. */
export const CLIENT_MODULES: Record<string, () => Promise<unknown>> = {
  "react": () => import("react"),
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  "react/jsx-dev-runtime": () => import("react/jsx-dev-runtime"),
  "react-dom": () => import("react-dom"),
  "react-dom/client": () => import("react-dom/client"),
  "cordis": () => import("@deepseek-ai/cordis"),
  "@deepseek-ai/cordis": () => import("@deepseek-ai/cordis"),
  "schemastery": () => import("@deepseek-ai/schemastery"),
  "@deepseek-ai/schemastery": () => import("@deepseek-ai/schemastery"),
  "@deepseek-ai/dsh-client-ui-slots": () => import("@deepseek-ai/dsh-client-ui-slots"),
  "@deepseek-ai/dsh-client-ui-primitives": () => import("@deepseek-ai/dsh-client-ui-primitives"),
  "dsh-better-sidebar": () => import("dsh-better-sidebar/client/index.tsx"),
  "dsh-better-sidebar/client": () => import("dsh-better-sidebar/client/index.tsx"),
  "@pid/protocol": () => import("@pid/protocol"),
  "lucide-react": () => import("lucide-react"),
};

const defaultTransport: ClientPluginTransport = {
  list: (workspace) => pluginClient.list(workspace),
  clientBundle: (params) => pluginClient.clientBundle(params),
  onChanged: (listener) => pluginClient.onChanged(() => listener()),
  onTrustChanged: (listener) => pluginClient.onTrustChanged(() => listener()),
  onHostReconnect: (listener) => {
    let seenConnected = false;
    return harnessRuntimes.onHostStatus((status) => {
      if (status === "connected") {
        if (seenConnected) listener();
        seenConnected = true;
      }
    });
  },
};

export function startClientPluginRuntime(root: Context): ClientPluginRuntimeHandle {
  return createClientPluginRuntime<Plugin>(root, {
    transport: defaultTransport,
    modules: CLIENT_MODULES,
  });
}
