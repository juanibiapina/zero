import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Persistence test sleeps ~5.5 min to trigger container idle eviction.
    testTimeout: 600_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: "threads",
    maxWorkers: 1,
  },
});
