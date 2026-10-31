import { defineConfig } from "@playwright/test";

/**
 * The browser E2E suite (e2e/, docs/REFACTOR_V2_P7.md 3.4): the app built
 * with `vite build --mode e2e`, which fakes Tauri (src/dev/tauriStub.ts),
 * against a real Harness Host each test starts in this process
 * (packages/host/test/e2e-host.ts). It drives the installed Edge or Chrome,
 * so no browser download is needed: PID_E2E_CHANNEL picks one (default msedge).
 */
const port = 4173;
export const E2E_ORIGIN = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "e2e",
  // tsconfig.json maps @deepseek-ai/cordis to type declarations for the renderer;
  // the e2e config resolves the real package, and better-sidebar's host aliases.
  tsconfig: "./tsconfig.e2e-runtime.json",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: E2E_ORIGIN,
    channel: process.env.PID_E2E_CHANNEL ?? "msedge",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: `npx vite build --mode e2e && npx vite preview --mode e2e --host 127.0.0.1 --port ${port} --strictPort`,
    url: E2E_ORIGIN,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
