import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_SETTINGS_FIELD_NAMES, DEFAULT_APP_SETTINGS } from "@qianji/protocol";
import { harnessFromDesktop } from "../packages/host/src/desktop-settings";
import { DEFAULTS } from "../src/components/SettingsModal";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function snakeToCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_match, ch: string) => ch.toUpperCase());
}

function parseRustAppSettingsFields(rustSource: string): string[] {
  const structMatch = /pub\(crate\)\s+struct\s+AppSettings\s*\{([\s\S]*?)\n\}/.exec(rustSource);
  if (!structMatch?.[1]) {
    throw new Error("Could not locate `pub(crate) struct AppSettings` in src-tauri/src/config.rs");
  }
  const fields: string[] = [];
  for (const rawLine of structMatch[1].split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("#[")) continue;
    const fieldMatch = /^pub(?:\(crate\))?\s+([a-z0-9_]+)\s*:/.exec(trimmed);
    if (fieldMatch?.[1]) {
      fields.push(snakeToCamel(fieldMatch[1]));
    }
  }
  return fields;
}

describe("Phase 4.1: Tri-end AppSettings contract alignment", () => {
  it("keeps Rust src-tauri/src/config.rs, @qianji/protocol DEFAULT_APP_SETTINGS, and SettingsModal DEFAULTS in 1-to-1 parity", () => {
    const rustConfig = readFileSync(join(repoRoot, "src-tauri", "src", "config.rs"), "utf8");
    const rustCamelFields = parseRustAppSettingsFields(rustConfig).sort();
    const protocolFields = [...APP_SETTINGS_FIELD_NAMES].sort();
    const modalFields = Object.keys(DEFAULTS).sort();

    expect(rustCamelFields).toEqual(protocolFields);
    expect(modalFields).toEqual(protocolFields);
    expect(DEFAULTS).toEqual(DEFAULT_APP_SETTINGS);
    expect(DEFAULT_APP_SETTINGS.intelligentUiEnabled).toBe(true);
  });

  it("maps intelligentUiEnabled and core capability toggles cleanly through harnessFromDesktop", () => {
    const enabled = harnessFromDesktop({
      settings: { ...DEFAULT_APP_SETTINGS, intelligentUiEnabled: true, sandboxEnabled: false },
      configDir: "D:/tmp/qianji-cfg",
    });
    expect(enabled.config.intelligentUi.enabled).toBe(true);
    expect(enabled.config.sandbox.enabled).toBe(false);

    const disabled = harnessFromDesktop({
      settings: { ...DEFAULT_APP_SETTINGS, intelligentUiEnabled: false, sandboxEnabled: true },
      configDir: "D:/tmp/qianji-cfg",
    });
    expect(disabled.config.intelligentUi.enabled).toBe(false);
    expect(disabled.config.sandbox.enabled).toBe(true);
  });
});
