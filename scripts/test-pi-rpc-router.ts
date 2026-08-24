import assert from "node:assert/strict";
import { PiRpcResponseRouter } from "../src/lib/piRpcRouter";

async function main() {
  const router = new PiRpcResponseRouter();
  const first = router.register("runtime-a", "same-id", "first", 1_000);
  const second = router.register("runtime-b", "same-id", "second", 1_000);
  assert.equal(router.size, 2);

  assert.equal(router.handle("runtime-b", { type: "response", id: "same-id", command: "second", success: true, data: "b" }), true);
  assert.equal((await second).data, "b");
  assert.equal(router.size, 1);

  router.handle("runtime-a", { type: "response", id: "same-id", command: "first", success: false, error: "denied" });
  await assert.rejects(first, /denied/);
  assert.equal(router.size, 0);

  const exited = router.register("runtime-c", "request-3", "state", 1_000);
  router.rejectRuntime("runtime-c", "runtime exited");
  await assert.rejects(exited, /runtime exited/);
  assert.equal(router.size, 0);

  const timedOut = router.register("runtime-d", "request-4", "slow", 5);
  await assert.rejects(timedOut, /timed out/);
  assert.equal(router.size, 0);

  const replaced = router.register("runtime-e", "duplicate", "old", 1_000);
  const replacement = router.register("runtime-e", "duplicate", "new", 1_000);
  await assert.rejects(replaced, /replaced/);
  router.handle("runtime-e", { type: "response", id: "duplicate", command: "new", success: true });
  await replacement;
  assert.equal(router.size, 0);
  console.log("pi RPC response router tests passed");
}

await main();
