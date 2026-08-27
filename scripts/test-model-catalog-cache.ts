import {
  parseModelCatalogCache,
  persistModelCatalog,
  readStoredModelCatalog,
} from "../src/lib/modelCatalogCache.ts";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const selected = { id: "gpt-test", name: "GPT Test", provider: "openai", reasoning: true };
const parsed = parseModelCatalogCache({
  models: [selected, null, { id: "", name: "Invalid", provider: "openai" }],
  selected,
});
assert(parsed.models.length === 1, "invalid cached models must be discarded");
assert(parsed.selected?.id === selected.id, "the selected model must survive cache parsing");

const invalid = parseModelCatalogCache({ models: "broken", selected: { id: "missing-provider", name: "Broken" } });
assert(invalid.models.length === 0, "a malformed model list must fail closed");
assert(invalid.selected === null, "a malformed selected model must fail closed");

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  },
});
persistModelCatalog({ models: [selected], selected });
const stored = readStoredModelCatalog();
assert(stored.models[0]?.id === selected.id, "persisted model lists must be available on the next startup");
assert(stored.selected?.id === selected.id, "the selected model must be available on the next startup");

console.log("model catalog cache tests passed");
