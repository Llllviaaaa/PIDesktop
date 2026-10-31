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

  // Rewinding the second message takes it and its reply away.
  await userRow(app, "second question").hover();
  await userRow(app, "second question").getByRole("button", { name: "回退消息和改动" }).click();
  await expect(userBubble(app, "second question")).toHaveCount(0);
  await expect(answer(app, "Second answer.")).toHaveCount(0);

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
  await sidebar.getByText("侧边对话(beta)").click();
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
