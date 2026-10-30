/**
 * Reloading the plugins that hold processes and timers (MCP servers, the
 * browser, computer control) again and again leaves nothing behind: each
 * reload replaces the tools, and disposing them ends the child processes and
 * clears the timers (docs/REFACTOR_V2_P7.md, 3.2).
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import * as browser from "@pid/browser";
import * as computer from "@pid/computer";
import { Mcp } from "@pid/mcp";
import { Sessions } from "@pid/session";
import { Tools } from "@pid/tools";
import { Ui } from "@pid/ui";
import { ReloadablePlugins } from "../src/reloadable.ts";

const fakeServer = fileURLToPath(new URL("../../mcp/test/fake-server.mjs", import.meta.url));
let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const timeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

async function eventually(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("reloading plugins", () => {
  it("leave no child processes, tools or timers behind", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-reload-leaks-"));
    const ctx = new Context();
    for (const service of [Sessions, Ui, Tools]) await ctx.plugin(service);
    const names = () => ctx.tools.schemas().map((schema) => schema.name);
    const baseTools = names();
    const baseTimeouts = timeouts();
    const reloadable = new ReloadablePlugins(ctx);

    const rounds = 5;
    for (let round = 0; round < rounds; round += 1) {
      // A changed config each round, so every plugin is disposed and loaded again.
      const changed = await reloadable.apply([
        {
          key: "mcp",
          plugin: Mcp,
          config: {
            servers: [{
              id: "fixture", name: "Fixture", enabled: true, transport: "stdio", command: process.execPath, args: [fakeServer],
              cwd: "", env: { FAKE_MCP_PIDS: dir, ROUND: String(round) }, inheritEnvironment: false, url: "", headers: {}, trustedReadOnly: false,
            }],
          },
        },
        { key: "browser", plugin: browser, config: { idleMinutes: round + 1 } },
        { key: "computer", plugin: computer, config: { confirmActions: round % 2 === 0 } },
      ]);
      expect(changed).toEqual(["mcp", "browser", "computer"]);
      await ctx.mcp.ready;
      const loaded = names();
      expect(new Set(loaded).size).toBe(loaded.length);
      expect(loaded).toContain("mcp__fixture__echo");
      expect(loaded.some((tool) => tool.startsWith("browser"))).toBe(true);
      expect(loaded.some((tool) => tool.startsWith("computer"))).toBe(true);
    }
    const pids = readdirSync(dir).map(Number);
    expect(pids).toHaveLength(rounds);
    // Each reload ended the server it replaced: only the current one runs.
    await eventually(() => pids.filter(alive).length === 1);

    await reloadable.dispose();
    expect(names()).toEqual(baseTools);
    await eventually(() => pids.every((pid) => !alive(pid)));
    await eventually(() => timeouts() <= baseTimeouts);
    await ctx.fiber.dispose();
  });
});
