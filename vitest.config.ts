import { defineConfig } from "vitest/config";

/**
 * The assertion suites under tests/ (once under scripts/) used to be 46 standalone tsx processes
 * chained with && , which ran serially and reported nothing but a line of
 * prose each. Vitest runs them in parallel, isolates each file so one suite's
 * globals cannot leak into the next, and can measure coverage.
 *
 * The remaining .mjs checks (repo hygiene, doc links, workflow YAML, the Pi
 * runtime smoke test) stay npm scripts: they check the repository and the
 * bundled runtime rather than this codebase's units.
 */
export default defineConfig({
  test: {
    // packages/ holds the Harness packages of the V2 refactor (docs/adr/0005).
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "packages/*/test/**/*.test.ts"],
    // The load and leak test runs on its own: npm run test:stress (vitest.stress.config.ts).
    exclude: ["**/node_modules/**", "packages/host/test/stress.test.ts"],
    environment: "node",
    // Several suites start a local HTTP server or spawn a child process.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/hooks/**", "src-tauri/resources/pidesktop-*.ts", "packages/*/src/**"],
      exclude: ["src-tauri/resources/pi-runtime/**"],
      reporter: ["text-summary", "lcov"],
    },
  },
});
