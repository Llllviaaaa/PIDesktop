/**
 * Settings › 调试 (docs/REFACTOR_V2_P7.md, 3.3): where the logs are, and a
 * diagnostics bundle the user saves and can attach to a report. The bundle is
 * a zip of the last week's logs (the Host's and the desktop's, both in
 * `<dataDir>/logs`), the versions involved, and `harness.json`; every file in
 * it is redacted again on the way in.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { isAbsolute, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Context } from "@deepseek-ai/cordis";
import { ErrorCode, redactSensitiveText } from "@pid/protocol";
import { RpcError } from "./rpc.ts";

export const name = "pid-diagnostics";
export const inject = ["rpc", "hostInfo"];

export interface DiagnosticsLogsResult {
  dir: string;
}

export interface DiagnosticsExportResult {
  path: string;
  files: string[];
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip archive of `entries`, each deflated, dated `now`. */
export function zip(entries: readonly ZipEntry[], now = new Date()): Buffer {
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const packed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const redacted = (text: string): Buffer => Buffer.from(redactSensitiveText(text), "utf8");

/** What goes in the bundle: logs, versions and config, all redacted. */
export function diagnosticsEntries(dataDir: string, about: Record<string, unknown>): ZipEntry[] {
  const entries: ZipEntry[] = [{ name: "about.json", data: redacted(`${JSON.stringify(about, null, 2)}\n`) }];
  const config = join(dataDir, "harness.json");
  if (existsSync(config)) entries.push({ name: "harness.json", data: redacted(readFileSync(config, "utf8")) });
  const logs = join(dataDir, "logs");
  if (existsSync(logs)) {
    for (const file of readdirSync(logs).filter((name) => name.endsWith(".log")).sort()) {
      entries.push({ name: `logs/${file}`, data: redacted(readFileSync(join(logs, file), "utf8")) });
    }
  }
  return entries;
}

export function apply(ctx: Context): void {
  const logsDir = () => join(ctx.hostInfo.dataDir, "logs");

  ctx.effect(() => ctx.rpc.method("diagnostics.logs", (): DiagnosticsLogsResult => ({ dir: logsDir() })), "diagnostics.logs");

  ctx.effect(() => ctx.rpc.method("diagnostics.export", (params): DiagnosticsExportResult => {
    const { path, desktop } = (params ?? {}) as { path?: unknown; desktop?: unknown };
    if (typeof path !== "string" || !isAbsolute(path)) throw new RpcError(ErrorCode.InvalidParams, "diagnostics.export needs an absolute path");
    const about = {
      createdAt: new Date().toISOString(),
      host: { version: ctx.hostInfo.version, protocolVersion: ctx.hostInfo.protocolVersion, startedAt: ctx.hostInfo.startedAt.toISOString() },
      ...(typeof desktop === "object" && desktop !== null ? { desktop } : {}),
      runtime: { platform: platform(), release: release(), arch: arch(), versions: process.versions },
    };
    const entries = diagnosticsEntries(ctx.hostInfo.dataDir, about);
    writeFileSync(path, zip(entries));
    return { path, files: entries.map((entry) => entry.name) };
  }), "diagnostics.export");
}
