import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { SystemPrompt } from "@pid/system-prompt";
import { Tools } from "@pid/tools";
import * as memory from "../src/index.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("local memory", () => {
  it("reads, appends, replaces and clears, and shows the memory to the model", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-memory-"));
    const file = join(dir, "nested", "memory.md");
    const ctx = new Context();
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(memory, { file });
    const env = { sessionId: "s", cwd: dir, signal: new AbortController().signal };
    const call = async (args: Record<string, unknown>) => {
      const output = await ctx.tools.execute({ id: "1", name: "desktop_memory", args }, env);
      return output.content[0]?.type === "text" ? output.content[0].text : "";
    };
    const prompt = () => ctx.systemPrompt.build({ sessionId: "s", cwd: dir, model: { provider: "p", model: "m" }, tools: [] });

    expect(await call({ action: "read" })).toBe("Local memory is empty.");
    expect(await prompt()).toBe("");
    await call({ action: "append", content: "Prefers pnpm." });
    await call({ action: "append", content: "Answers in Chinese." });
    expect(readFileSync(file, "utf8")).toBe("Prefers pnpm.\n\nAnswers in Chinese.\n");
    expect(await prompt()).toContain("<memory>\nPrefers pnpm.\n\nAnswers in Chinese.\n</memory>");
    await call({ action: "replace", content: "Only this." });
    expect(await call({ action: "read" })).toBe("Only this.\n");
    expect(await call({ action: "append" })).toBe("desktop_memory failed: content is required for append");
    await call({ action: "clear" });
    expect(readFileSync(file, "utf8")).toBe("");
    await ctx.fiber.dispose();
  });
});
