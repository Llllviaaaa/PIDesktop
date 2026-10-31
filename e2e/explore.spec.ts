import { writeFileSync } from "node:fs";
import { test } from "./fixtures.ts";

// Not part of the suite: PID_E2E_EXPLORE=<file> keeps a Host up for poking at
// the page by hand, and writes the page's URL to that file.
test("explore", async ({ harness }) => {
  const out = process.env.PID_E2E_EXPLORE;
  test.skip(!out, "manual only");
  test.setTimeout(0);
  harness.provider.push(...Array.from({ length: 20 }, () => [
    { type: "text-delta" as const, index: 0, text: "Scripted reply." },
    { type: "finish" as const, reason: "stop" as const },
  ]));
  const token = (harness as unknown as { token: string }).token;
  const query = new URLSearchParams({ host: harness.host.baseUrl, token, workspace: harness.workspace });
  writeFileSync(out as string, `http://127.0.0.1:4173/?${query}\n`);
  await new Promise(() => undefined);
});
