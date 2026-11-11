/** Executable entry: what scripts/prepare-harness-host.mjs bundles into qianji-harness.exe. */
import { join } from "node:path";
import { extractDataDirFromArgv, writeHostCrashEntrySync } from "./crash-guard.ts";
import { main } from "./main.ts";

const argv = process.argv.slice(2);
main(argv).catch((error: unknown) => {
  const dataDir = extractDataDirFromArgv(argv);
  const formatted = writeHostCrashEntrySync(
    dataDir === undefined ? undefined : join(dataDir, "logs"),
    "startupFailure",
    error,
  );
  process.stderr.write(`[harness] failed to start: ${formatted}\n`);
  process.exit(1);
});
