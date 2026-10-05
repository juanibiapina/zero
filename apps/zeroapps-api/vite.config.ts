import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";

const noSecretsInDist = (): Plugin => ({
  name: "no-secrets-in-dist",
  generateBundle: {
    order: "post",
    handler(_options, bundle) {
      delete bundle[".dev.vars"];
    },
  },
});

export default defineConfig({
  plugins: [cloudflare({ inspectorPort: 9233 }), noSecretsInDist()],
  server: { port: 8792, strictPort: true },
});
