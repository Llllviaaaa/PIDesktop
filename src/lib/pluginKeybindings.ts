/**
 * Global dispatcher for plugin keybindings (`ctx.contributions.registerKeybinding`).
 *
 * Listens in the bubble phase on `window`, after the shell's own capture-phase
 * shortcuts and after focused widgets (composer, CodeMirror, xterm). Anything
 * that already called `preventDefault()` wins, so a plugin can add shortcuts
 * but never shadow a built-in one.
 */
import { recordClientRenderError } from "./clientPluginRuntime";
import type { ClientKeybindingContribution, WorkbenchSlotContext } from "./clientContributionTypes";

type ChordEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

const MODIFIER_KEYS = new Set(["control", "ctrl", "shift", "alt", "meta", "os", "dead", "unidentified"]);
const KEY_ALIASES: Record<string, string> = {
  " ": "space",
  spacebar: "space",
  esc: "escape",
  del: "delete",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  return: "enter",
  plus: "+",
};

function normalizeKeyName(raw: string): string {
  const lower = raw.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

function canonical(ctrl: boolean, alt: boolean, shift: boolean, key: string): string {
  return [ctrl ? "ctrl" : "", alt ? "alt" : "", shift ? "shift" : "", key].filter(Boolean).join("+");
}

/** Canonical form of a chord string: `"Cmd+Shift+K"` → `"ctrl+shift+k"`. Returns `""` when there is no key. */
export function normalizeKeyChord(chord: string): string {
  const trimmed = chord.trim();
  if (trimmed === "") return "";
  // A trailing "+" is the plus key itself ("Ctrl++").
  const parts = trimmed.endsWith("++")
    ? [...trimmed.slice(0, -2).split("+"), "+"]
    : trimmed.split("+");
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = "";
  for (const rawPart of parts) {
    const part = rawPart.trim().toLowerCase();
    if (part === "") continue;
    if (["ctrl", "control", "cmd", "command", "meta", "mod", "super"].includes(part)) ctrl = true;
    else if (part === "alt" || part === "option" || part === "opt") alt = true;
    else if (part === "shift") shift = true;
    else key = normalizeKeyName(part);
  }
  return key === "" ? "" : canonical(ctrl, alt, shift, key);
}

/**
 * Canonical chord for a keyboard event, or `null` for a bare modifier press.
 * Letters and digits come from `event.code` so `Shift+1` stays `shift+1`
 * rather than `!`, whatever the keyboard layout prints.
 */
export function keyChordFromEvent(event: ChordEvent): string | null {
  if (!event.key || MODIFIER_KEYS.has(event.key.toLowerCase())) return null;
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
  const digit = /^Digit([0-9])$/.exec(event.code)?.[1];
  const key = letter !== undefined
    ? letter.toLowerCase()
    : digit ?? normalizeKeyName(event.key);
  return canonical(event.ctrlKey || event.metaKey, event.altKey, event.shiftKey, key);
}

/** First binding (by `order`) whose chord matches `chord`, honouring `allowInEditable`. */
export function findKeybinding(
  bindings: readonly ClientKeybindingContribution[],
  chord: string,
  inEditable: boolean,
): ClientKeybindingContribution | undefined {
  return bindings.find((binding) => normalizeKeyChord(binding.key) === chord && (!inEditable || binding.allowInEditable === true));
}

/** Run a plugin callback, reporting sync throws and rejected promises against the plugin. */
export function runPluginCallback(pluginId: string | undefined, slotKey: string, callback: () => unknown): void {
  const report = (error: unknown) => {
    recordClientRenderError(pluginId, slotKey, error);
    console.error(`[qianji-client-plugins] ${slotKey} failed:`, error);
  };
  try {
    const result = callback();
    if (result instanceof Promise) result.catch(report);
  } catch (error) {
    report(error);
  }
}

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [contenteditable=""], .cm-editor, .xterm';

export interface PluginKeybindingSource {
  getKeybindings: () => readonly ClientKeybindingContribution[];
  getContext: () => WorkbenchSlotContext;
}

/** Install the plugin keybinding listener on `target`; returns the disposer. */
export function installPluginKeybindings(source: PluginKeybindingSource, target: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const bindings = source.getKeybindings();
    if (bindings.length === 0) return;
    const chord = keyChordFromEvent(event);
    if (chord === null) return;
    const element = typeof Element !== "undefined" && event.target instanceof Element ? event.target : null;
    if (element?.closest('[data-shortcut-recorder="true"]')) return;
    const binding = findKeybinding(bindings, chord, Boolean(element?.closest(EDITABLE_SELECTOR)));
    if (!binding) return;
    event.preventDefault();
    event.stopPropagation();
    const context = source.getContext();
    runPluginCallback(binding.pluginId, `keybinding:${binding.id}`, () => binding.run(context));
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
