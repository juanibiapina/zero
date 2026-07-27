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
      head: [
        {
          tag: "meta",
          attrs: { name: "robots", content: "noindex, nofollow" },
        },
      ],
      plugins: [starlightLlmsTxt(), starlightPageActions()],
      sidebar: [
        {
          label: "ZeroVault",
          items: [{ label: "Overview", slug: "vault/overview" }],
        },
        {
          label: "ZeroErrors",
          items: [{ label: "Overview", slug: "errors/overview" }],
        },
        {
          label: "Skills",
          items: [{ label: "Overview", slug: "skills/overview" }],
        },
      ],
    }),
  ],
});
