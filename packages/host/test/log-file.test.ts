import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { logFileExporter, pruneLogs } from "../src/log-file.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the Host's log file", () => {
  it("writes redacted lines, debug included, to one file a day", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-logs-"));
    let now = new Date(2026, 9, 30, 23, 59);
    const exporter = logFileExporter(dir, { now: () => now });
    const ctx = new Context();
    ctx.logger.exporter(exporter);
    const logger = ctx.logger("rpc");

    logger.debug("%s %s ok %dms", "1", "session.get", 3);
    // Built here, so the repository's secret scan does not take it for a key.
    const key = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz"].join("-");
    logger.error(`key ${key} leaked, token=hunter2`);
    now = new Date(2026, 9, 31, 0, 1);
    logger.info("next day");
    await exporter.close();

    expect(readdirSync(dir).sort()).toEqual(["host-2026-10-30.log", "host-2026-10-31.log"]);
    const first = readFileSync(join(dir, "host-2026-10-30.log"), "utf8").trim().split("\n");
    expect(first).toHaveLength(2);
    expect(first[0]).toMatch(/ debug \[rpc\] 1 session\.get ok 3ms$/);
    expect(first[1]).toContain("[REDACTED]");
    expect(first[1]).not.toContain(key);
    expect(first[1]).not.toContain("hunter2");
    expect(readFileSync(join(dir, "host-2026-10-31.log"), "utf8")).toMatch(/ info {2}\[rpc\] next day\n$/);
  });

  it("keeps a week of files and leaves other files alone", () => {
    dir = mkdtempSync(join(tmpdir(), "pid-logs-"));
    for (const name of ["host-2026-10-23.log", "host-2026-10-24.log", "host-2026-10-30.log", "desktop-2026-10-01.log", "notes.txt"]) {
      writeFileSync(join(dir, name), "");
    }
    expect(pruneLogs(dir, "host", 7, new Date(2026, 9, 30, 12))).toEqual(["host-2026-10-23.log"]);
    expect(existsSync(join(dir, "host-2026-10-24.log"))).toBe(true);
    expect(existsSync(join(dir, "desktop-2026-10-01.log"))).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });
});
