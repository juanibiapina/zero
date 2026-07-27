# Changelog

User-facing changes to Zero Vault and Zero Errors (the console), most recent first.

Agent (Zero assistant) changes live in `apps/agent-api/CHANGELOG.md`, which ships in-product as Zero's Changelog topic.

- 2026-07-28: `zv --version` now prints the CLI's real version instead of the stale `0.2.1` string; ships in zerovault-cli 0.2.3.

- 2026-07-28: The landing site, dashboard, and CLI now link straight to docs.zeroapps.dev — a Docs link in the landing header and footer, a "Setup guide" on each product card, a Docs link in the dashboard sidebar, contextual getting-started pointers on the empty project, key, and issue screens, and docs URLs in `zv --help` and its no-API-key error.

- 2026-07-28: The ZeroVault and ZeroErrors docs now lead with a platform-neutral path: a new "Loading secrets" guide covers pulling secrets into any process or CI job, and a new "Reporter" guide shows a framework-free error reporter for any runtime. Cloudflare Workers is now one optional platform guide rather than the only documented target.

- 2026-07-27: Dashboard pages that fail to load now show what went wrong with a Retry button instead of spinning forever, and a rare account with no active organization is prompted to create one instead of getting stuck.

- 2026-07-27: ZeroVault and ZeroErrors now ship installable agent skills for coding assistants. Add them with `npx skills add juanibiapina/zero-skills`; see docs.zeroapps.dev/skills/overview.

- 2026-07-27: Zero now has public documentation at docs.zeroapps.dev, with getting-started guides for ZeroVault (storing secrets, the zv CLI, pulling secrets into a Cloudflare Worker) and ZeroErrors (sending your first error and reporting from a Worker).

- 2026-07-27: The Zero landing page loads faster, and unknown URLs now show a proper "Page not found" page instead of the home page.

- 2026-07-26: The Zero landing site now ships a robots.txt, sitemap, and social preview cards, so search engines can crawl and index it and shared links show a rich preview.

- 2026-07-24: Zero now has a public home at zeroapps.com, with links to Vault and Errors.

- 2026-07-24: The previous Vault API address is retired. Use zerovault-cli@0.2.2 or later for the new public API.
- 2026-07-24: The previous ZeroErrors addresses are retired. Send error reports to api.zeroapps.dev/errors/v1/errors.
- 2026-07-24: Vault and Errors now share the Zero dashboard at dash.zeroapps.dev; CLI and error reporting use the new api.zeroapps.dev public API.

- 2026-07-23: ZeroVault's old address (zerovault.juanibiapina.dev) is retired; the vault now lives only at vault.apps.juanibiapina.dev. Upgrade to zerovault-cli@0.2.1 (which defaults to the new host) or set ZEROVAULT_API_URL.
- 2026-07-23: ZeroVault now reports its server errors to ZeroErrors, so vault failures show up in the Errors console.
- 2026-07-23: The ZeroVault CLI now defaults to the canonical host vault.apps.juanibiapina.dev, so you only need ZEROVAULT_API_KEY set; ZEROVAULT_API_URL is optional and only needed to target another instance.
- 2026-07-22: The console sign-in card now reads "Sign in to Zero" (was "ZeroVault"), matching the unified Zero brand.
- 2026-07-22: The old Vault and Errors addresses (vault.juanibiapina.dev, errors.juanibiapina.dev) have been retired; the products now live only at vault.apps.juanibiapina.dev and errors.apps.juanibiapina.dev.
- 2026-07-22: Vault and Errors now live at vault.apps.juanibiapina.dev and errors.apps.juanibiapina.dev, and signing in returns you to the product you came from.
- 2026-07-22: Signing in from Vault or Errors now returns you to the product you came from, instead of always landing on Vault.
- 2026-07-22: The Vault and Errors browser tabs now read "Zero Vault" and "Zero Errors", matching the unified Zero brand.
- 2026-07-22: The errors issues list now hides resolved issues by default, with a "Show resolved" toggle to reveal them.
- 2026-07-22: Resolve or reopen an error issue directly from the issues list, without opening it.
- 2026-07-21: Vault and Errors now share the Zero brand and a product switcher, and live at vault.juanibiapina.dev and errors.juanibiapina.dev.
