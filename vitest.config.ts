import { defineConfig } from "vitest/config";

/**
 * The assertion suites under scripts/ used to be 46 standalone tsx processes
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
    include: ["scripts/**/*.test.ts", "scripts/**/*.test.tsx"],
    environment: "node",
    // Several suites start a local HTTP server or spawn a child process.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/hooks/**", "src-tauri/resources/pidesktop-*.ts"],
      exclude: ["src-tauri/resources/pi-runtime/**"],
      reporter: ["text-summary", "lcov"],
    },
  },
});
