import { readFileSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";

export const textImports = (): Plugin => ({
  name: "text-imports",
  enforce: "pre",
  load(id) {
    const path = id.split("?")[0];
    if (path.endsWith(".md") || path.endsWith(".sql")) {
      return `export default ${JSON.stringify(readFileSync(path, "utf8"))};`;
    }
  },
});

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
  build: { sourcemap: true },
  server: { port: 8790, strictPort: true, watch: { ignored: ["**/.dev.vars"] } },
}));
