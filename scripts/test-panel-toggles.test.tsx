/**
 * The topbar's panel switches: icons only, the pressed state follows the open
 * panel, and the dock's other tools sit behind ⋯.
 * Run: npx vitest run test-panel-toggles.test.tsx
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { PanelToggles } from "../src/components/PanelToggles";
import type { WorkspaceTool } from "../src/components/ToolRail";

/** The visible words of a rendering, tags removed. */
function words(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function render(props: { terminalOpen?: boolean; activeTool?: WorkspaceTool | null; backgroundTerminals?: "none" | "seen" | "unseen" }) {
  return renderToStaticMarkup(createElement(PanelToggles, {
    terminalOpen: props.terminalOpen ?? false,
    terminalTitle: "终端 (Ctrl+J)",
    backgroundTerminals: props.backgroundTerminals ?? "none",
    onToggleTerminal: () => undefined,
    activeTool: props.activeTool ?? null,
    onToggleTool: () => undefined,
  }));
}

function pressed(markup: string): string[] {
  return [...markup.matchAll(/aria-label="([^"]+)" aria-pressed="true"/g)].map((match) => match[1]);
}

test("panel toggles", () => {
  const closed = render({});
  // Icons only: the labels live in tooltips and aria-labels, not on the bar.
  assert.equal(words(closed), "");
  assert.match(closed, /aria-label="终端 \(Ctrl\+J\)"/);
  assert.match(closed, /title="审查 \(Ctrl\+Shift\+G\)"/);
  assert.match(closed, /title="浏览器 \(Ctrl\+T\)"/);
  assert.match(closed, /aria-label="更多面板"/);
  assert.deepEqual(pressed(closed), []);
  assert.doesNotMatch(closed, /panel-toggle-dot/);

  // The pressed icon follows the open panel.
  assert.deepEqual(pressed(render({ terminalOpen: true, activeTool: "review" })), ["终端 (Ctrl+J)", "审查"]);
  assert.deepEqual(pressed(render({ activeTool: "browser" })), ["浏览器"]);

  // A tool behind ⋯ lights up ⋯ instead.
  const files = render({ activeTool: "files" });
  assert.deepEqual(pressed(files), []);
  assert.match(files, /class="panel-toggle active"[^>]*aria-label="更多面板"/);
  assert.doesNotMatch(closed, /class="panel-toggle active"[^>]*aria-label="更多面板"/);

  // Hidden terminals that printed since you last looked get the accent dot.
  assert.match(render({ backgroundTerminals: "seen" }), /class="panel-toggle-dot "/);
  assert.match(render({ backgroundTerminals: "unseen" }), /class="panel-toggle-dot unseen"/);
});
