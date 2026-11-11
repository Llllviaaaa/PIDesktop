import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { answer, composer, expect, send, settled, test, textReply, toolReply, userBubble, userRow } from "./fixtures.ts";

test("send a message and watch the reply stream in", async ({ app, harness }) => {
  harness.provider.push([
    { type: "text-delta", index: 0, text: "Streaming " },
    { type: "text-delta", index: 0, text: "works " },
    { type: "text-delta", index: 0, text: "end to end." },
    { type: "finish", reason: "stop" },
  ]);
  await send(app, "Say hello");
  await expect(userBubble(app, "Say hello")).toBeVisible();
  // The reply shows while it streams, then settles.
  await expect(app.locator(".dshc-answer[data-streaming]")).toBeVisible();
  await expect(answer(app, "Streaming works end to end.")).toBeVisible();
  await expect(app.locator(".dshc-answer[data-streaming]")).toHaveCount(0);
  expect(harness.provider.requests).toHaveLength(1);
});

test.describe("a tool call that needs permission", () => {
  const writeNote = () => toolReply([{ id: "w1", name: "write", args: { path: "made.txt", content: "made by the agent" } }]);

  test("runs once allowed", async ({ app, harness }) => {
    harness.provider.push(writeNote(), textReply("Wrote it."));
    await send(app, "Write made.txt");
    const dialog = app.getByText("需要确认");
    await expect(dialog).toBeVisible();
    await app.getByRole("button", { name: "允许一次" }).click();
    await expect(answer(app, "Wrote it.")).toBeVisible();
    expect(readFileSync(join(harness.workspace, "made.txt"), "utf8")).toBe("made by the agent");
  });

  test("does not run when denied", async ({ app, harness }) => {
    harness.provider.push(writeNote(), textReply("Understood, not writing."));
    await send(app, "Write made.txt");
    await expect(app.getByText("需要确认")).toBeVisible();
    await app.getByRole("button", { name: "拒绝" }).click();
    await expect(answer(app, "Understood, not writing.")).toBeVisible();
    expect(existsSync(join(harness.workspace, "made.txt"))).toBe(false);
  });
});

test("rewind a message, then edit one and send it again", async ({ app, harness }) => {
  harness.provider.push(textReply("First answer."), textReply("Second answer."), textReply("Edited answer."));
  await send(app, "first question");
  await expect(answer(app, "First answer.")).toBeVisible();
  await settled(app);
  await send(app, "second question");
  await expect(answer(app, "Second answer.")).toBeVisible();
  await settled(app);

  // Rewinding the second message takes it and its reply away and restores the text into Composer.
  await userRow(app, "second question").hover();
  await userRow(app, "second question").getByRole("button", { name: "回退消息和改动" }).click();
  await expect(userBubble(app, "second question")).toHaveCount(0);
  await expect(answer(app, "Second answer.")).toHaveCount(0);
  await expect(composer(app)).toHaveValue("second question");

  // Editing the first one resends it in its place.
  await userRow(app, "first question").hover();
  await userRow(app, "first question").getByRole("button", { name: "编辑消息" }).click();
  await app.getByLabel("编辑消息").fill("first question, edited");
  await app.getByTitle("从此消息重新发送").click();
  await expect(userBubble(app, "first question, edited")).toBeVisible();
  await expect(answer(app, "Edited answer.")).toBeVisible();
  await expect(answer(app, "First answer.")).toHaveCount(0);
  const lastRequest = harness.provider.requests.at(-1);
  expect(lastRequest?.messages.map((message) => message.role)).toEqual(["user"]);
});

test("fork the conversation from its latest checkpoint", async ({ app, harness }) => {
  // The app has no session-tree view yet; its fork action is this menu item.
  // Forking at a message branches from just before it, so the fork keeps the
  // first exchange and leaves out the second.
  harness.provider.push(textReply("First answer."), textReply("Second answer."), textReply("On the fork."));
  await send(app, "first");
  await expect(answer(app, "First answer.")).toBeVisible();
  await settled(app);
  await send(app, "second");
  await expect(answer(app, "Second answer.")).toBeVisible();
  await settled(app);
  await app.getByTitle("线程操作").click();
  await app.getByRole("button", { name: "从最新检查点分叉" }).click();
  await expect.poll(async () => (await harness.host.host.ctx.sessions.list()).length).toBe(2);
  await expect(answer(app, "First answer.")).toBeVisible();
  await expect(answer(app, "Second answer.")).toHaveCount(0);
  await send(app, "continue on the fork");
  await expect(answer(app, "On the fork.")).toBeVisible();
});

test("chat beside the conversation", async ({ app, harness }) => {
  harness.provider.push(textReply("Main answer."), textReply("Side answer."));
  await send(app, "main question");
  await expect(answer(app, "Main answer.")).toBeVisible();
  await settled(app);

  // A side chat runs in the right column, on a hidden fork of the task.
  await app.keyboard.press("Control+Alt+B");
  const sidebar = app.locator("[data-rightbar-col]");
  await sidebar.getByRole("tab", { name: "侧边对话" }).click();
  await expect(composer(sidebar)).toBeEnabled();
  await composer(sidebar).fill("side question");
  await sidebar.getByTitle("发送").click();
  await expect(sidebar.locator(".dshc-answer", { hasText: "Side answer." })).toBeVisible();
  await expect(sidebar.locator(".dshc-bubble-text", { hasText: "side question" })).toBeVisible();

  // The task's own conversation is left as it was.
  const main = app.locator(".conversation");
  await expect(main.locator(".dshc-bubble-text", { hasText: "side question" })).toHaveCount(0);
  await expect(main.locator(".dshc-answer", { hasText: "Side answer." })).toHaveCount(0);
  expect(harness.provider.requests.at(-1)?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
});

test("side chat fills workbench width, syncs permission, resets cleanly, and isolates main rewind", async ({ app, harness }) => {
  const mainStage = app.locator(".main-stage");
  harness.provider.push(
    textReply("First main reply."),
    textReply("Second main reply."),
    toolReply([{ id: "side-w1", name: "write", args: { path: "side-note.txt", content: "written in side chat" } }]),
    textReply("Side wrote it without asking."),
  );

  // Switch main permission to "完全访问" before opening Side Chat so we verify inheritance + visible label.
  await mainStage.locator(".chip-permission").click();
  await mainStage.locator(".permission-menu").getByRole("menuitemradio", { name: /完全访问/ }).click();
  await expect(mainStage.locator(".chip-permission")).toContainText("完全访问");

  await send(app, "first main turn");
  await expect(answer(app, "First main reply.")).toBeVisible();
  await settled(app);
  await composer(mainStage).fill("second main turn");
  await mainStage.getByTitle("发送").click();
  await expect(answer(app, "Second main reply.")).toBeVisible();
  await settled(app);

  // Open Right Workbench -> 侧边对话.
  await app.keyboard.press("Control+Alt+B");
  const sidebar = app.locator("[data-rightbar-col]");
  await sidebar.getByRole("tab", { name: "侧边对话" }).click();
  const sidePane = sidebar.locator(".side-chat-pane");
  await expect(composer(sidebar)).toBeEnabled();

  // Side Chat defaults to safe read-only Ask mode ("问答模式" + "只读") even when Main Chat is "完全访问",
  // and main-only plugin chips do not leak in.
  await expect(sidebar.locator(".chip-agent-mode")).toContainText("问答模式");
  await expect(sidebar.locator(".chip-permission > span")).toBeVisible();
  await expect(sidebar.locator(".chip-permission")).toContainText("只读");
  await expect(sidebar.getByRole("button", { name: "交互组件" })).toHaveCount(0);

  // Widen the workbench via keyboard resize and verify `.side-chat-pane` fills 100% of `[data-rightbar-col]`.
  const resizer = app.locator(".pid-right-resizer");
  await resizer.focus();
  for (let i = 0; i < 6; i += 1) {
    await app.keyboard.press("Shift+ArrowLeft");
  }
  const wideSidebarBox = await sidebar.boundingBox();
  const widePaneBox = await sidePane.boundingBox();
  if (!wideSidebarBox || !widePaneBox) {
    throw new Error("Expected bounding boxes for right workbench and side chat pane");
  }
  expect(wideSidebarBox.width).toBeGreaterThanOrEqual(620);
  expect(Math.abs(widePaneBox.width - wideSidebarBox.width)).toBeLessThanOrEqual(2);

  // Maximize workbench and verify `.side-chat-pane` still fills 100% of `[data-rightbar-col]`, then restore.
  await sidebar.getByTitle("最大化工作台").click();
  const maxSidebarBox = await sidebar.boundingBox();
  const maxPaneBox = await sidePane.boundingBox();
  if (!maxSidebarBox || !maxPaneBox) {
    throw new Error("Expected bounding boxes for maximized workbench and side chat pane");
  }
  expect(maxSidebarBox.width).toBeGreaterThanOrEqual(850);
  expect(Math.abs(maxPaneBox.width - maxSidebarBox.width)).toBeLessThanOrEqual(2);
  await sidebar.getByTitle("还原宽度").click();

  // Explicitly switching Side Chat permission to "完全访问" lifts it into agent execution mode.
  await sidebar.locator(".chip-permission").click();
  await sidebar.locator(".permission-menu").getByRole("menuitemradio", { name: /完全访问/ }).click();
  await expect(sidebar.locator(".chip-permission")).toContainText("完全访问");
  await expect(sidebar.locator(".chip-agent-mode")).toHaveCount(0);

  await composer(sidebar).fill("write side-note.txt");
  await sidebar.getByTitle("发送").click();
  await expect(sidebar.locator(".dshc-answer", { hasText: "Side wrote it without asking." })).toBeVisible();
  expect(readFileSync(join(harness.workspace, "side-note.txt"), "utf8")).toBe("written in side chat");

  // Clicking "重新开始" clears Side Chat back to its ready empty state (and default read-only Ask mode) without touching Main Chat.
  await sidebar.getByRole("button", { name: "重新开始" }).click();
  await expect(sidebar.locator(".side-chat-empty-state")).toBeVisible();
  await expect(sidebar.locator(".chip-agent-mode")).toContainText("问答模式");
  await expect(sidebar.locator(".chip-permission")).toContainText("只读");
  await expect(sidebar.locator(".dshc-answer")).toHaveCount(0);
  await expect(composer(sidebar)).toBeEnabled();

  // Rewinding a message in Main Chat while Side Chat is mounted restores text to Main Chat's composer.
  await userRow(app, "second main turn").hover();
  await userRow(app, "second main turn").getByRole("button", { name: "回退消息和改动" }).click();
  await expect(composer(mainStage)).toHaveValue("second main turn");
  await expect(composer(sidebar)).toHaveValue("");
});

test("reconnect after the Host restarts", async ({ app, harness }) => {
  harness.provider.push(textReply("Before the restart."), textReply("After the restart."));
  await send(app, "before");
  await expect(answer(app, "Before the restart.")).toBeVisible();
  await settled(app);
  await harness.restart();
  await expect(app.getByText("Harness 已断开，正在重连")).toBeVisible();
  await expect(app.getByText("Harness 已断开，正在重连")).toHaveCount(0);
  await send(app, "after");
  await expect(answer(app, "After the restart.")).toBeVisible();
  await expect(answer(app, "Before the restart.")).toBeVisible();
});

test("expanding a short turn process does not trigger spurious scrollbars", async ({ app, harness }) => {
  harness.provider.push(
    textReply("<think>只思考一句话。</think>只有一句话的回复。"),
  );
  await send(app, "你好");
  await expect(answer(app, "只有一句话的回复。")).toBeVisible();
  await settled(app);

  await app.locator(".dshc-turn-process").click();
  await app.locator(".dshc-group-title").click();
  await app.locator(".dshc-reasoning-row").click();
  await expect(app.locator(".dshc-think-body")).toContainText("只思考一句话。");

  const metrics = await app.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".conversation-scroll");
    const groupBody = document.querySelector<HTMLElement>(".dshc-group-body");
    if (!scroller || !groupBody) {
      throw new Error("Expected conversation scroller and group body elements");
    }
    return {
      scrollerOverflows: scroller.scrollHeight > scroller.clientHeight,
      groupScrollable: groupBody.classList.contains("is-scrollable"),
      groupOverflows: groupBody.scrollHeight > groupBody.clientHeight,
    };
  });

  expect(metrics.scrollerOverflows).toBe(false);
  expect(metrics.groupScrollable).toBe(false);
  expect(metrics.groupOverflows).toBe(false);
});

test("requireCtrlEnter toggle switches Enter and Ctrl+Enter across composer and message edit", async ({ app, harness }) => {
  harness.provider.push(
    textReply("Default mode reply."),
    textReply("Ctrl+Enter mode reply."),
    textReply("Edited reply."),
  );

  // 1. Default OFF: Ctrl+Enter inserts a newline instead of sending; plain Enter sends.
  const input = composer(app);
  await input.click();
  await input.type("line 1");
  await input.press("Control+Enter");
  await input.type("line 2");
  await expect(input).toHaveValue("line 1\nline 2");
  expect(harness.provider.requests).toHaveLength(0);

  await input.press("Enter");
  await expect(userBubble(app, "line 1\nline 2")).toBeVisible();
  await expect(answer(app, "Default mode reply.")).toBeVisible();
  await settled(app);

  // 2. Enable "使用 Ctrl + Enter 发送消息" in General settings.
  await app.getByRole("button", { name: "设置" }).click();
  const ctrlEnterSwitch = app.getByRole("switch", { name: "使用 Ctrl+Enter 发送" });
  await expect(ctrlEnterSwitch).toHaveAttribute("aria-checked", "false");
  await ctrlEnterSwitch.click();
  await expect(ctrlEnterSwitch).toHaveAttribute("aria-checked", "true");
  await app.locator(".settings-back-btn").click();
  await expect(app.getByRole("region", { name: "设置" })).toHaveCount(0);

  // Composer reflects the active shortcut in both placeholder and send tooltip.
  await expect(input).toHaveAttribute("placeholder", /Ctrl\+Enter 发送/);
  await expect(app.locator(".send-button")).toHaveAttribute("title", "发送 (Ctrl+Enter)");

  // Plain Enter now inserts a newline; Ctrl+Enter submits.
  await input.click();
  await input.type("ctrl line 1");
  await input.press("Enter");
  await input.type("ctrl line 2");
  await expect(input).toHaveValue("ctrl line 1\nctrl line 2");
  expect(harness.provider.requests).toHaveLength(1);

  await input.press("Control+Enter");
  await expect(userBubble(app, "ctrl line 1\nctrl line 2")).toBeVisible();
  await expect(answer(app, "Ctrl+Enter mode reply.")).toBeVisible();
  await settled(app);

  // 3. Inline message edit also respects requireCtrlEnter.
  await userRow(app, "ctrl line 1").hover();
  await userRow(app, "ctrl line 1").getByRole("button", { name: "编辑消息" }).click();
  const editInput = app.getByRole("textbox", { name: "编辑消息" });
  await editInput.fill("edited 1");
  await editInput.press("Enter");
  await app.keyboard.type("edited 2");
  await expect(editInput).toHaveValue("edited 1\nedited 2");
  expect(harness.provider.requests).toHaveLength(2);

  await editInput.press("Control+Enter");
  await expect(userBubble(app, "edited 1\nedited 2")).toBeVisible();
  await expect(answer(app, "Edited reply.")).toBeVisible();
});
