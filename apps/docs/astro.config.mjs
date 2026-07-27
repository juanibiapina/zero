import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightPageActions from "starlight-page-actions";

export default defineConfig({
  site: "https://docs.zeroapps.dev",
  server: { port: 5182 },
  integrations: [
    starlight({
      title: "Zero Docs",
      plugins: [starlightLlmsTxt(), starlightPageActions()],
      sidebar: [
        {
          label: "ZeroVault",
          items: [
            { label: "Overview", slug: "vault/overview" },
            { label: "Getting started", slug: "vault/getting-started" },
            { label: "CLI", slug: "vault/cli" },
            { label: "Cloudflare Workers", slug: "vault/workers" },
          ],
        },
        {
          label: "ZeroErrors",
          items: [
            { label: "Overview", slug: "errors/overview" },
            { label: "Getting started", slug: "errors/getting-started" },
            { label: "Worker integration", slug: "errors/worker-integration" },
          ],
        },
      ],
    }),
  ],
});
