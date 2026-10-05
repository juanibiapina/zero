import { defineConfig } from "vitest/config";
import { textImports } from "./vite.config";

export default defineConfig({
  plugins: [textImports()],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
