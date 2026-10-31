/**
 * Each test gets its own Harness Host (packages/host/test/e2e-host.ts) on a
 * fresh data directory, a workspace with one file, and a scripted model whose
 * replies it lines up before acting; `app` opens the page pointed at them.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { ScriptedProvider } from "@pid/testkit";
import { startE2eHost, type E2eHost } from "../packages/host/test/e2e-host.ts";
import { E2E_ORIGIN } from "../playwright.config.ts";

export { expect };
export { textReply, toolReply } from "@pid/testkit";

export interface Harness {
  provider: ScriptedProvider;
  workspace: string;
  dataDir: string;
  readonly host: E2eHost;
  /** Stop the Host and start another on the same port and data, as Rust does after a crash. */
  restart(): Promise<void>;
}

export const test = base.extend<{ harness: Harness; app: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixture's dependencies from this pattern
  harness: async ({}, use) => {
    const dataDir = mkdtempSync(join(tmpdir(), "pid-e2e-data-"));
    const workspace = mkdtempSync(join(tmpdir(), "pid-e2e-work-"));
    writeFileSync(join(workspace, "notes.txt"), "hello from the workspace\n");
    const provider = new ScriptedProvider([], { chunkDelayMs: 150 });
    const token = randomBytes(32).toString("base64url");
    const start = (port?: number) => startE2eHost({ dataDir, pageOrigin: E2E_ORIGIN, token, provider, ...(port === undefined ? {} : { port }) });
    let current = await start();
    const harness: Harness = {
      provider,
      workspace,
      dataDir,
      get host() {
        return current;
      },
      async restart() {
        const port = current.port;
        await current.stop();
        current = await start(port);
      },
    };
    Object.assign(harness, { token });
    await use(harness);
    await current.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  },

  app: async ({ page, harness }, use) => {
    const token = (harness as Harness & { token: string }).token;
    const query = new URLSearchParams({ host: harness.host.baseUrl, token, workspace: harness.workspace });
    await page.goto(`/?${query}`);
    await expect(composer(page)).toBeEnabled();
    await use(page);
  },
});

export const composer = (page: Page | Locator) => page.getByPlaceholder(/发消息|继续指示/);

/** Type `text` into the composer and send it. */
export async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await page.getByTitle("发送").click();
}

/** A user message in the transcript. */
export const userBubble = (page: Page, text: string) => page.locator(".dshc-bubble-text", { hasText: text });

/** A user message's row, with its edit and rewind actions. */
export const userRow = (page: Page, text: string) => page.locator(".dshc-user-row", { hasText: text });

/** Wait until no reply is streaming: the turn has ended, not just shown its text. */
export async function settled(page: Page): Promise<void> {
  await expect(page.locator(".dshc-answer[data-streaming]")).toHaveCount(0);
  await expect(page.locator('[data-turn-open="true"]')).toHaveCount(0);
}

/** A reply in the transcript. */
export const answer = (page: Page, text: string | RegExp) => page.locator(".dshc-answer", { hasText: text });
