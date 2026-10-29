/**
 * Secrets at rest (ADR 0013): JSON objects encrypted with Windows DPAPI for
 * the current user, the format the desktop's Rust `secret_store` writes
 * (`CryptProtectData` over the JSON bytes, no entropy). The host reads and
 * writes them itself through Bun's FFI, so keys never pass through the
 * environment or a child process.
 *
 * - `<dataDir>/secrets.dat`: `{ "<id>": "<key>" }`, what `{ secret: id }`
 *   refs in providers.json resolve against.
 * - The desktop's `mcp-secrets.dat`: `{ "<serverId>": { env, headers } }`,
 *   merged into MCP server configs in memory, never written to harness.json.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SecretCodec {
  protect(plaintext: Buffer): Buffer;
  unprotect(protectedData: Buffer): Buffer;
}

/** The part of `bun:ffi` used here (bun-types is not a dependency). */
interface BunFfi {
  dlopen<Names extends string>(library: string, symbols: Record<Names, { args: number[]; returns: number }>): {
    symbols: Record<Names, (...args: Array<number | null>) => number>;
  };
  FFIType: { ptr: number; u32: number; i32: number };
  ptr(view: ArrayBufferView): number;
  toArrayBuffer(address: number, byteOffset: number, byteLength: number): ArrayBuffer;
}

/** DPAPI through `bun:ffi`; undefined outside Bun on Windows (Node tests, other platforms). */
export async function dpapiCodec(): Promise<SecretCodec | undefined> {
  if (process.platform !== "win32" || typeof (process.versions as Record<string, string | undefined>).bun !== "string") return undefined;
  // A variable specifier keeps bundlers and Node from resolving the Bun-only module.
  const specifier = "bun:ffi";
  const ffi = (await import(specifier)) as BunFfi;
  const { dlopen, FFIType, ptr, toArrayBuffer } = ffi;
  const crypt32 = dlopen("crypt32.dll", {
    CryptProtectData: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    CryptUnprotectData: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
  const kernel32 = dlopen("kernel32.dll", {
    LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

  /** DATA_BLOB on x64: DWORD cbData, 4 bytes padding, BYTE* pbData. */
  const run = (fn: "CryptProtectData" | "CryptUnprotectData", input: Buffer): Buffer => {
    const data = input.length > 0 ? input : Buffer.alloc(1);
    const inBlob = Buffer.alloc(16);
    inBlob.writeUInt32LE(input.length, 0);
    inBlob.writeBigUInt64LE(BigInt(ptr(data)), 8);
    const outBlob = Buffer.alloc(16);
    const ok = crypt32.symbols[fn](ptr(inBlob), null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, ptr(outBlob));
    if (ok === 0) throw new Error(`Windows could not ${fn === "CryptProtectData" ? "protect" : "unlock"} credentials (${kernel32.symbols.GetLastError()})`);
    const length = outBlob.readUInt32LE(0);
    const address = Number(outBlob.readBigUInt64LE(8));
    try {
      return Buffer.from(new Uint8Array(toArrayBuffer(address, 0, length)));
    } finally {
      kernel32.symbols.LocalFree(address);
    }
  };
  return {
    protect: (plaintext) => run("CryptProtectData", plaintext),
    unprotect: (protectedData) => run("CryptUnprotectData", protectedData),
  };
}

/** Read an encrypted JSON object; `{}` when the file does not exist. */
export function readSecretFile<T extends object>(file: string, codec: SecretCodec): T {
  if (!existsSync(file)) return {} as T;
  const plaintext = codec.unprotect(readFileSync(file));
  try {
    return JSON.parse(plaintext.toString("utf8")) as T;
  } finally {
    plaintext.fill(0);
  }
}

export function writeSecretFile(file: string, value: object, codec: SecretCodec): void {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, codec.protect(plaintext), { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    plaintext.fill(0);
  }
}

/** The `{ secret: id }` store over `secrets.dat`, read on each lookup so edits apply at once. */
export function fileSecretResolver(file: string, codec: SecretCodec): (id: string) => Promise<string | undefined> {
  return async (id) => {
    const value = readSecretFile<Record<string, unknown>>(file, codec)[id];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
}

export interface McpServerSecrets {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}
