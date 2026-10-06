import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { textImports } from "./vite.config";

export default defineConfig({
  plugins: [
    textImports(),
    cloudflareTest({ wrangler: { configPath: "./wrangler.workers-test.jsonc" } }),
  ],
  test: {
    include: ["src/**/*.workers.test.ts"],
    testTimeout: 30_000,
  },
});
