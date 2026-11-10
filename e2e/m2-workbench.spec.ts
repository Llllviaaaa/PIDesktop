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
