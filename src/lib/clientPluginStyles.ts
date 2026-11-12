/**
 * Scoped plugin styles of the client plugin runtime (ADR 0016), re-exported
 * by clientPluginRuntime.ts: CSS sanitizing and `@layer plugin-ui { @scope }`
 * wrapping, the injected <style> elements per plugin, and the snapshot,
 * prune and rollback a hot reload uses.
 */

function isCssIdentChar(ch: string | undefined): boolean {
  if (ch === undefined || ch === "") return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 95 ||
    code >= 128
  );
}

/**
 * Sanitize plugin CSS body so unmatched `}`, unclosed comments, or unclosed strings
 * can never escape the enclosing `@layer plugin-ui { @scope (...) { ... } }` block,
 * and rewrite standalone `:root` selectors to `:scope` so plugin custom properties
 * resolve on `[data-qj-plugin="<id>"]` without leaking globally.
 */
function sanitizePluginScopedCssBody(css: string): string {
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    const next = css[i + 1];
    if (ch === "/" && next === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) {
        out += `${css.slice(i)}*/`;
        break;
      }
      out += css.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += quote;
      i += 1;
      let closed = false;
      while (i < css.length) {
        const c = css[i];
        out += c;
        i += 1;
        if (c === "\\" && i < css.length) {
          out += css[i];
          i += 1;
          continue;
        }
        if (c === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) out += quote;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      out += "{";
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        out += "}";
      }
      i += 1;
      continue;
    }
    if (
      ch === ":" &&
      css.slice(i, i + 5).toLowerCase() === ":root" &&
      !isCssIdentChar(i > 0 ? css[i - 1] : undefined) &&
      !isCssIdentChar(css[i + 5])
    ) {
      const afterRoot = css[i + 5];
      if (afterRoot !== "[" && afterRoot !== "." && afterRoot !== ":") {
        out += ":scope";
        i += 5;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  if (depth > 0) {
    out += "}".repeat(depth);
  }
  return out;
}

/** Wrap raw plugin CSS inside `@layer plugin-ui { @scope ([data-qj-plugin="<id>"]) { ... } }`. */
export function wrapPluginScopedCss(pluginId: string, css: string): string {
  const trimmed = css.trim();
  if (trimmed === "") return "";
  const escapedId = pluginId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeBody = sanitizePluginScopedCssBody(css);
  return `@layer plugin-ui {\n@scope ([data-qj-plugin="${escapedId}"]) {\n${safeBody}\n}\n}`;
}

interface TrackedPluginStyleEntry {
  el: HTMLStyleElement;
  seq: number;
}

const pluginStyleElements = new Map<string, Map<string, TrackedPluginStyleEntry>>();
let dynamicStyleSeq = 0;

/** Inject scoped CSS for `pluginId` into `document.head` and return an idempotent disposer. */
export function injectPluginScopedStyle(pluginId: string, css: string, styleKey?: string): () => void {
  if (typeof document === "undefined" || document.head === null) {
    return () => undefined;
  }
  dynamicStyleSeq += 1;
  const writeSeq = dynamicStyleSeq;
  const resolvedKey = styleKey ?? `inline-${writeSeq}`;
  let perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin === undefined) {
    perPlugin = new Map<string, TrackedPluginStyleEntry>();
    pluginStyleElements.set(pluginId, perPlugin);
  }
  let tracked = perPlugin.get(resolvedKey);
  if (tracked === undefined || !tracked.el.isConnected) {
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-qj-plugin-style", pluginId);
    styleEl.setAttribute("data-qj-style-key", resolvedKey);
    document.head.appendChild(styleEl);
    tracked = { el: styleEl, seq: writeSeq };
    perPlugin.set(resolvedKey, tracked);
  } else {
    tracked.seq = writeSeq;
  }
  const ownedEl = tracked.el;
  ownedEl.textContent = wrapPluginScopedCss(pluginId, css);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const map = pluginStyleElements.get(pluginId);
    if (map?.get(resolvedKey)?.el === ownedEl) {
      map.delete(resolvedKey);
      if (map.size === 0) pluginStyleElements.delete(pluginId);
    }
    ownedEl.remove();
  };
}

export function snapshotBundleScopedStyles(pluginId: string): Map<string, { el: HTMLStyleElement; text: string; seq: number }> {
  const snap = new Map<string, { el: HTMLStyleElement; text: string; seq: number }>();
  const perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin === undefined) return snap;
  for (const [key, entry] of perPlugin.entries()) {
    if (!key.startsWith("inline-")) {
      snap.set(key, { el: entry.el, text: entry.el.textContent ?? "", seq: entry.seq });
    }
  }
  return snap;
}

export function pruneStaleBundleStyles(pluginId: string, seqBefore: number): void {
  const perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin === undefined) return;
  for (const [key, entry] of [...perPlugin.entries()]) {
    if (!key.startsWith("inline-") && entry.seq <= seqBefore) {
      entry.el.remove();
      perPlugin.delete(key);
    }
  }
  if (perPlugin.size === 0) {
    pluginStyleElements.delete(pluginId);
  }
}

export function rollbackBundleScopedStyles(
  pluginId: string,
  snapshot: ReadonlyMap<string, { el: HTMLStyleElement; text: string; seq: number }>,
  seqBefore: number,
): void {
  const perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin !== undefined) {
    for (const [key, entry] of [...perPlugin.entries()]) {
      if (entry.seq > seqBefore && !snapshot.has(key)) {
        entry.el.remove();
        perPlugin.delete(key);
      }
    }
  }
  if (snapshot.size === 0) {
    if (perPlugin !== undefined && perPlugin.size === 0) {
      pluginStyleElements.delete(pluginId);
    }
    return;
  }
  let targetMap = pluginStyleElements.get(pluginId);
  if (targetMap === undefined) {
    targetMap = new Map<string, TrackedPluginStyleEntry>();
    pluginStyleElements.set(pluginId, targetMap);
  }
  for (const [key, prev] of snapshot.entries()) {
    if (!prev.el.isConnected && typeof document !== "undefined" && document.head !== null) {
      document.head.appendChild(prev.el);
    }
    prev.el.textContent = prev.text;
    targetMap.set(key, { el: prev.el, seq: prev.seq });
  }
}

/** Remove all injected `<style>` elements belonging to `pluginId`. */
export function removeAllPluginScopedStyles(pluginId: string): void {
  const perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin !== undefined) {
    for (const entry of perPlugin.values()) {
      entry.el.remove();
    }
    pluginStyleElements.delete(pluginId);
  }
  if (typeof document !== "undefined") {
    const selector = `style[data-qj-plugin-style="${pluginId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
    for (const orphan of Array.from(document.querySelectorAll(selector))) {
      orphan.remove();
    }
  }
}

/** The sequence number of the latest style write, so a reload can prune what it left behind. */
export function currentStyleSeq(): number {
  return dynamicStyleSeq;
}
