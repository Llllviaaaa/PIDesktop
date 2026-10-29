import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { Ui, type PendingUiRequest } from "../src/index.ts";

async function setup() {
  const ctx = new Context();
  await ctx.plugin(Ui);
  const shown: PendingUiRequest[] = [];
  const cancelled: string[] = [];
  const notes: string[] = [];
  return {
    ctx,
    shown,
    cancelled,
    notes,
    attach: () => ctx.ui.attach({
      request: (pending) => void shown.push(pending),
      cancel: (id) => void cancelled.push(id),
      notify: (_session, message, level) => void notes.push(`${level}:${message}`),
    }),
  };
}

describe("ui service", () => {
  it("answers nothing without a transport", async () => {
    const { ctx } = await setup();
    expect(ctx.ui.available).toBe(false);
    expect(await ctx.ui.confirm("s", "Allow?", "rm -rf")).toBe(false);
    expect(await ctx.ui.input(undefined, "Name?")).toBeUndefined();
  });

  it("delivers requests and resolves them with the response", async () => {
    const { ctx, shown, attach } = await setup();
    attach();
    const confirmed = ctx.ui.confirm("s1", "Allow?", "git push");
    const picked = ctx.ui.select(undefined, "Pick", ["a", "b"]);
    expect(shown.map(({ requestId, sessionId, request }) => [requestId, sessionId, request.kind])).toEqual([["ui-1", "s1", "confirm"], ["ui-2", undefined, "select"]]);
    expect(ctx.ui.pending()).toHaveLength(2);
    expect(ctx.ui.respond("ui-1", true)).toBe(true);
    expect(ctx.ui.respond("ui-1", true)).toBe(false);
    ctx.ui.respond("ui-2", "c");
    expect(await confirmed).toBe(true);
    expect(await picked).toBeUndefined();
    expect(ctx.ui.pending()).toEqual([]);
  });

  it("cancels on abort and when the transport goes away", async () => {
    const { ctx, cancelled, attach } = await setup();
    const detach = attach();
    const controller = new AbortController();
    const aborted = ctx.ui.confirm("s", "A", "a", controller.signal);
    const orphaned = ctx.ui.input("s", "B");
    controller.abort();
    expect(await aborted).toBe(false);
    detach();
    expect(await orphaned).toBeUndefined();
    expect(cancelled).toEqual(["ui-1", "ui-2"]);
    expect(ctx.ui.available).toBe(false);
  });

  it("passes notifications through", async () => {
    const { ctx, notes, attach } = await setup();
    ctx.ui.notify("s", "lost");
    attach();
    ctx.ui.notify("s", "Hook failed", "error");
    expect(notes).toEqual(["error:Hook failed"]);
  });
});

describe("unattended sessions", () => {
  it("answer nothing for a session nobody watches", async () => {
    const { ctx, shown, attach } = await setup();
    attach();
    const done = ctx.ui.markUnattended("scheduled");
    expect(ctx.ui.canAsk("scheduled")).toBe(false);
    expect(ctx.ui.canAsk("other")).toBe(true);
    expect(await ctx.ui.confirm("scheduled", "Allow?", "x")).toBe(false);
    expect(shown).toEqual([]);
    done();
    expect(ctx.ui.canAsk("scheduled")).toBe(true);
  });
});
