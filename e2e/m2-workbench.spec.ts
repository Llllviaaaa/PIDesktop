import { answer, composer, expect, send, settled, test, textReply } from "./fixtures.ts";

test("slash commands run via Host Commands service and Sidebar Ctrl+K searches FTS5 session bodies", async ({
  app,
  harness,
}) => {
  // 1. Typing `/` in the composer opens the live Host slash-command menu.
  await composer(app).fill("/doc");
  const suggestionMenu = app.getByRole("listbox", { name: "快捷指令" });
  await expect(suggestionMenu).toBeVisible();
  await expect(suggestionMenu).toContainText("/doctor");
  await expect(suggestionMenu).toContainText("内置");

  // Selecting `/doctor` and submitting renders Host diagnostics inline without consuming a model turn.
  await suggestionMenu.getByRole("option", { name: /\/doctor/ }).click();
  await app.getByTitle("发送").click();
  await expect(answer(app, "千机 宿主诊断报告")).toBeVisible();
  expect(harness.provider.requests).toHaveLength(0);

  // 2. Send a real prompt whose assistant answer contains a unique phrase not present in the user prompt/title.
  harness.provider.push(textReply("定位完成：根因位于 QuantumFluxCapacitor42 模块的缓存失效策略。"));
  await send(app, "帮我检查模块问题");
  await settled(app);
  await expect(answer(app, /QuantumFluxCapacitor42/)).toBeVisible();
  expect(harness.provider.requests).toHaveLength(1);

  // 3. Start a new blank task so we leave the session, then search for the assistant-only phrase in Sidebar.
  await app.getByRole("button", { name: "新会话" }).click();
  await app.getByRole("button", { name: "搜索会话与项目" }).click();
  const searchInput = app.getByPlaceholder("搜索会话标题、正文或项目…");
  await expect(searchInput).toBeVisible();
  await searchInput.fill("QuantumFluxCapacitor42");

  // FTS5 search matches the assistant reply body and renders the snippet under the matched session row!
  const snippetButton = app.locator(".thread-search-snippet", { hasText: "QuantumFluxCapacitor42" });
  await expect(snippetButton).toBeVisible();
  await snippetButton.click();

  // Clicking the FTS5 snippet opens that session back up.
  await expect(answer(app, /根因位于 QuantumFluxCapacitor42 模块/)).toBeVisible();
});

test("primary sidebar stays pinned across split-screen/narrow resizes, previews out-of-flow without layout shift, and ignores Ctrl+B in inputs", async ({
  app,
}) => {
  const sidebarPanel = app.locator(".primary-sidebar-panel");
  const workSurface = app.locator(".work-surface");

  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "pinned");

  // 1. Pressing Ctrl+B inside the composer textarea must NOT toggle/unpin the sidebar.
  await composer(app).focus();
  await app.keyboard.press("Control+b");
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "pinned");

  // 2. 840px split-screen (between 761px and the old 900px media query) keeps the sidebar docked.
  await app.setViewportSize({ width: 840, height: 800 });
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "pinned");

  // 3. Narrow <= 760px collapses reversibly without overwriting persisted pin state; drawer renders cleanly at <= 720px.
  await app.setViewportSize({ width: 700, height: 800 });
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "closed");
  expect(await app.evaluate(() => window.localStorage.getItem("qianji:sidebar-pinned:v1"))).toBe("1");

  await app.locator(".window-menubar [data-sidebar-toggle]").click();
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "preview");
  const panelBoxNarrow = await sidebarPanel.boundingBox();
  const asideBoxNarrow = await app.locator(".sidebar.codex-sidebar").boundingBox();
  expect(panelBoxNarrow).not.toBeNull();
  expect(asideBoxNarrow).not.toBeNull();
  // Legacy `@media (max-width: 900px) { top: 41px }` must not offset `.sidebar` inside the floating card.
  expect(Math.abs((asideBoxNarrow?.y ?? 0) - (panelBoxNarrow?.y ?? 0))).toBeLessThanOrEqual(2);
  await app.getByRole("button", { name: "收起侧栏" }).click();
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "closed");

  // 4. Returning to wide viewport automatically restores docked pinned sidebar.
  await app.setViewportSize({ width: 1280, height: 800 });
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "pinned");

  // 5. Explicit unpin -> out-of-flow hover preview with zero `.work-surface` layout shift -> re-pin via `<Pin>` -> reload persistence.
  await app.locator(".window-menubar [data-sidebar-toggle]").click();
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "closed");
  expect(await app.evaluate(() => window.localStorage.getItem("qianji:sidebar-pinned:v1"))).toBe("0");

  const surfaceBeforePreview = await workSurface.boundingBox();
  await app.locator(".sidebar-hover-zone").hover({ position: { x: 4, y: 200 } });
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "preview");
  const surfaceDuringPreview = await workSurface.boundingBox();
  expect(surfaceDuringPreview?.x).toBe(surfaceBeforePreview?.x);

  // Move pointer to main chat surface: preview closes with zero layout shove on `.work-surface`.
  await app.mouse.move(700, 300);
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "closed");
  const surfaceAfterClose = await workSurface.boundingBox();
  expect(surfaceAfterClose?.x).toBe(surfaceBeforePreview?.x);

  // Hover again and click explicit `<Pin>` button inside sidebar header.
  await app.locator(".sidebar-hover-zone").hover({ position: { x: 4, y: 200 } });
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "preview");
  await app.locator(".sidebar-pin-button").click();
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "pinned");
  expect(await app.evaluate(() => window.localStorage.getItem("qianji:sidebar-pinned:v1"))).toBe("1");

  await app.reload();
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "pinned");

  // 6. Customize `shortcutToggleSidebar` via Settings -> 外观 -> 切换左侧栏快捷键 and verify live chord + tooltip update.
  await app.getByRole("button", { name: "设置" }).click();
  const settingsView = app.getByRole("region", { name: "设置" });
  await settingsView.locator(".settings-nav-scroll").getByRole("button", { name: "外观" }).click();
  const recorder = settingsView.getByRole("button", { name: "切换左侧栏快捷键" });
  await expect(recorder).toContainText("Ctrl+B");
  await recorder.click();
  await expect(recorder).toContainText("按下组合键…");
  await app.keyboard.press("Control+Shift+b");
  await expect(recorder).toContainText("Ctrl+Shift+B");
  await settingsView.getByRole("button", { name: "返回应用" }).click();
  await expect(settingsView).toHaveCount(0);

  await expect(app.locator(".window-menubar [data-sidebar-toggle]")).toHaveAttribute("title", "隐藏侧栏 (Ctrl+Shift+B)");
  await app.keyboard.press("Control+Shift+b");
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "closed");
  await app.keyboard.press("Control+Shift+b");
  await expect(sidebarPanel).toHaveAttribute("data-sidebar-panel-state", "pinned");
});
