/**
 * Shares the Host's in-memory Cordis and `@qianji/*` interface singletons with
 * external plugins loaded outside `qianji-harness.exe` (ADR 0016).
 *
 * - Inside the Bun-compiled executable (`qianji-harness.exe`), `Bun.plugin`
 *   registers `build.module(specifier, ...)` virtual modules backed by the
 *   running process's own module namespace objects, and external plugins are
 *   loaded via native `import()` with a cache-busting revision query parameter.
 * - Inside Node 22+ (`vitest` VM workers and `--bundle-only` dev runs),
 *   `esbuild` bundles the external plugin entry as CommonJS and evaluates it
 *   against a scoped `require` that serves shared Host singletons directly
 *   from memory while delegating Node built-ins and package dependencies to
 *   `createRequire(filePath)`.
 */
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import * as cordisNs from "@deepseek-ai/cordis";
import Schema, * as schemasteryNs from "@deepseek-ai/schemastery";
import * as agentNs from "@qianji/agent";
import * as commandsNs from "@qianji/commands";
import * as kernelNs from "@qianji/kernel";
import * as llmNs from "@qianji/llm";
import * as pricingNs from "@qianji/pricing";
import * as protocolNs from "@qianji/protocol";
import * as rpcNs from "@qianji/rpc";
import * as sessionNs from "@qianji/session";
import * as systemPromptNs from "@qianji/system-prompt";
import * as toolsNs from "@qianji/tools";
import * as uiNs from "@qianji/ui";

interface BunPluginBuilder {
  module(specifier: string, callback: () => { exports: Record<string, unknown>; loader: "object" }): void;
}

interface BunGlobal {
  plugin(definition: { name: string; setup(build: BunPluginBuilder): void }): unknown;
}

interface EsbuildApi {
  build(options: {
    entryPoints: string[];
    bundle: boolean;
    write: false;
    format: "cjs";
    platform: "node";
    target: string;
    external: string[];
    logLevel: "silent";
  }): Promise<{ outputFiles: Array<{ text: string }> }>;
}

const cordisExports: Record<string, unknown> = { ...cordisNs, default: cordisNs.Context };
const schemasteryExports: Record<string, unknown> = { ...schemasteryNs, default: Schema };

export const HOST_SHARED_MODULES: Readonly<Record<string, Record<string, unknown>>> = {
  "@deepseek-ai/cordis": cordisExports,
  cordis: cordisExports,
  "@deepseek-ai/schemastery": schemasteryExports,
  schemastery: schemasteryExports,
  "@qianji/protocol": { ...protocolNs },
  "@qianji/kernel": { ...kernelNs },
  "@qianji/rpc": { ...rpcNs },
  "@qianji/llm": { ...llmNs },
  "@qianji/pricing": { ...pricingNs },
  "@qianji/tools": { ...toolsNs },
  "@qianji/session": { ...sessionNs },
  "@qianji/agent": { ...agentNs },
  "@qianji/commands": { ...commandsNs },
  "@qianji/system-prompt": { ...systemPromptNs },
  "@qianji/ui": { ...uiNs },
  // Legacy `@pid/*` aliases so existing external plugins migrated from `~/.pid/plugins` continue working.
  "@pid/protocol": { ...protocolNs },
  "@pid/kernel": { ...kernelNs },
  "@pid/rpc": { ...rpcNs },
  "@pid/llm": { ...llmNs },
  "@pid/pricing": { ...pricingNs },
  "@pid/tools": { ...toolsNs },
  "@pid/session": { ...sessionNs },
  "@pid/agent": { ...agentNs },
  "@pid/commands": { ...commandsNs },
  "@pid/system-prompt": { ...systemPromptNs },
  "@pid/ui": { ...uiNs },
};

let bridgePromise: Promise<void> | undefined;
let cachedEsbuild: EsbuildApi | undefined;

function loadNodeEsbuild(): EsbuildApi {
  if (cachedEsbuild !== undefined) return cachedEsbuild;
  const req = createRequire(import.meta.url);
  const pkgName = "esbuild";
  cachedEsbuild = req(pkgName) as EsbuildApi;
  return cachedEsbuild;
}

/** Install the process-wide module bridge once. Safe to call repeatedly. */
export function installHostModuleBridge(): Promise<void> {
  if (bridgePromise !== undefined) return bridgePromise;
  bridgePromise = (async () => {
    const bun = (globalThis as { Bun?: BunGlobal }).Bun;
    if (bun !== undefined) {
      await bun.plugin({
        name: "qianji-host-module-bridge",
        setup(build) {
          for (const [specifier, exports] of Object.entries(HOST_SHARED_MODULES)) {
            build.module(specifier, () => ({ exports, loader: "object" }));
          }
        },
      });
      return;
    }
    loadNodeEsbuild();
  })();
  return bridgePromise;
}

export function evictBunModuleSubtree(pluginDir: string): void {
  const normalizedDir = pluginDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const pathPrefix = `${normalizedDir}/`;
  const fileUrlPrefix = `${pathToFileURL(pluginDir).href.replace(/\/+$/, "").toLowerCase()}/`;
  const matchesSubtree = (rawKey: string): boolean => {
    const normalizedKey = rawKey.replace(/\\/g, "/").toLowerCase();
    const withoutQuery = normalizedKey.split("?")[0] ?? normalizedKey;
    return (
      withoutQuery === normalizedDir
      || withoutQuery.startsWith(pathPrefix)
      || withoutQuery.startsWith(fileUrlPrefix)
    );
  };

  const loader = (globalThis as { Loader?: { registry?: Map<string, unknown> } }).Loader;
  if (loader?.registry !== undefined) {
    for (const key of [...loader.registry.keys()]) {
      if (matchesSubtree(key)) {
        loader.registry.delete(key);
      }
    }
  }

  try {
    const nodeCache = createRequire(import.meta.url).cache;
    if (nodeCache !== undefined) {
      for (const key of Object.keys(nodeCache)) {
        if (matchesSubtree(key)) {
          delete nodeCache[key];
        }
      }
    }
  } catch {
    // Ignore environments without CJS module cache
  }
}

/** Import an external JS/TS module with fresh evaluation so HMR reloads modified code. */
export async function importExternalModule(
  filePath: string,
  revision: string | number,
  pluginDir?: string,
): Promise<Record<string, unknown>> {
  await installHostModuleBridge();
  evictBunModuleSubtree(pluginDir ?? dirname(filePath));

  const bun = (globalThis as { Bun?: BunGlobal }).Bun;
  if (bun !== undefined) {
    const href = `${pathToFileURL(filePath).href}?rev=${encodeURIComponent(String(revision))}`;
    return (await import(/* @vite-ignore */ href)) as Record<string, unknown>;
  }

  const esbuild = loadNodeEsbuild();
  const built = await esbuild.build({
    entryPoints: [filePath],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node22",
    external: Object.keys(HOST_SHARED_MODULES),
    logLevel: "silent",
  });

  const output = built.outputFiles[0];
  if (output === undefined) {
    throw new Error(`Bundler produced no output for ${filePath}`);
  }

  const fileRequire = createRequire(filePath);
  const scopedRequire = Object.assign(
    (specifier: string): unknown => {
      if (specifier in HOST_SHARED_MODULES) {
        return HOST_SHARED_MODULES[specifier];
      }
      return fileRequire(specifier);
    },
    { resolve: fileRequire.resolve },
  );

  const cjsModule = { exports: {} as Record<string, unknown> };
  const sourceWithUrl = `${output.text}\n//# sourceURL=${pathToFileURL(filePath).href}?rev=${encodeURIComponent(String(revision))}`;
  const evaluate = new Function("require", "module", "exports", "__filename", "__dirname", sourceWithUrl) as (
    req: typeof scopedRequire,
    mod: typeof cjsModule,
    exp: Record<string, unknown>,
    filename: string,
    dir: string,
  ) => void;
  evaluate(scopedRequire, cjsModule, cjsModule.exports, filePath, dirname(filePath));
  return cjsModule.exports;
}
