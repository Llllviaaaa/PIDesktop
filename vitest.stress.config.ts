import { defineConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * The Host's load and leak test (packages/host/test/stress.test.ts), kept out
 * of `npm test`: it takes longer, and it measures the heap, so it runs alone
 * with `gc` exposed.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["packages/host/test/stress.test.ts"],
    exclude: ["**/node_modules/**"],
    execArgv: ["--expose-gc"],
    fileParallelism: false,
  },
});
