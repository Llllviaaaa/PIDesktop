import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserSession, findBrowserExecutable, normalizeUrl, resolveWorkspacePath } from "../src-tauri/resources/pidesktop-browser.ts";

assert.equal(normalizeUrl("example.com/path"), "https://example.com/path");
assert.throws(() => normalizeUrl("file:///C:/Windows/System32"), /Only http and https/);

const browserExecutable = findBrowserExecutable();
assert(browserExecutable.length > 0, "a supported browser executable should be available");

const server = createServer((request, response) => {
  if (request.url === "/download") {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("content-disposition", "attachment; filename=agent-control.txt");
    response.end("downloaded by Pi Desktop");
    return;
  }
  if (request.url === "/set-cookie") {
    response.setHeader("set-cookie", "pidesktop=stable; Max-Age=31536000; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/; SameSite=Lax");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>Cookie saved</title><main>saved</main>");
    return;
  }
  if (request.url === "/cookie") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>Cookie check</title><main><script>document.currentScript.parentElement.append(document.cookie)</script></main>");
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/second") {
    response.end("<!doctype html><title>Second page</title><main>Second page</main>");
    return;
  }
  response.end(`<!doctype html>
    <title>Agent control test</title>
    <style>body { min-height: 2400px; } button, input, select, a { display: block; margin: 16px; }</style>
    <button id="action" onclick="document.querySelector('#status').textContent='clicked'">Run action</button>
    <input id="name" aria-label="Name" />
    <input id="upload" type="file" aria-label="Upload file" onchange="document.querySelector('#status').textContent=this.files[0]?.name || 'empty'" />
    <select id="choice"><option value="one">One</option><option value="two">Two</option></select>
    <a id="next" href="/second">Next page</a>
    <a id="download" href="/download" download>Download file</a>
    <div id="status">idle</div>`);
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const browser = new BrowserSession();
const workspace = await mkdtemp(join(tmpdir(), "pidesktop-browser-workspace-"));
const previousWorkspace = process.env.PIDESKTOP_WORKSPACE_ROOT;
process.env.PIDESKTOP_WORKSPACE_ROOT = workspace;
await writeFile(join(workspace, "upload.txt"), "uploaded by Pi Desktop");

try {
  assert.equal(resolveWorkspacePath("upload.txt"), join(workspace, "upload.txt"));
  assert.throws(() => resolveWorkspacePath("../outside.txt"), /outside the workspace/);
  await browser.ensureStarted(true);
  let snapshot = await browser.navigate(origin);
  assert.equal(snapshot.title, "Agent control test");
  const button = snapshot.elements.find((element) => element.text === "Run action");
  const input = snapshot.elements.find((element) => element.placeholder === undefined && element.tag === "input");
  const upload = snapshot.elements.find((element) => element.text === "Upload file");
  const select = snapshot.elements.find((element) => element.tag === "select");
  const download = snapshot.elements.find((element) => element.text === "Download file");
  assert(button && input && upload && select && download, "inspect should return actionable element refs");

  snapshot = await browser.hover(button.ref);
  assert.equal(snapshot.title, "Agent control test");
  snapshot = await browser.type(input.ref, undefined, "Pi Desktop");
  assert(snapshot.elements.some((element) => element.tag === "input" && element.value === "Pi Desktop"), "type should update the input value");
  snapshot = await browser.select(select.ref, undefined, "Two");
  assert(snapshot.elements.some((element) => element.tag === "select" && element.value === "two"), "select should update the selected option");
  snapshot = await browser.click(button.ref);
  assert(snapshot.text.includes("clicked"), "click should dispatch a real pointer event");
  snapshot = await browser.upload(upload.ref, undefined, ["upload.txt"]);
  assert(snapshot.text.includes("upload.txt"), "upload should assign a workspace file to the file input");
  const downloaded = await browser.download(download.ref, undefined, "downloads");
  assert.equal(await readFile(downloaded.path, "utf8"), "downloaded by Pi Desktop");
  await browser.press("TAB", input.ref);
  await browser.scroll(0, 600);
  const capture = await browser.screenshot(false);
  assert(capture.data.length > 1_000, "screenshot should return PNG data");

  snapshot = await browser.navigate(`${origin}/second`);
  assert.equal(snapshot.title, "Second page");
  snapshot = await browser.history("back");
  assert.equal(snapshot.title, "Agent control test");
  snapshot = await browser.history("forward");
  assert.equal(snapshot.title, "Second page");
  snapshot = await browser.reload();
  assert.equal(snapshot.title, "Second page");
  await browser.wait(25);

  const originalTabs = await browser.listTabs();
  const originalTab = originalTabs.find((tab) => tab.active);
  assert(originalTab, "the original browser tab should be active");
  const added = await browser.newTab(origin);
  assert.equal(added.tabs.length, originalTabs.length + 1, "new_tab should retain existing tabs and add exactly one");
  assert(added.tabs.some((tab) => tab.active && tab.id !== originalTab.id), "the new tab should become active");
  const returned = await browser.closeTab();
  assert.equal(returned.tabs.length, originalTabs.length, "close_tab should close only the active tab");
  assert(returned.tabs.some((tab) => tab.id === originalTab.id), "close_tab should retain the original tab");

  await browser.close();
  process.env.PIDESKTOP_BROWSER_PROFILE_DIR = join(workspace, "persistent-profile");
  const persistent = new BrowserSession();
  const competing = new BrowserSession();
  try {
    await persistent.ensureStarted(true);
    await persistent.navigate(`${origin}/set-cookie`);
    const currentCookie = await persistent.navigate(`${origin}/cookie`);
    assert(currentCookie.text.includes("pidesktop=stable"), "the browser should accept the persistent test cookie");
    await assert.rejects(() => competing.ensureStarted(true), /already in use/, "persistent profile should reject concurrent tasks");
  } finally {
    await competing.close();
    await persistent.close();
  }
  const restored = new BrowserSession();
  try {
    await restored.ensureStarted(true);
    const cookie = await restored.navigate(`${origin}/cookie`);
    assert(cookie.text.includes("pidesktop=stable"), "persistent profile should retain site data across browser restarts");
  } finally {
    await restored.close();
    delete process.env.PIDESKTOP_BROWSER_PROFILE_DIR;
  }
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousWorkspace === undefined) delete process.env.PIDESKTOP_WORKSPACE_ROOT;
  else process.env.PIDESKTOP_WORKSPACE_ROOT = previousWorkspace;
  await rm(workspace, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}

console.log("agent-control-tools: browser CDP workflow passed");
