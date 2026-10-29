import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "@pid/agent-loop";
import { LlmService } from "@pid/llm";
import { Sessions } from "@pid/session";
import { SystemPrompt } from "@pid/system-prompt";
import { ScriptedProvider, textReply, toolReply, useScriptedProvider } from "@pid/testkit";
import { Tools, textOutput } from "@pid/tools";
import { Ui } from "@pid/ui";
import { Schedule, nextScheduledRun, validateTask, type Config } from "../src/index.ts";

let dir = "";
let ctx: Context | undefined;
afterEach(async () => {
  await ctx?.fiber.dispose();
  ctx = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("next run", () => {
  // 2026-10-28 is a Wednesday.
  const wednesday10 = at(2026, 10, 28, 10, 0);
  it.each([
    ["hourly", { hour: 0, minute: 15 }, at(2026, 10, 28, 10, 15)],
    ["hourly", { hour: 0, minute: 0 }, at(2026, 10, 28, 11, 0)],
    ["daily", { hour: 9, minute: 15 }, at(2026, 10, 29, 9, 15)],
    ["daily", { hour: 11, minute: 0 }, at(2026, 10, 28, 11, 0)],
    ["weekly", { hour: 9, minute: 0, weekday: 3 }, at(2026, 11, 4, 9, 0)],
    ["weekly", { hour: 9, minute: 0, weekday: 5 }, at(2026, 10, 30, 9, 0)],
  ] as const)("%s %o", (frequency, time, expected) => {
    expect(nextScheduledRun({ frequency, weekday: 1, ...time }, wednesday10)).toBe(expected);
  });

  it("skips weekends for weekdays", () => {
    expect(nextScheduledRun({ frequency: "weekdays", hour: 9, minute: 0, weekday: 1 }, at(2026, 10, 30, 10, 0))).toBe(at(2026, 11, 2, 9, 0));
  });

  it("validates tasks and keeps unattended runs away from full access", () => {
    const base = { id: "t", name: "Nightly", prompt: "check", cwd: "/w", frequency: "daily" as const, hour: 2, minute: 30 };
    expect(validateTask(base)).toMatchObject({ permissionMode: "ask", enabled: true, weekday: 1 });
    expect(() => validateTask({ ...base, permissionMode: "full-access" as never })).toThrow("permissionMode");
    expect(() => validateTask({ ...base, hour: 24 })).toThrow("hour");
    expect(() => validateTask({ ...base, prompt: " " })).toThrow("prompt is required");
  });
});

async function setup(replies: Array<ReturnType<typeof textReply>>, config: Partial<Config> = {}, now = () => at(2026, 10, 28, 10, 0)) {
  dir = dir || mkdtempSync(join(tmpdir(), "pid-schedule-"));
  ctx = new Context();
  await ctx.plugin(LlmService, { maxAttempts: 1 });
  await ctx.plugin(Sessions);
  await ctx.plugin(Ui);
  await ctx.plugin(Tools);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(AgentLoop);
  const provider = new ScriptedProvider(replies);
  useScriptedProvider(ctx, provider);
  // A UI is attached (the desktop is open), yet scheduled runs must not ask it.
  const asked: string[] = [];
  ctx.ui.attach({ request: ({ request }) => void asked.push(request.kind), cancel: () => {}, notify: () => {} });
  ctx.tools.register({
    name: "ask",
    description: "",
    parameters: { type: "object" },
    execute: async (_args, env) => textOutput((await ctx?.ui.confirm(env.sessionId, "Allow?", "x", env.signal)) ? "yes" : "no answer"),
  });
  await ctx.plugin(Schedule, {
    tasksFile: join(dir, "schedules.json"),
    runsFile: join(dir, "schedule-runs.jsonl"),
    defaultModel: { provider: "scripted", model: "m" },
    tickMs: 60_000,
    now,
    ...config,
  });
  return { ctx, provider, asked };
}

const task = () => ({ id: "t1", name: "Report", prompt: "write the report", cwd: dir, frequency: "daily" as const, hour: 9, minute: 0 });

describe("schedule service", () => {
  it("runs a task as an unattended session and records the run", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-schedule-"));
    const { ctx: c, asked } = await setup([toolReply([{ id: "c1", name: "ask", args: {} }]), textReply("Report done.")]);
    const saved = c.schedule.save(task());
    expect(saved.nextRunAt).toBe(at(2026, 10, 29, 9, 0));

    const run = await c.schedule.run("t1", "manual");
    expect(run).toMatchObject({ taskId: "t1", status: "success", output: "Report done.", trigger: "manual" });
    expect(asked).toEqual([]);
    const session = await c.sessions.get(run.sessionId ?? "");
    expect(session?.events.find((event) => event.type === "tool-result")?.data).toMatchObject({ content: [{ type: "text", text: "no answer" }] });
    expect(session?.summary().title).toBe("Report（定时）");
    expect(c.schedule.list()[0]).toMatchObject({ lastStatus: "success", lastMessage: "Report done." });
    expect(c.schedule.runs("t1").map((item) => item.status)).toEqual(["success"]);
    expect(JSON.parse(readFileSync(join(dir, "schedules.json"), "utf8"))[0].id).toBe("t1");
  });

  it("fires due tasks on tick and moves their next run", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-schedule-"));
    let now = at(2026, 10, 28, 8, 0);
    const { ctx: c } = await setup([textReply("ok")], {}, () => now);
    c.schedule.save(task());
    now = at(2026, 10, 28, 9, 0);
    c.schedule.tick();
    expect(c.schedule.isRunning("t1")).toBe(true);
    await expect.poll(() => c.schedule.list()[0]?.lastStatus).toBe("success");
    expect(c.schedule.list()[0]?.nextRunAt).toBe(at(2026, 10, 29, 9, 0));
  });

  it("reports errors, cancellation and refuses overlapping runs", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-schedule-"));
    const { ctx: c } = await setup([[{ type: "finish", reason: "error", error: { kind: "auth", message: "bad key", retryable: false } }]]);
    c.schedule.save(task());
    expect(await c.schedule.run("t1", "manual")).toMatchObject({ status: "error", output: "bad key" });

    c.schedule.save({ ...task(), id: "t2", cwd: join(dir, "missing") });
    expect(await c.schedule.run("t2", "manual")).toMatchObject({ status: "error", output: expect.stringContaining("does not exist") });
    await expect(c.schedule.run("nope", "manual")).rejects.toThrow("not found");
  });

  it("marks runs interrupted by a restart", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-schedule-"));
    writeFileSync(join(dir, "schedules.json"), JSON.stringify([{ ...task(), permissionMode: "ask", weekday: 1, enabled: true, lastStatus: "running", lastMessage: "" }]));
    writeFileSync(join(dir, "schedule-runs.jsonl"), `${JSON.stringify({ id: "r1", taskId: "t1", taskName: "Report", trigger: "scheduled", status: "running", startedAt: 1, output: "" })}\n`);
    const { ctx: c } = await setup([]);
    expect(c.schedule.list()[0]).toMatchObject({ lastStatus: "interrupted", nextRunAt: at(2026, 10, 29, 9, 0) });
    expect(c.schedule.runs()[0]).toMatchObject({ id: "r1", status: "interrupted" });
  });
});
