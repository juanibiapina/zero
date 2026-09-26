import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  server: {
    port: 5176,
    proxy: {
      "/api": {
        target: "http://localhost:8790",
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },

  build: {
    outDir: "dist",
  },
});
