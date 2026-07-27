# Changelog

User-facing changes to Zero Vault and Zero Errors (the console), most recent first.

Agent (Zero assistant) changes live in `apps/agent-api/CHANGELOG.md`, which ships in-product as Zero's Changelog topic.

- 2026-07-27: The Zero landing page loads faster (no more render-blocking scripts or third-party font requests), and unknown URLs now return a proper "Page not found" page instead of the home page.

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
