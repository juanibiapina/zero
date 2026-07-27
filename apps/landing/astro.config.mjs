import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://zeroapps.dev",
  build: { inlineStylesheets: "always" },
  server: { port: 5180 },
  vite: { plugins: [tailwindcss()] },
});
