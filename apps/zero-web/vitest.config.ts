import path from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
    // One React instance across the app and the workspace @zero/agent-core
    // source it pulls in.
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "jsdom",
    // Public placeholder that satisfies the key guard in src/App.tsx, so tests
    // need no secrets. Tests mock Clerk, so the value is never used.
    env: { VITE_CLERK_PUBLISHABLE_KEY: "pk_test_placeholder" },
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
