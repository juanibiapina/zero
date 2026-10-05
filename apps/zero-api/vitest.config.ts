import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";

// Load *.md and *.sql as default-exported text, mirroring the wrangler `Text`
// rules in wrangler.jsonc so imports resolve the same way under vitest.
const textImports = (): Plugin => ({
  name: "text-imports",
  enforce: "pre",
  load(id) {
    const path = id.split("?")[0];
    if (path.endsWith(".md") || path.endsWith(".sql")) {
      return `export default ${JSON.stringify(readFileSync(path, "utf8"))};`;
    }
  },
});

export default defineConfig({
  plugins: [textImports()],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
