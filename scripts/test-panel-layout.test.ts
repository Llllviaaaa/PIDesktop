/**
 * Covers the panel sizing rules App.tsx used to carry three copies of.
 * Run: npx vitest run test-panel-layout.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";

test("panel layout", async () => {
  // readStoredSize and writeStoredSize talk to window.localStorage.
  const store = new Map<string, string>();
  let throwOnAccess = false;
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem(key: string) {
        if (throwOnAccess) throw new Error("site data blocked");
        return store.has(key) ? store.get(key)! : null;
      },
      setItem(key: string, value: string) {
        if (throwOnAccess) throw new Error("site data blocked");
        store.set(key, value);
      },
    },
  };

  const {
    BOTTOM_PANEL_BOUNDS,
    BOTTOM_PANEL_KEYS,
    SIDEBAR_BOUNDS,
    SIDEBAR_KEYS,
    WORKSPACE_PANEL_BOUNDS,
    WORKSPACE_PANEL_KEYS,
    bottomPanelMaxHeight,
    clampSize,
    nextSizeFromKey,
    readStoredSize,
    workspacePanelMaxWidth,
    writeStoredSize,
  } = await import("../src/lib/panelLayout");

  assert.equal(clampSize(300, SIDEBAR_BOUNDS), 300);
  assert.equal(clampSize(50, SIDEBAR_BOUNDS), SIDEBAR_BOUNDS.min, "too small clamps up");
  assert.equal(clampSize(5000, SIDEBAR_BOUNDS), SIDEBAR_BOUNDS.max, "too large clamps down");
  assert.equal(clampSize(Number.NaN, SIDEBAR_BOUNDS), SIDEBAR_BOUNDS.fallback, "NaN falls back");

  // A stored value is only trusted when it is usable; otherwise a stale key from
  // an older layout could leave a panel off-screen.
  assert.equal(readStoredSize("missing", SIDEBAR_BOUNDS), SIDEBAR_BOUNDS.fallback, "nothing stored");
  store.set("k", "260");
  assert.equal(readStoredSize("k", SIDEBAR_BOUNDS), 260, "a usable value is honoured");
  store.set("k", "");
  assert.equal(readStoredSize("k", SIDEBAR_BOUNDS), SIDEBAR_BOUNDS.fallback, "empty string");
  store.set("k", "not a number");
  assert.equal(readStoredSize("k", SIDEBAR_BOUNDS), SIDEBAR_BOUNDS.fallback, "garbage");
  store.set("k", "9999");
  assert.equal(readStoredSize("k", SIDEBAR_BOUNDS), SIDEBAR_BOUNDS.fallback, "out of bounds is rejected, not clamped");
  store.set("k", "10");
  assert.equal(readStoredSize("k", SIDEBAR_BOUNDS), SIDEBAR_BOUNDS.fallback, "below the minimum");

  throwOnAccess = true;
  assert.equal(readStoredSize("k", SIDEBAR_BOUNDS), SIDEBAR_BOUNDS.fallback, "a private window must not crash the shell");
  writeStoredSize("k", 300); // must not throw
  throwOnAccess = false;

  // Keyboard resizing. Returning null matters: the caller must not
  // preventDefault on a key the panel does not handle.
  const sidebarBounds = { min: SIDEBAR_BOUNDS.min, max: SIDEBAR_BOUNDS.max };
  assert.equal(nextSizeFromKey("ArrowRight", false, 240, SIDEBAR_KEYS, sidebarBounds), 248);
  assert.equal(nextSizeFromKey("ArrowRight", true, 240, SIDEBAR_KEYS, sidebarBounds), 264, "Shift takes the large step");
  assert.equal(nextSizeFromKey("ArrowLeft", false, 240, SIDEBAR_KEYS, sidebarBounds), 232);
  assert.equal(nextSizeFromKey("Home", false, 240, SIDEBAR_KEYS, sidebarBounds), SIDEBAR_BOUNDS.min);
  assert.equal(nextSizeFromKey("End", false, 240, SIDEBAR_KEYS, sidebarBounds), SIDEBAR_BOUNDS.max);
  assert.equal(nextSizeFromKey("Tab", false, 240, SIDEBAR_KEYS, sidebarBounds), null, "an unrelated key is not handled");
  assert.equal(nextSizeFromKey("ArrowUp", false, 240, SIDEBAR_KEYS, sidebarBounds), null, "the sidebar resizes horizontally only");

  assert.equal(
    nextSizeFromKey("ArrowLeft", false, SIDEBAR_BOUNDS.min, SIDEBAR_KEYS, sidebarBounds),
    SIDEBAR_BOUNDS.min,
    "stepping past the minimum stops at it",
  );
  assert.equal(
    nextSizeFromKey("ArrowRight", true, SIDEBAR_BOUNDS.max, SIDEBAR_KEYS, sidebarBounds),
    SIDEBAR_BOUNDS.max,
    "stepping past the maximum stops at it",
  );

  // The workspace panel is docked right, so ArrowLeft makes it bigger.
  const workspaceBounds = { min: WORKSPACE_PANEL_BOUNDS.min, max: 800 };
  assert.equal(nextSizeFromKey("ArrowLeft", false, 420, WORKSPACE_PANEL_KEYS, workspaceBounds), 430, "left grows the right-docked panel");
  assert.equal(nextSizeFromKey("ArrowRight", false, 420, WORKSPACE_PANEL_KEYS, workspaceBounds), 410);

  // The bottom panel grows upwards.
  const bottomBounds = { min: BOTTOM_PANEL_BOUNDS.min, max: 400 };
  assert.equal(nextSizeFromKey("ArrowUp", false, 280, BOTTOM_PANEL_KEYS, bottomBounds), 290);
  assert.equal(nextSizeFromKey("ArrowDown", false, 280, BOTTOM_PANEL_KEYS, bottomBounds), 270);

  // Dynamic caps: the conversation keeps at least 360 logical pixels.
  assert.equal(
    workspacePanelMaxWidth(1920, 1, 240),
    WORKSPACE_PANEL_BOUNDS.max,
    "1920 - 240 - 360 exceeds the static maximum, so the cap wins",
  );
  assert.equal(workspacePanelMaxWidth(1400, 1, 240), 1400 - 240 - 360, "a mid-width window is limited by the available space");
  assert.equal(
    workspacePanelMaxWidth(800, 1, 240),
    WORKSPACE_PANEL_BOUNDS.min,
    "a narrow window pins the panel at its minimum rather than hiding the chat",
  );
  assert.equal(
    workspacePanelMaxWidth(4000, 1, 240),
    WORKSPACE_PANEL_BOUNDS.max,
    "a very wide window is still capped by the static maximum",
  );
  assert.equal(
    workspacePanelMaxWidth(1920, 1.5, 240),
    Math.max(WORKSPACE_PANEL_BOUNDS.min, Math.min(WORKSPACE_PANEL_BOUNDS.max, 1920 / 1.5 - 240 - 360)),
    "UI scale is applied before the budget is split",
  );
  assert.equal(
    workspacePanelMaxWidth(1400, 1, 0),
    Math.min(WORKSPACE_PANEL_BOUNDS.max, 1400 - 360),
    "a hidden sidebar returns its width to the budget",
  );

  assert.equal(bottomPanelMaxHeight(1080, 1), BOTTOM_PANEL_BOUNDS.max, "1080 - 240 exceeds the static maximum");
  assert.equal(bottomPanelMaxHeight(700, 1), 700 - 240, "a mid-height window is limited by the available space");
  assert.equal(bottomPanelMaxHeight(400, 1), BOTTOM_PANEL_BOUNDS.min, "a short window pins the bottom panel at its minimum");
  assert.equal(bottomPanelMaxHeight(4000, 1), BOTTOM_PANEL_BOUNDS.max, "a tall window is capped by the static maximum");
});
