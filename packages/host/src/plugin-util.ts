/**
 * Small helpers of the plugin manager (plugin-manager.ts): value signatures,
 * error text, watcher filtering, plugin export resolution, and the stack
 * parsing that attributes an uncaught error to a plugin's files.
 */
import { fileURLToPath } from "node:url";
import type { Plugin } from "@deepseek-ai/cordis";
import { redactSensitiveText } from "@qianji/protocol";
import { pathComparisonKey } from "./plugin-manifest.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function signatureOf(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, item: unknown) => (typeof item === "function" ? "[function]" : item));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorDetailWithStack(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message || error.name || "Error";
    const rawStack = error.stack?.trim();
    if (rawStack !== undefined && rawStack !== "") {
      const combined = rawStack.includes(msg) ? rawStack : `${error.name || "Error"}: ${msg}\n${rawStack}`;
      return redactSensitiveText(combined);
    }
    return redactSensitiveText(msg);
  }
  return redactSensitiveText(String(error));
}

export function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function shouldIgnoreWatchedPath(filename: string | null | undefined): boolean {
  if (filename == null || filename === "") return false;
  const normalized = filename.replace(/\\/g, "/");
  return normalized === ".git"
    || normalized.startsWith(".git/")
    || normalized.startsWith("node_modules/")
    || normalized === "node_modules"
    || normalized.endsWith(".tmp")
    || normalized.endsWith("~");
}

export function resolveCordisPluginExport(mod: Record<string, unknown>, pluginId: string): Plugin {
  if (typeof mod.apply === "function") {
    return mod as unknown as Plugin;
  }
  const def = mod.default;
  if (typeof def === "function") {
    return def as unknown as Plugin;
  }
  if (isRecord(def) && typeof def.apply === "function") {
    return def as unknown as Plugin;
  }
  throw new Error(`Plugin "${pluginId}" host entry must export apply(ctx, config) or a default Cordis plugin`);
}

function extractBalancedCallSiteLocation(trimmedLine: string): string | undefined {
  if (!trimmedLine.endsWith(")")) return undefined;
  let depth = 0;
  for (let i = trimmedLine.length - 1; i >= 0; i -= 1) {
    const ch = trimmedLine[i];
    if (ch === ")") {
      depth += 1;
    } else if (ch === "(") {
      depth -= 1;
      if (depth === 0) {
        const inner = trimmedLine.slice(i + 1, -1).trim();
        return inner !== "" ? inner : undefined;
      }
    }
  }
  return undefined;
}

function addNormalizedLocationKey(rawToken: string, keys: Set<string>): void {
  const trimmed = rawToken.trim().replace(/^['"`]+|[,;'"`]+$/g, "");
  if (trimmed === "") return;
  const withoutLineCol = trimmed.replace(/(?::\d+){1,2}$/, "");
  if (/^file:\/\//i.test(withoutLineCol)) {
    try {
      keys.add(pathComparisonKey(fileURLToPath(new URL(withoutLineCol))));
    } catch {
      // Ignore malformed file URLs in arbitrary user error strings.
    }
    return;
  }
  const withoutQuery = withoutLineCol.split(/[?#]/, 1)[0] ?? withoutLineCol;
  if (/^[a-zA-Z]:[\\/]/.test(withoutQuery) && withoutQuery.length > 3) {
    keys.add(pathComparisonKey(withoutQuery));
  } else if (withoutQuery.startsWith("/") && !withoutQuery.startsWith("//") && withoutQuery.length > 1) {
    keys.add(pathComparisonKey(withoutQuery));
  }
}

export function extractStackFrameComparisonKeys(stackText: string): string[] {
  const keys = new Set<string>();
  for (const rawLine of stackText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const parenLoc = extractBalancedCallSiteLocation(line);
    if (parenLoc !== undefined) {
      addNormalizedLocationKey(parenLoc, keys);
    }
    const atMatch = /^at\s+(?:async\s+)?(.+)$/.exec(line);
    if (atMatch?.[1] !== undefined && !atMatch[1].endsWith(")")) {
      addNormalizedLocationKey(atMatch[1], keys);
    }
    const jscAtIdx = line.indexOf("@");
    if (jscAtIdx >= 0 && jscAtIdx + 1 < line.length) {
      addNormalizedLocationKey(line.slice(jscAtIdx + 1), keys);
    }
  }
  for (const match of stackText.matchAll(/file:\/\/\/[^\s"'`<>|]+/gi)) {
    const token = match[0].replace(/\)+$/, "");
    addNormalizedLocationKey(token, keys);
  }
  return [...keys];
}
