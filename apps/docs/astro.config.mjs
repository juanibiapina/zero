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
          label: "CLI",
          items: [{ label: "Overview", slug: "cli/overview" }],
        },
        {
          label: "ZeroVault",
          items: [
            { label: "Overview", slug: "vault/overview" },
            { label: "Getting started", slug: "vault/getting-started" },
            { label: "Vault commands", slug: "vault/cli" },
            { label: "Loading secrets", slug: "vault/loading-secrets" },
            { label: "Cloudflare Workers", slug: "vault/workers" },
          ],
        },
        {
          label: "ZeroErrors",
          items: [
            { label: "Overview", slug: "errors/overview" },
            { label: "Getting started", slug: "errors/getting-started" },
            { label: "Errors commands", slug: "errors/cli" },
            { label: "Reporter", slug: "errors/reporter" },
            { label: "Cloudflare Workers", slug: "errors/worker-integration" },
          ],
        },
        {
          label: "Account",
          items: [{ label: "API keys", slug: "account/api-keys" }],
        },
        {
          label: "Skills",
          items: [{ label: "Overview", slug: "skills/overview" }],
        },
      ],
    }),
  ],
});
