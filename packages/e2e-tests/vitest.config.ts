import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 120_000,
    exclude: ["dist/**", "node_modules/**"],
    hookTimeout: 30_000,
    fileParallelism: false,
    pool: "threads",
    maxWorkers: 1,
  },
});
