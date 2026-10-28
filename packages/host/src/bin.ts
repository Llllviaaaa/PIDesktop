/** Executable entry: what scripts/prepare-harness-host.mjs bundles into pid-harness.exe. */
import { main } from "./main.ts";

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`[harness] failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
