import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCode, PROTOCOL_VERSION } from "@pid/protocol";
import { RpcGateway, WebServer, createHost, type Host } from "@pid/host";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { HarnessRpcError, connectHarness, rpcUrl } = await import("../src/lib/harnessClient.ts");

const token = Buffer.alloc(32, 3).toString("base64url");
let host: Host | undefined;

afterEach(async () => {
  await host?.stop();
  host = undefined;
});

async function startHost(): Promise<string> {
  host = createHost({
    version: "1.2.3",
    dataDir: "unused",
    plugins: [
      [WebServer, { pageOrigins: [] }],
      [RpcGateway, { token }],
    ],
  });
  await host.start();
  return `http://127.0.0.1:${await host.ctx.webServer.listen(0)}/`;
}

describe("harnessClient", () => {
  it("derives the RPC URL from the host base", () => {
    expect(rpcUrl("http://127.0.0.1:1234/")).toBe("ws://127.0.0.1:1234/rpc");
    expect(rpcUrl("https://example.test/base/")).toBe("wss://example.test/base/rpc");
  });

  it("initializes, calls methods and receives notifications", async () => {
    const baseUrl = await startHost();
    const connection = await connectHarness({ baseUrl, token }, { name: "test", version: "0" });
    expect(connection.host).toMatchObject({ protocolVersion: PROTOCOL_VERSION, host: { version: "1.2.3" } });
    expect(await connection.call("host.info")).toMatchObject({ version: "1.2.3" });

    const seen: unknown[] = [];
    const unsubscribe = connection.onNotification((method, params) => seen.push({ method, params }));
    host?.ctx.rpc.broadcast("session/event", { seq: 4 });
    await connection.call("host.ping");
    expect(seen).toEqual([{ method: "session/event", params: { seq: 4 } }]);
    unsubscribe();

    const failure = await connection.call("no.such.method").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HarnessRpcError);
    expect((failure as InstanceType<typeof HarnessRpcError>).code).toBe(ErrorCode.MethodNotFound);
    connection.close();
  });

  // A short timeout: a refusal the client never notices should fail here, not hang the suite.
  it("rejects when the host refuses the token", { timeout: 10_000 }, async () => {
    const baseUrl = await startHost();
    await expect(connectHarness({ baseUrl, token: Buffer.alloc(32, 9).toString("base64url") }, { name: "t", version: "0" }))
      .rejects.toThrow("refused");
  });
});
