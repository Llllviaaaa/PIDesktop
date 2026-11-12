/**
 * Pre-flight checks for a plugin directory (`plugin_manager` `verify`, ADR 0016):
 * the manifest, the host entry's syntax and imports, and a compile of the
 * client bundle, with nothing installed or configured.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { ClientBundleRegistry } from "./client-bundles.ts";
import { HOST_SHARED_MODULES } from "./plugin-bridge.ts";
import { readPluginManifest } from "./plugin-manifest.ts";
import { errorMessage } from "./plugin-util.ts";

interface EsbuildNodeVerifier {
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

interface BunBuildVerifier {
  build(options: {
    entrypoints: string[];
    format: "cjs";
    target: "bun" | "node";
    external: string[];
  }): Promise<{
    success: boolean;
    logs: Array<{ message?: string } | string>;
  }>;
}

async function verifyHostEntrySyntaxAndImports(hostEntry: string): Promise<{ ok: boolean; error?: string }> {
  const external = [...Object.keys(HOST_SHARED_MODULES), "node:*"];
  const bunGlobal = (globalThis as { Bun?: BunBuildVerifier }).Bun;
  if (bunGlobal !== undefined && typeof bunGlobal.build === "function" && process.versions.bun !== undefined) {
    try {
      const result = await bunGlobal.build({
        entrypoints: [hostEntry],
        format: "cjs",
        target: "bun",
        external,
      });
      if (!result.success) {
        const msg = result.logs
          .map((item) => (typeof item === "string" ? item : item.message ?? String(item)))
          .join("; ");
        return { ok: false, error: msg || `Failed to compile host entry ${hostEntry}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  try {
    const req = createRequire(import.meta.url);
    const esbuildPkg = "esbuild";
    const esbuild = req(esbuildPkg) as EsbuildNodeVerifier;
    await esbuild.build({
      entryPoints: [hostEntry],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      target: "node22",
      external: Object.keys(HOST_SHARED_MODULES),
      logLevel: "silent",
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export interface PluginVerifyReport {
  ok: boolean;
  target: string;
  pluginId?: string;
  name?: string;
  version?: string;
  hasHost?: boolean;
  hasClient?: boolean;
  hostEntry?: string;
  clientEntry?: string;
  clientBundleBytes?: number;
  clientCompiled?: { bytes: number; etag: string };
  errors: string[];
  warnings: string[];
}

/** Dry-run manifest validation + Host & Client compilation without mutating `plugins.json`. */
export async function verifyPluginDirectory(targetDir: string): Promise<PluginVerifyReport> {
  const resolvedDir = resolve(targetDir);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(resolvedDir)) {
    return {
      ok: false,
      target: resolvedDir,
      errors: [`Directory does not exist: ${resolvedDir}`],
      warnings,
    };
  }

  let manifest;
  try {
    manifest = readPluginManifest(resolvedDir, "user");
  } catch (error) {
    return {
      ok: false,
      target: resolvedDir,
      errors: [errorMessage(error)],
      warnings,
    };
  }

  if (!existsSync(join(resolvedDir, "package.json"))) {
    warnings.push("No package.json found; add package.json with explicit name, version, description, and qianji metadata.");
  }
  if (!manifest.description || manifest.description.trim() === "") {
    warnings.push("Plugin package.json is missing a human-readable `description`.");
  }

  if (manifest.hostEntry !== undefined) {
    const hostCheck = await verifyHostEntrySyntaxAndImports(manifest.hostEntry);
    if (!hostCheck.ok && hostCheck.error !== undefined) {
      errors.push(`Host entry compile error (${manifest.hostEntry}): ${hostCheck.error}`);
    }
  }

  let clientBundleBytes: number | undefined;
  let clientCompiled: { bytes: number; etag: string } | undefined;
  if (manifest.clientEntry !== undefined) {
    try {
      const tempRegistry = new ClientBundleRegistry();
      const compiled = await tempRegistry.compile(manifest.id, manifest.dir, manifest.clientEntry);
      clientBundleBytes = Buffer.byteLength(compiled.code, "utf8");
      clientCompiled = { bytes: clientBundleBytes, etag: compiled.etag };
    } catch (error) {
      errors.push(`Client bundle compilation failed (${manifest.clientEntry}): ${errorMessage(error)}`);
    }
  }

  return {
    ok: errors.length === 0,
    target: manifest.dir,
    pluginId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    hasHost: manifest.hostEntry !== undefined,
    hasClient: manifest.clientEntry !== undefined,
    ...(manifest.hostEntry === undefined ? {} : { hostEntry: manifest.hostEntry }),
    ...(manifest.clientEntry === undefined ? {} : { clientEntry: manifest.clientEntry }),
    ...(clientBundleBytes === undefined ? {} : { clientBundleBytes }),
    ...(clientCompiled === undefined ? {} : { clientCompiled }),
    errors,
    warnings,
  };
}
