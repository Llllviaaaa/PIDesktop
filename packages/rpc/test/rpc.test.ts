import { describe, expect, it } from "vitest";
import { ErrorCode } from "@qianji/protocol";
import { RpcError } from "../src/index.ts";

describe("@qianji/rpc contract", () => {
  it("constructs structured RpcError instances with code, message, and optional data", () => {
    const err = new RpcError(ErrorCode.InvalidParams, "sessionId must be a string", { field: "sessionId" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RpcError);
    expect(err.name).toBe("RpcError");
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toBe("sessionId must be a string");
    expect(err.data).toEqual({ field: "sessionId" });
  });
});
