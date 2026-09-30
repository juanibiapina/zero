import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://zeroapps.dev",
  build: { inlineStylesheets: "always" },
  server: { port: 5180 },
});
