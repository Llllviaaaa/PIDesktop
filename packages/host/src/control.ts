/**
 * The desktop's control channel (ADR 0013): one JSON object per line on the
 * host's stdin, which only the desktop app holds.
 *
 * - `{"desktop": DesktopMessage}`: the desktop's settings changed (or the
 *   host just started). harness.json is rewritten from them, Pi's
 *   models.json is imported into providers.json the first time, the default
 *   model follows the desktop's, and the plugins reload.
 * - `{"reload": true}`: reload from the files as they are.
 *
 * Writing the files keeps a headless run or a restart on the same settings
 * the desktop last sent.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { harnessFromDesktop, type DesktopMessage } from "./desktop-settings.ts";
import { importPiModels } from "./pi-import.ts";
import { readSecretFile, writeSecretFile, type SecretCodec } from "./secrets.ts";

export type ControlCommand = { desktop: DesktopMessage } | { reload: true };

export function parseControlLine(line: string): ControlCommand | undefined {
  if (line.trim() === "") return undefined;
  const value = JSON.parse(line) as Record<string, unknown>;
  if (value.reload === true) return { reload: true };
  const desktop = value.desktop as DesktopMessage | undefined;
  if (typeof desktop === "object" && desktop !== null && typeof desktop.settings === "object" && typeof desktop.configDir === "string") return { desktop };
  throw new Error("unknown control command");
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Write what a desktop message says into `dataDir`; returns notes for the log. */
export function applyDesktopMessage(dataDir: string, message: DesktopMessage, codec: SecretCodec | undefined): string[] {
  const notes: string[] = [];
  const { config, defaultModel } = harnessFromDesktop(message);
  writeJson(join(dataDir, "harness.json"), config);

  const providersFile = join(dataDir, "providers.json");
  let providers = readJson(providersFile);
  if (providers === undefined) {
    providers = { providers: [] };
    const modelsFile = message.piAgentDir === undefined ? undefined : join(message.piAgentDir, "models.json");
    const models = modelsFile === undefined ? undefined : readJson(modelsFile);
    if (models !== undefined) {
      const imported = importPiModels(models);
      notes.push(...imported.problems.map((problem) => `Pi provider not imported: ${problem}`));
      const secretIds = Object.keys(imported.secrets);
      if (secretIds.length > 0 && codec === undefined) {
        // No DPAPI here: keep the providers, drop the keys rather than write them out.
        for (const entry of imported.providers) if (entry.apiKey !== undefined && "secret" in entry.apiKey) delete entry.apiKey;
        notes.push("Pi provider keys were not imported: no secret store is available on this platform");
      } else if (secretIds.length > 0 && codec !== undefined) {
        const file = join(dataDir, "secrets.dat");
        writeSecretFile(file, { ...readSecretFile<Record<string, string>>(file, codec), ...imported.secrets }, codec);
      }
      providers.providers = imported.providers;
      notes.push(`imported ${imported.providers.length} provider(s) from ${modelsFile}`);
    }
  }
  const current = providers.defaultModel as { provider?: unknown; model?: unknown } | undefined;
  if (defaultModel !== undefined && (current?.provider !== defaultModel.provider || current?.model !== defaultModel.model)) {
    providers.defaultModel = defaultModel;
  }
  if (!existsSync(providersFile) || JSON.stringify(readJson(providersFile)) !== JSON.stringify(providers)) writeJson(providersFile, providers);
  return notes;
}
