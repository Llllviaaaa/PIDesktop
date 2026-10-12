/**
 * An abandoned file search must be cancelled on the backend under the same
 * request id it was started with, and a finished one must not be.
 * Run: npx vitest run test-workspace-search.test.ts
 */
import assert from "node:assert/strict";
import { test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  searches: [] as string[],
  cancels: [] as string[],
  finish: undefined as undefined | (() => void),
}));

vi.mock("../src/lib/pi", () => ({
  pi: {
    searchWorkspaceFiles: (_cwd: string, _needle: string, requestId: string) => {
      calls.searches.push(requestId);
      return new Promise((resolve) => {
        calls.finish = () => resolve([{ name: "App.tsx", path: "src/App.tsx", isDir: false }]);
      });
    },
    cancelWorkspaceSearch: (requestId: string) => {
      calls.cancels.push(requestId);
      return Promise.resolve();
    },
  },
}));

const { searchWorkspace } = await import("../src/lib/workspaceSearch");

test("workspace search", async () => {
  // Abandoned: typing moved on, so TanStack Query aborts the signal.
  const abandoned = new AbortController();
  const pending = searchWorkspace("D:/repo", "app", abandoned.signal);
  abandoned.abort();
  assert.deepEqual(calls.cancels, [calls.searches[0]], "the backend search is cancelled by its own id");
  calls.finish?.();
  await pending;

  // Finished: aborting afterwards must not cancel anything on the backend.
  const finished = new AbortController();
  const result = searchWorkspace("D:/repo", "app", finished.signal);
  calls.finish?.();
  assert.equal((await result)[0].path, "src/App.tsx");
  finished.abort();
  assert.equal(calls.cancels.length, 1, "a completed search leaves nothing to cancel");

  assert.notEqual(calls.searches[0], calls.searches[1], "each search gets its own request id");
});
