import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Tools, textOutput } from "@qianji/tools";
import * as toolOutput from "../src/index.ts";

let root: Context | undefined;
let temp: string | undefined;

afterEach(async () => {
  await root?.fiber.dispose();
  root = undefined;
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true });
  temp = undefined;
});

async function setup(config: toolOutput.Config): Promise<Context> {
  root = new Context();
  await root.plugin(Tools);
  await root.plugin(toolOutput, config);
  root.tools.register<{ size: number }>({
    name: "dump",
    description: "Return `size` characters",
    parameters: { type: "object", properties: { size: { type: "integer" } }, required: ["size"] },
    execute: ({ size }) => ({
      content: [{ type: "text", text: `${"h".repeat(size / 2)}${"t".repeat(size / 2)}` }, { type: "image", mimeType: "image/png", data: "AAAA" }],
      details: { kept: true },
    }),
  });
  return root;
}

const env = (signal = new AbortController().signal) => ({ sessionId: "s/1", cwd: "/work", signal });

describe("tool output limit (ADR 0019)", () => {
  it("passes output within the limit through untouched", async () => {
    const ctx = await setup({ maxChars: 1_000 });
    const output = await ctx.tools.execute({ id: "c1", name: "dump", args: { size: 1_000 } }, env());
    expect(output.content[0]).toEqual({ type: "text", text: `${"h".repeat(500)}${"t".repeat(500)}` });
  });

  it("keeps the start and end of oversized text and saves the full text", async () => {
    temp = mkdtempSync(join(tmpdir(), "qianji-spill-"));
    const ctx = await setup({ maxChars: 1_000, spillDir: temp });
    const output = await ctx.tools.execute({ id: "c2", name: "dump", args: { size: 10_000 } }, env());
    const [text, image] = output.content;
    expect(text?.type).toBe("text");
    const body = text?.type === "text" ? text.text : "";
    expect(body.startsWith("h".repeat(400))).toBe(true);
    expect(body.endsWith("t".repeat(400))).toBe(true);
    expect(body).toContain("[Output truncated: 10000 characters");
    expect(body.length).toBeLessThan(1_400);
    expect(image).toEqual({ type: "image", mimeType: "image/png", data: "AAAA" });
    expect(output.details).toEqual({ kept: true });

    const saved = join(temp, "s_1", "c2.txt");
    expect(body).toContain(saved);
    expect(readFileSync(saved, "utf8")).toHaveLength(10_000);
  });

  it("still cuts the output when it cannot be saved", () => {
    const limited = toolOutput.limitOutput(textOutput("x".repeat(5_000)), 1_000, () => undefined);
    const first = limited.content[0];
    expect(first?.type === "text" ? first.text : "").toContain("could not be saved");
  });

  it("removes session folders past the retention period", () => {
    temp = mkdtempSync(join(tmpdir(), "qianji-spill-"));
    mkdirSync(join(temp, "old"));
    mkdirSync(join(temp, "new"));
    const longAgo = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(join(temp, "old"), longAgo, longAgo);
    expect(toolOutput.pruneSpill(temp, Date.now() - 7 * 86_400_000)).toEqual(["old"]);
    expect(existsSync(join(temp, "old"))).toBe(false);
    expect(existsSync(join(temp, "new"))).toBe(true);
  });
});
