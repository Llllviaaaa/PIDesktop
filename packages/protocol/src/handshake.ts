/**
 * Connection handshake (ADR 0002). Browsers cannot set headers on a WebSocket,
 * so the token rides in `Sec-WebSocket-Protocol` next to the protocol name and
 * the server echoes only the protocol name back.
 */

export const SUBPROTOCOL = "pid.v1";
const TOKEN_PREFIX = "pid.token.";

/** The token is base64url, which is all valid subprotocol token characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

export function clientSubprotocols(token: string): string[] {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Harness token must be 16 to 256 base64url characters");
  return [SUBPROTOCOL, `${TOKEN_PREFIX}${token}`];
}

export interface OfferedSubprotocols {
  speaksProtocol: boolean;
  token: string | undefined;
}

/** Read a `Sec-WebSocket-Protocol` request header as the server sees it. */
export function readOfferedSubprotocols(header: string | undefined): OfferedSubprotocols {
  const offered = (header ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
  const tokens = offered.filter((item) => item.startsWith(TOKEN_PREFIX)).map((item) => item.slice(TOKEN_PREFIX.length));
  return {
    speaksProtocol: offered.includes(SUBPROTOCOL),
    token: tokens.length === 1 && TOKEN_PATTERN.test(tokens[0]) ? tokens[0] : undefined,
  };
}

export interface InitializeParams {
  protocolVersion: string;
  client: { name: string; version: string };
}

export interface InitializeResult {
  protocolVersion: string;
  host: { version: string };
  /** Method names this host answers, so a client can tell what a minor version added. */
  capabilities: { methods: string[] };
}
