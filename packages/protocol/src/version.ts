/** The protocol version this build speaks, as `major.minor` (ADR 0002). */
export const PROTOCOL_VERSION = "1.0";

export interface ProtocolVersion {
  major: number;
  minor: number;
}

export function parseProtocolVersion(value: string): ProtocolVersion | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Whether a peer speaking `remote` can talk to this build. Minor versions only
 * add, and both sides ignore what they do not know, so the majors decide.
 */
export function isCompatibleProtocol(remote: string, local: string = PROTOCOL_VERSION): boolean {
  const a = parseProtocolVersion(remote);
  const b = parseProtocolVersion(local);
  return a !== undefined && b !== undefined && a.major === b.major;
}
