/**
 * A loopback HTTP server that plays a provider for adapter tests: each request
 * is recorded and answered by the next scripted reply.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync } from "node:fs";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export type Reply =
  | { sse: string }
  | { status: number; json?: unknown; headers?: Record<string, string> };

export interface FakeProvider {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Queue replies, answered in order; a request with none queued gets 500. */
  reply(...replies: Reply[]): void;
  close(): Promise<void>;
}

export function sseFixture(url: URL): string {
  return readFileSync(url, "utf8");
}

export async function startFakeProvider(): Promise<FakeProvider> {
  const requests: RecordedRequest[] = [];
  const queue: Reply[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: text === "" ? undefined : JSON.parse(text) });
      const reply = queue.shift();
      if (reply === undefined) {
        res.writeHead(500).end();
      } else if ("sse" in reply) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Odd-sized writes so events straddle chunk boundaries, as on a real network.
        const bytes = Buffer.from(reply.sse);
        for (let offset = 0; offset < bytes.length; offset += 37) res.write(bytes.subarray(offset, offset + 37));
        res.end();
      } else {
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(reply.json === undefined ? "" : JSON.stringify(reply.json));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    reply: (...replies) => void queue.push(...replies),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
