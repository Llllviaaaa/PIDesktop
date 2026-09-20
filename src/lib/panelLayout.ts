/**
 * Sizing rules for the resizable panels in the desktop shell.
 *
 * App.tsx carried three near-identical copies of this: read a width from
 * localStorage, clamp it, step it with the arrow keys, write it back. The
 * arithmetic lives here so it can be tested without a pointer, and so the
 * bounds are stated once instead of once per panel.
 */

export interface SizeBounds {
  min: number;
  max: number;
  /** Used when nothing was stored, or what was stored is unusable. */
  fallback: number;
}

export const SIDEBAR_BOUNDS: SizeBounds = { min: 200, max: 380, fallback: 240 };
export const WORKSPACE_PANEL_BOUNDS: SizeBounds = { min: 320, max: 900, fallback: 420 };
export const BOTTOM_PANEL_BOUNDS: SizeBounds = { min: 180, max: 520, fallback: 280 };

export const SIDEBAR_WIDTH_KEY = "pid-desktop:sidebar-width:v2";
export const WORKSPACE_PANEL_WIDTH_KEY = "pid-desktop:workspace-panel-width:v5";
export const BOTTOM_PANEL_HEIGHT_KEY = "pid-desktop:bottom-panel-height:v1";

export function clampSize(value: number, bounds: SizeBounds): number {
  if (!Number.isFinite(value)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/**
 * A stored size is only honoured when it is a finite number inside the
 * bounds; anything else falls back, so a stale key from an older layout
 * cannot leave a panel off-screen.
 */
export function readStoredSize(storageKey: string, bounds: SizeBounds): number {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch {
    return bounds.fallback;
  }
  if (raw === null || raw.trim() === "") return bounds.fallback;
  const stored = Number(raw);
  if (!Number.isFinite(stored) || stored < bounds.min || stored > bounds.max) return bounds.fallback;
  return stored;
}

export function writeStoredSize(storageKey: string, value: number): void {
  try {
    window.localStorage.setItem(storageKey, String(value));
  } catch {
    // A viewer with site data blocked keeps the size for this session only.
  }
}

export interface KeyboardResize {
  /** Key that makes the panel smaller. */
  decreaseKey: string;
  /** Key that makes the panel larger. */
  increaseKey: string;
  step: number;
  /** Step used while Shift is held. */
  largeStep: number;
}

export const SIDEBAR_KEYS: KeyboardResize = {
  decreaseKey: "ArrowLeft",
  increaseKey: "ArrowRight",
  step: 8,
  largeStep: 24,
};

/** The workspace panel is docked right, so ArrowLeft grows it. */
export const WORKSPACE_PANEL_KEYS: KeyboardResize = {
  decreaseKey: "ArrowRight",
  increaseKey: "ArrowLeft",
  step: 10,
  largeStep: 32,
};

/** The bottom panel grows upwards. */
export const BOTTOM_PANEL_KEYS: KeyboardResize = {
  decreaseKey: "ArrowDown",
  increaseKey: "ArrowUp",
  step: 10,
  largeStep: 32,
};

/**
 * The size a resize key should produce, or null when the key does nothing —
 * in which case the caller must not preventDefault.
 *
 * `max` is passed separately because the workspace and bottom panels cap
 * against the current window size, not their static bound.
 */
export function nextSizeFromKey(
  key: string,
  shiftKey: boolean,
  current: number,
  keys: KeyboardResize,
  bounds: { min: number; max: number },
): number | null {
  const increment = shiftKey ? keys.largeStep : keys.step;
  if (key === keys.decreaseKey) return Math.max(bounds.min, current - increment);
  if (key === keys.increaseKey) return Math.min(bounds.max, current + increment);
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;
  return null;
}

/**
 * How wide the workspace panel may get before the conversation is squeezed
 * below a usable width.
 */
export function workspacePanelMaxWidth(
  windowWidth: number,
  layoutScale: number,
  sidebarWidth: number,
): number {
  const mainStageMinWidth = 360;
  const available = windowWidth / layoutScale - sidebarWidth - mainStageMinWidth;
  return Math.max(
    WORKSPACE_PANEL_BOUNDS.min,
    Math.min(WORKSPACE_PANEL_BOUNDS.max, available),
  );
}

export function bottomPanelMaxHeight(windowHeight: number, layoutScale: number): number {
  return Math.max(
    BOTTOM_PANEL_BOUNDS.min,
    Math.min(BOTTOM_PANEL_BOUNDS.max, windowHeight / layoutScale - 240),
  );
}
