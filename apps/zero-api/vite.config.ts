import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";

export const textImports = (): Plugin => ({
  name: "text-imports",
  enforce: "pre",
  load(id) {
    const path = id.split("?")[0];
    if (path.endsWith(".sql")) {
      return `export default ${JSON.stringify(readFileSync(path, "utf8"))};`;
    }
  },
});

export const parseOnlyMermaid = {
  dompurify: fileURLToPath(new URL("./src/prompts/dompurify-parse-only.ts", import.meta.url)),
};

const noSecretsInDist = (): Plugin => ({
  name: "no-secrets-in-dist",
  generateBundle: {
    order: "post",
    handler(_options, bundle) {
      delete bundle[".dev.vars"];
    },
  },
});

export default defineConfig(({ mode }) => ({
  plugins: [
    textImports(),
    cloudflare(
      mode === "test"
        ? { configPath: "./wrangler.test.jsonc", inspectorPort: 9233 }
        : { configPath: "./wrangler.jsonc", inspectorPort: 9232 },
    ),
    noSecretsInDist(),
  ],
  resolve: { alias: parseOnlyMermaid },
  build: { sourcemap: true },
  server: { port: 8790, strictPort: true, watch: { ignored: ["**/.dev.vars"] } },
}));
