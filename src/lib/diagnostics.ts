/** Settings › 调试: the log folder and the diagnostics bundle, from the Host (packages/host/src/diagnostics.ts). */
import { getVersion } from "@tauri-apps/api/app";
import { harnessRuntimes } from "./harnessRuntime";

/** `~/.pid/logs`, where the Host and the desktop write their logs. */
export async function logsDir(): Promise<string> {
  return (await harnessRuntimes.call<{ dir: string }>("diagnostics.logs")).dir;
}

/** Write the diagnostics zip to `path`; resolves to the files it holds. */
export async function exportDiagnostics(path: string): Promise<string[]> {
  const version = await getVersion().catch(() => "unknown");
  const result = await harnessRuntimes.call<{ files: string[] }>("diagnostics.export", { path, desktop: { version } });
  return result.files;
}
