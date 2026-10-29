// The Host's table of Pi's built-in providers (packages/host/src/pi-builtins.ts)
// against Pi's own model catalog, while Pi is still installed (until P6).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_BUILTINS, PI_BUILTIN_OVERRIDES } from "../packages/host/src/pi-builtins";

const catalogFile = join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-ai", "dist", "models.generated.js");
const PI_API = { "openai-compat": "openai-completions", anthropic: "anthropic-messages" } as const;

describe.skipIf(!existsSync(catalogFile))("Pi built-in providers", () => {
  it("match an endpoint in Pi's catalog", async () => {
    const catalog = (await import(/* @vite-ignore */ pathToFileURL(catalogFile).href)) as { MODELS: Record<string, Record<string, { api: string; baseUrl: string }>> };
    for (const [id, builtin] of Object.entries(PI_BUILTINS)) {
      const models = Object.values(catalog.MODELS[id] ?? {});
      expect(models.length, `${id} is in Pi's catalog`).toBeGreaterThan(0);
      if (PI_BUILTIN_OVERRIDES.has(id)) continue;
      expect(models.some((model) => model.api === PI_API[builtin.api] && model.baseUrl === builtin.baseUrl), `${id} → ${builtin.baseUrl}`).toBe(true);
    }
  });
});
