import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { PROTOCOL_VERSION } from "@pid/protocol";
import { createHost } from "../src/index.ts";

const options = { version: "0.0.0-test", dataDir: "/tmp/pid-test" };

describe("createHost", () => {
  it("provides hostInfo before the plugins load", async () => {
    let seen: { version: string; protocolVersion: string } | undefined;
    const probe = Object.assign((ctx: Context) => {
      seen = { version: ctx.hostInfo.version, protocolVersion: ctx.hostInfo.protocolVersion };
    }, { inject: ["hostInfo"] });

    const host = createHost({ ...options, plugins: [[probe]] });
    await host.start();
    expect(seen).toEqual({ version: "0.0.0-test", protocolVersion: PROTOCOL_VERSION });
    await host.stop();
  });

  it("passes each plugin its config, in order", async () => {
    const order: string[] = [];
    const plugin = (_ctx: Context, config: { label: string }) => {
      order.push(config.label);
    };
    const other = (_ctx: Context, config: { label: string }) => {
      order.push(config.label);
    };
    const host = createHost({ ...options, plugins: [[plugin, { label: "a" }], [other, { label: "b" }]] });
    await host.start();
    expect(order).toEqual(["a", "b"]);
    await host.stop();
  });

  it("unwinds plugin effects and listeners on stop", async () => {
    const log: string[] = [];
    const plugin = (ctx: Context) => {
      ctx.effect(() => {
        log.push("up");
        return () => log.push("down");
      });
    };
    const host = createHost({ ...options, plugins: [[plugin]] });
    await host.start();
    expect(log).toEqual(["up"]);
    await host.stop();
    expect(log).toEqual(["up", "down"]);
  });

  it("refuses to start twice", async () => {
    const host = createHost(options);
    await host.start();
    await expect(host.start()).rejects.toThrow("already started");
    await host.stop();
  });
});
