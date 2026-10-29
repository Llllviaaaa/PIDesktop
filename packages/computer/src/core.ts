/**
 * Copied from src-tauri/resources/pidesktop-computer-core.ts (the Pi engine keeps
 * its copy until P6; ADR 0011).
 */
/**
 * Pure helpers shared by the Pi Desktop computer extension.
 *
 * Keep this file free of Pi runtime imports and of the native helper so unit
 * tests can load it directly, the same way pidesktop-rules.ts is split out of
 * pidesktop-guard.ts. The session gate below is the safety-relevant part:
 * observation is read-only, but anything that moves the pointer or presses a
 * key must go through an approved control session.
 */

export interface ComputerSession {
  mode: "idle" | "observe" | "control";
  sourceId: string | null;
  sourceKind: "screen" | "window" | null;
  windowTitle?: string;
}

export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementInfo {
  ref: string;
  role: string;
  name: string;
  value?: string;
  bounds: ElementBounds;
  enabled: boolean;
  focused: boolean;
  focusable: boolean;
  patterns: string[];
}

export interface WindowInfo {
  title: string;
  handle: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ComputerSource {
  id: string;
  kind: "screen" | "window";
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PRIMARY_SCREEN_ID = "screen:primary";

/** Elements listed in one observation before the rest are summarised away. */
export const MAX_LISTED_ELEMENTS = 80;

export const IDLE_SESSION: ComputerSession = {
  mode: "idle",
  sourceId: null,
  sourceKind: null,
};

/**
 * Throw unless the session permits this class of action. `observe` needs any
 * started session; `control` needs one the user approved for input.
 */
export function assertSessionAllows(session: ComputerSession, kind: "observe" | "control"): void {
  if (session.mode === "idle") {
    throw new Error("Start a computer session with computer_start before this action");
  }
  if (kind === "control" && session.mode !== "control") {
    throw new Error("Interactive input requires an approved computer_start control session");
  }
}

/** The window a capture should be scoped to, or undefined for the whole screen. */
export function captureWindowTitle(session: ComputerSession): string | undefined {
  return session.sourceKind === "window" ? session.windowTitle : undefined;
}

export function sessionSummary(session: ComputerSession) {
  return {
    mode: session.mode,
    sourceId: session.sourceId,
    sourceKind: session.sourceKind,
    windowTitle: session.windowTitle,
  };
}

/** Render an observation as the ref/role/name/bounds list the model reads. */
export function elementMapText(elements: ElementInfo[]): string {
  if (!elements.length) return "Foreground window did not expose UI Automation elements.";
  const rows = elements.slice(0, MAX_LISTED_ELEMENTS).map((element) => {
    const name = (element.name || element.value || "unnamed").replace(/\s+/g, " ").slice(0, 160);
    return `${element.ref} ${element.role} “${name}” bounds=(${element.bounds.x},${element.bounds.y},${element.bounds.width},${element.bounds.height})`;
  });
  if (elements.length > rows.length) {
    rows.push(`…${elements.length - rows.length} more elements omitted`);
  }
  return rows.join("\n");
}

/** The primary screen followed by every top-level window, in that order. */
export function sourcesFromCapture(capture: CaptureBounds, windows: WindowInfo[]): ComputerSource[] {
  return [
    {
      id: PRIMARY_SCREEN_ID,
      kind: "screen",
      title: "Primary desktop",
      x: capture.left,
      y: capture.top,
      width: capture.width,
      height: capture.height,
    },
    ...windows.map((window): ComputerSource => ({
      id: `window:${window.handle}`,
      kind: "window",
      title: window.title,
      x: window.x,
      y: window.y,
      width: window.width,
      height: window.height,
    })),
  ];
}
