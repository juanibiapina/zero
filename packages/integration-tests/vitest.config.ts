import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One real prod round-trip: cold-ish worker + pi-ai + OpenAI + Telegram
    // delivery. Generous but bounded.
    testTimeout: 150_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: "threads",
    maxWorkers: 1,
  },
});
