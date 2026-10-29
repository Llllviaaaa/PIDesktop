/**
 * Plugins that follow their configuration (ADR 0013). `apply` takes the
 * wanted plugins by key and only touches what changed: a plugin whose config
 * is the same keeps running (an MCP connection, an open browser), a changed
 * one is disposed and loaded again with its new config, and a key that is no
 * longer wanted is disposed. Sessions keep running throughout; a reloaded
 * plugin's tools and listeners are simply replaced.
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";

export interface ReloadableEntry {
  key: string;
  plugin: Plugin;
  config?: unknown;
}

interface Loaded {
  plugin: Plugin;
  signature: string;
  fiber: { dispose(): unknown };
}

function signatureOf(config: unknown): string {
  return JSON.stringify(config ?? null, (_key, value: unknown) => (typeof value === "function" ? "[function]" : value));
}

export class ReloadablePlugins {
  private readonly loaded = new Map<string, Loaded>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ctx: Context) {}

  /** Bring the loaded plugins in line with `entries`; resolves to the keys that were (re)loaded or removed. */
  apply(entries: readonly ReloadableEntry[]): Promise<string[]> {
    // One change at a time: a reload must not interleave with another.
    const next = this.queue.then(() => this.applyNow(entries));
    this.queue = next.catch(() => undefined);
    return next;
  }

  keys(): string[] {
    return [...this.loaded.keys()];
  }

  async dispose(): Promise<void> {
    await this.apply([]);
  }

  private async applyNow(entries: readonly ReloadableEntry[]): Promise<string[]> {
    const changed: string[] = [];
    const wanted = new Set(entries.map((entry) => entry.key));
    for (const [key, loaded] of this.loaded) {
      if (wanted.has(key)) continue;
      await loaded.fiber.dispose();
      this.loaded.delete(key);
      changed.push(key);
    }
    for (const entry of entries) {
      const signature = signatureOf(entry.config);
      const current = this.loaded.get(entry.key);
      if (current !== undefined && current.plugin === entry.plugin && current.signature === signature) continue;
      if (current !== undefined) await current.fiber.dispose();
      const fiber = this.ctx.plugin(entry.plugin, entry.config);
      await fiber;
      this.loaded.set(entry.key, { plugin: entry.plugin, signature, fiber });
      changed.push(entry.key);
    }
    return changed;
  }
}
