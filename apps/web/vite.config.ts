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
        // Suppress noisy EPIPE errors from WebSocket proxy teardown
        configure: (proxy) => {
          proxy.on("error", (err) => {
            if ((err as NodeJS.ErrnoException).code === "EPIPE") return;
            console.error("[vite proxy]", err.message);
          });
        },
      },
    },
  },

  build: {
    outDir: "dist",
  },
});
