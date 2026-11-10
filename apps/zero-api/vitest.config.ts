import { defineConfig } from "vitest/config";
import { parseOnlyMermaid, textImports } from "./vite.config";

export default defineConfig({
  plugins: [textImports()],
  resolve: { alias: parseOnlyMermaid },
  test: {
    include: ["src/**/*.test.ts"],
    // Bundle Mermaid like the Worker build does, so its DOMPurify import takes the alias.
    server: { deps: { inline: ["mermaid"] } },
  },
});
