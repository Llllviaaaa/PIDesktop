/**
 * useSyncOnChange must fire when the effect it replaces would have: on mount,
 * and when a dependency changes — never on an unrelated re-render.
 * Run: npx vitest run test-sync-on-change.test.tsx
 */
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { useSyncOnChange } from "../src/hooks/useSyncOnChange";

test("sync on change", async () => {
  // Mount: the synced value is visible in the very first output, where the
  // effect version would have rendered the stale initial value first.
  function Draft({ title, editing }: { title: string; editing: boolean }) {
    const [draft, setDraft] = useState("");
    useSyncOnChange([editing, title], () => {
      if (!editing) setDraft(title);
    });
    return createElement("span", null, draft);
  }
  assert.equal(renderToStaticMarkup(createElement(Draft, { title: "Fix gate", editing: false })), "<span>Fix gate</span>");
  assert.equal(
    renderToStaticMarkup(createElement(Draft, { title: "Fix gate", editing: true })),
    "<span></span>",
    "while editing, the draft is left alone",
  );

  // It runs once per change, not on every render.
  let calls = 0;
  function Counter({ value }: { value: number }) {
    const [, setTick] = useState(0);
    useSyncOnChange([value], () => {
      calls += 1;
      setTick((tick) => tick + 1);
    });
    return null;
  }
  renderToStaticMarkup(createElement(Counter, { value: 1 }));
  assert.equal(calls, 1, "one run for the mount, and the state update it made does not re-trigger it");

  // Dependencies are compared by value slot with Object.is, like effect deps.
  const seen: string[] = [];
  function Tracker({ a, b }: { a: unknown; b: unknown }) {
    const [log, setLog] = useState<string[]>([]);
    useSyncOnChange([a, b], () => setLog((entries) => [...entries, `${String(a)}:${String(b)}`]));
    seen.splice(0, seen.length, ...log);
    return null;
  }
  renderToStaticMarkup(createElement(Tracker, { a: Number.NaN, b: 0 }));
  assert.deepEqual(seen, ["NaN:0"], "NaN equals itself under Object.is, so the sync converges");
});
