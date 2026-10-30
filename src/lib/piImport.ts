/**
 * Importing Pi's past tasks into the Harness Host (P6b, docs/REFACTOR_V2_P6.md
 * 3.2). The Host converts Pi's session files with `import.piSessions`; the
 * files themselves are only read.
 */
import type { PiImportParams, PiImportProgress, PiImportReport } from "@pid/protocol";
import { harnessRuntimes } from "./harnessRuntime";

/** The roots to scan: the desktop's Pi session directory when it set one, else the Host's default. */
function roots(sessionDir: string | undefined): Pick<PiImportParams, "roots"> {
  const dir = sessionDir?.trim();
  return dir ? { roots: [dir] } : {};
}

export const piImport = {
  /** How many Pi tasks are left to import, and whether the user was offered the import. */
  status: (sessionDir?: string) => harnessRuntimes.call<PiImportReport>("import.piSessions", { ...roots(sessionDir), dryRun: true }),
  /** Not now: the offer is not shown again; settings can still import. */
  dismiss: (sessionDir?: string) => harnessRuntimes.call<PiImportReport>("import.piSessions", { ...roots(sessionDir), dryRun: true, markPrompted: true }),
  async run(sessionDir: string | undefined, onProgress: (progress: PiImportProgress) => void): Promise<PiImportReport> {
    const stop = harnessRuntimes.onNotification("import/progress", (params) => onProgress(params as PiImportProgress));
    try {
      return await harnessRuntimes.call<PiImportReport>("import.piSessions", { ...roots(sessionDir), markPrompted: true });
    } finally {
      stop();
    }
  },
};

/** One line on how an import went. */
export function describeImport(report: PiImportReport): string {
  const parts = [`已导入 ${report.imported} 个任务`];
  if (report.skipped > 0) parts.push(`跳过 ${report.skipped} 个（已导入或为空）`);
  if (report.failed > 0) parts.push(`${report.failed} 个无法读取`);
  return parts.join("，");
}
