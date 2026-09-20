/**
 * Drives the shipped pidesktop-computer-core.ts helpers (not a reimplementation).
 * Run: npx vitest run test-computer-core.test.ts
 */
import assert from "node:assert/strict";
import {
  assertSessionAllows,
  captureWindowTitle,
  elementMapText,
  IDLE_SESSION,
  MAX_LISTED_ELEMENTS,
  PRIMARY_SCREEN_ID,
  sessionSummary,
  sourcesFromCapture,
  type ComputerSession,
  type ElementInfo,
} from "../src-tauri/resources/pidesktop-computer-core.ts";
import { test } from "vitest";

test("computer core", async () => {
  function session(mode: ComputerSession["mode"], extra: Partial<ComputerSession> = {}): ComputerSession {
    return { mode, sourceId: "screen:primary", sourceKind: "screen", ...extra };
  }

  function throws(run: () => void, pattern: RegExp, message: string): void {
    try {
      run();
    } catch (error) {
      assert.match(String(error), pattern, message);
      return;
    }
    assert.fail(message);
  }

  // The session gate. Input into the user's desktop must never run unguarded.
  throws(
    () => assertSessionAllows(IDLE_SESSION, "observe"),
    /computer_start/,
    "an idle session blocks observation",
  );
  throws(
    () => assertSessionAllows(IDLE_SESSION, "control"),
    /computer_start/,
    "an idle session blocks input",
  );
  throws(
    () => assertSessionAllows(session("observe"), "control"),
    /approved computer_start control session/,
    "an observe session must not be able to click, type or drag",
  );
  assertSessionAllows(session("observe"), "observe");
  assertSessionAllows(session("control"), "observe");
  assertSessionAllows(session("control"), "control");

  // Captures follow the session's source.
  assert.equal(captureWindowTitle(session("control")), undefined, "a screen session captures the screen");
  assert.equal(
    captureWindowTitle(session("control", { sourceKind: "window", windowTitle: "Notepad" })),
    "Notepad",
    "a window session captures that window",
  );
  assert.equal(
    captureWindowTitle(session("control", { sourceKind: "window" })),
    undefined,
    "a window session with no recorded title falls back to the screen",
  );

  assert.deepEqual(
    sessionSummary(session("control", { sourceKind: "window", windowTitle: "Notepad" })),
    { mode: "control", sourceId: "screen:primary", sourceKind: "window", windowTitle: "Notepad" },
    "the summary is what every tool result reports back",
  );

  // Source listing: the primary screen first, then each window.
  const sources = sourcesFromCapture(
    { left: -1920, top: 0, width: 1920, height: 1080 },
    [
      { title: "Notepad", handle: "1234", x: 10, y: 20, width: 800, height: 600 },
      { title: "Explorer", handle: "5678", x: 0, y: 0, width: 400, height: 300 },
    ],
  );
  assert.equal(sources.length, 3);
  assert.equal(sources[0].id, PRIMARY_SCREEN_ID, "the screen is always first");
  assert.equal(sources[0].kind, "screen");
  assert.equal(sources[0].x, -1920, "a monitor left of the primary keeps its negative origin");
  assert.equal(sources[1].id, "window:1234", "window ids are derived from the native handle");
  assert.equal(sources[1].title, "Notepad");
  assert.equal(sources[2].id, "window:5678");
  assert.deepEqual(
    sourcesFromCapture({ left: 0, top: 0, width: 1, height: 1 }, []),
    [{ id: PRIMARY_SCREEN_ID, kind: "screen", title: "Primary desktop", x: 0, y: 0, width: 1, height: 1 }],
    "with no windows only the screen is offered",
  );

  // The element map the model reads.
  function element(overrides: Partial<ElementInfo> = {}): ElementInfo {
    return {
      ref: "uia:1:2",
      role: "Button",
      name: "Save",
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      enabled: true,
      focused: false,
      focusable: true,
      patterns: ["Invoke"],
      ...overrides,
    };
  }

  assert.equal(
    elementMapText([]),
    "Foreground window did not expose UI Automation elements.",
    "an empty observation says so rather than returning an empty string",
  );
  assert.equal(
    elementMapText([element()]),
    "uia:1:2 Button “Save” bounds=(1,2,3,4)",
    "each row carries the ref the model needs to act on",
  );
  assert.match(
    elementMapText([element({ name: "", value: "user@example.com" })]),
    /“user@example\.com”/,
    "an unnamed element falls back to its value",
  );
  assert.match(
    elementMapText([element({ name: "", value: "" })]),
    /“unnamed”/,
    "an element with neither is still listed",
  );
  assert.match(
    elementMapText([element({ name: "Save\n  all\tfiles" })]),
    /“Save all files”/,
    "names are flattened so one element stays one row",
  );
  assert.equal(
    elementMapText([element({ name: "x".repeat(400) })]).length,
    "uia:1:2 Button “” bounds=(1,2,3,4)".length + 160,
    "long names are truncated to 160 characters",
  );

  const many = Array.from({ length: MAX_LISTED_ELEMENTS + 5 }, (_, index) =>
    element({ ref: `uia:1:${index}` }));
  const mapped = elementMapText(many).split("\n");
  assert.equal(mapped.length, MAX_LISTED_ELEMENTS + 1, "the list is capped and gains a summary row");
  assert.equal(mapped[mapped.length - 1], "…5 more elements omitted", "the summary counts what was dropped");
});
