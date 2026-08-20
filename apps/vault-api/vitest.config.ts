import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } }),
  ],
  test: {
    // The first test in a file pays the worker's cold start. On a 2-core CI
    // runner with eight suites in flight that alone can exceed vitest's 5s
    // default, so the health check times out before it ever reaches /ping.
    testTimeout: 30_000,
  },
});
