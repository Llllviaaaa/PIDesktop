import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  clientSubprotocols,
  decodeMessage,
  failure,
  isCompatibleProtocol,
  isNotification,
  isRequest,
  isResponse,
  parseProtocolVersion,
  readOfferedSubprotocols,
  SUBPROTOCOL,
} from "../src/index.ts";

describe("protocol version", () => {
  it("parses major.minor only", () => {
    expect(parseProtocolVersion("1.0")).toEqual({ major: 1, minor: 0 });
    expect(parseProtocolVersion("12.34")).toEqual({ major: 12, minor: 34 });
    for (const bad of ["1", "1.0.0", "01.0", "v1.0", "", "1.x"]) {
      expect(parseProtocolVersion(bad)).toBeUndefined();
    }
  });

  it("accepts any minor of the same major", () => {
    expect(isCompatibleProtocol("1.7", "1.0")).toBe(true);
    expect(isCompatibleProtocol("2.0", "1.9")).toBe(false);
    expect(isCompatibleProtocol("garbage", "1.0")).toBe(false);
  });
});

describe("decodeMessage", () => {
  it("reads requests, notifications and responses", () => {
    const request = decodeMessage('{"jsonrpc":"2.0","id":1,"method":"host.ping","params":{}}');
    expect(request.ok && isRequest(request.message)).toBe(true);

    const notification = decodeMessage('{"jsonrpc":"2.0","method":"session/event","params":{"seq":1}}');
    expect(notification.ok && isNotification(notification.message)).toBe(true);

    const result = decodeMessage('{"jsonrpc":"2.0","id":"a","result":null}');
    expect(result.ok && isResponse(result.message)).toBe(true);

    const error = decodeMessage('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}');
    expect(error.ok && isResponse(error.message)).toBe(true);
  });

  it("reports parse errors without an id", () => {
    expect(decodeMessage("{nope")).toEqual({
      ok: false,
      id: null,
      error: { code: ErrorCode.ParseError, message: "Parse error" },
    });
  });

  it("keeps the id of an invalid request so it can be answered", () => {
    const decoded = decodeMessage('{"jsonrpc":"2.0","id":7,"method":"x","params":"oops"}');
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.id).toBe(7);
      expect(decoded.error.code).toBe(ErrorCode.InvalidRequest);
    }
  });

  it("rejects envelopes JSON-RPC 2.0 does not allow", () => {
    for (const bad of [
      "[]",
      '{"id":1,"method":"x"}',
      '{"jsonrpc":"1.0","id":1,"method":"x"}',
      '{"jsonrpc":"2.0","id":1,"method":""}',
      '{"jsonrpc":"2.0","id":{},"method":"x"}',
      '{"jsonrpc":"2.0","id":1}',
      '{"jsonrpc":"2.0","id":1,"result":1,"error":{"code":1,"message":"m"}}',
      '{"jsonrpc":"2.0","id":1,"error":{"code":"1","message":"m"}}',
      '{"jsonrpc":"2.0","id":null,"result":1}',
    ]) {
      expect(decodeMessage(bad).ok, bad).toBe(false);
    }
  });

  it("builds failures with optional data", () => {
    expect(failure(1, ErrorCode.SessionBusy, "busy")).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32011, message: "busy" } });
    expect(failure(null, ErrorCode.InternalError, "boom", { at: "x" }).error.data).toEqual({ at: "x" });
  });
});

describe("handshake subprotocols", () => {
  // Built at run time so the secret scanner does not read a literal as a credential.
  const sample = `${"ab".repeat(10)}_-09`;

  it("round-trips the token through the header", () => {
    const header = clientSubprotocols(sample).join(", ");
    expect(readOfferedSubprotocols(header)).toEqual({ speaksProtocol: true, token: sample });
  });

  it("refuses malformed or repeated tokens", () => {
    expect(() => clientSubprotocols("short")).toThrow();
    expect(readOfferedSubprotocols(`${SUBPROTOCOL}, pid.token.short`).token).toBeUndefined();
    expect(readOfferedSubprotocols(`${SUBPROTOCOL}, pid.token.${sample}, pid.token.${sample}`).token).toBeUndefined();
    expect(readOfferedSubprotocols(undefined)).toEqual({ speaksProtocol: false, token: undefined });
  });
});
