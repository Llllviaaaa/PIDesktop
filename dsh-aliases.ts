/**
 * The DeepSeek Harness packages PIDesktop carries under src/dsh (MIT,
 * © 2026 DeepSeek, github.com/deepseek-ai/deepseek-harness), resolved by
 * their package names so the copied sources stay as they are upstream, and
 * the framework modules PIDesktop stands in for under src/dsh-host/modules.
 * tsconfig.json mirrors this table under `paths`.
 */
import { fileURLToPath } from "node:url";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export const DSH_PACKAGES: Record<string, string> = {
  // Copied from deepseek-harness (src/dsh/README.md).
  "@deepseek-ai/dsh-client-ui-primitives": "./src/dsh/primitives/index.ts",
  "@deepseek-ai/dsh-client-ui-dockkit": "./src/dsh/dockkit/index.ts",
  "@deepseek-ai/dsh-client-store": "./src/dsh/store/index.ts",
  "@deepseek-ai/dsh-brand": "./src/dsh/brand/index.ts",
  "@deepseek-ai/dsh-util-code-language": "./src/dsh/code-language/index.ts",
  "@deepseek-ai/dsh-util-workspace-path": "./src/dsh/workspace-path/index.ts",
  "@deepseek-ai/dsh-util-values": "./src/dsh/util-values/index.ts",
  "@deepseek-ai/dsh-util-crypto": "./src/dsh/util-crypto/index.ts",
  "@deepseek-ai/dsh-client-ui-slots": "./src/dsh/slots/index.ts",
  "@deepseek-ai/dsh-client-ui-renderer/client": "./src/dsh/renderer/client/index.ts",
  "@deepseek-ai/dsh-client-resources/client": "./src/dsh/resources/client/index.ts",
  "@deepseek-ai/dsh-client-ui-session/client": "./src/dsh/ui-session/client/index.ts",
  "@deepseek-ai/dsh-client-ui-sidebar-right/client": "./src/dsh/sidebar-right/client/index.ts",
  "@deepseek-ai/dsh-client-ui-sidebar-terminal/client": "./src/dsh/sidebar-terminal/client/index.ts",
  "@deepseek-ai/dsh-api-terminal-controller/client": "./src/dsh/terminal-controller/client/index.ts",
  "@deepseek-ai/dsh-api-terminal-controller/types": "./src/dsh/terminal-controller/types.ts",
  "@deepseek-ai/dsh-deque": "./src/dsh/deque/index.ts",
  // PIDesktop's stand-ins for DSH's framework (src/dsh-host/README.md).
  "@deepseek-ai/dsh-session/types": "./src/dsh-host/modules/session-types.ts",
  "@deepseek-ai/dsh-typert-protocol": "./src/dsh-host/modules/typert-protocol.ts",
  "@deepseek-ai/dsh-api-remotes/client": "./src/dsh-host/modules/remotes.ts",
  "@deepseek-ai/dsh-api-remote-access/client": "./src/dsh-host/modules/remote-access.ts",
  "@deepseek-ai/dsh-api-session-controller/client": "./src/dsh-host/modules/session-controller.ts",
  "@deepseek-ai/dsh-client-locale/client": "./src/dsh-host/modules/locale.ts",
  "@deepseek-ai/dsh-client-shortcuts/client": "./src/dsh-host/modules/shortcuts.ts",
  "@deepseek-ai/dsh-client-ui-theme/client": "./src/dsh-host/modules/theme.ts",
  "@deepseek-ai/dsh-client-ui-layout/client": "./src/dsh-host/modules/layout.ts",
  "@deepseek-ai/dsh-client-ui-conversation/client": "./src/dsh-host/modules/conversation.ts",
  "@deepseek-ai/dsh-api-workspace-controller/client": "./src/dsh-host/modules/workspace-controller.ts",
  "@deepseek-ai/dsh-api-gateway/client": "./src/dsh-host/modules/gateway/index.ts",
  "@deepseek-ai/dsh-client-connection/client": "./src/dsh-host/modules/connection.ts",
  "@deepseek-ai/dsh-api-terminal-controller/remote": "./src/dsh-host/modules/terminals.ts",
};

/**
 * The DSH host packages better-sidebar's host half imports, mapped to the
 * Harness Host's stand-ins (packages/host/src/better-sidebar/shims). The host
 * bundle (scripts/prepare-harness-host.mjs) and vitest resolve them the same way.
 */
export const BETTER_SIDEBAR_HOST_SHIMS: Record<string, string> = Object.fromEntries(
  ["dsh-tools", "dsh-settings", "dsh-llm", "dsh-agent", "dsh-subagent"].map((name) => [
    `@deepseek-ai/${name}`,
    `./packages/host/src/better-sidebar/shims/${name}.ts`,
  ]),
);

/** Exact-name matches, so a deep import of another package is never rewritten. */
export const DSH_ALIASES = [
  ...Object.entries({ ...DSH_PACKAGES, ...BETTER_SIDEBAR_HOST_SHIMS }).map(([name, path]) => ({
    find: new RegExp(`^${name.replace(/[/\\-]/g, "\\$&")}$`),
    replacement: at(path),
  })),
  // better-sidebar (MIT, © 2026 dsh-external) under src/better-sidebar, by its
  // package name. Its sources type-check upstream against DSH's own host types,
  // so tsconfig.json resolves the name to src/dsh-host/types/better-sidebar.d.ts.
  { find: /^dsh-better-sidebar\/(.*)$/, replacement: `${at("./src/better-sidebar/")}$1` },
  // @xterm/headless 6.0.0 names `lib/xterm.mjs` as its module entry, which it
  // does not ship; its ES build is lib-headless/xterm-headless.mjs.
  { find: /^@xterm\/headless$/, replacement: at("./node_modules/@xterm/headless/lib-headless/xterm-headless.mjs") },
];
