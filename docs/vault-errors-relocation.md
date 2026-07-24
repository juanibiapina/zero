# Unified dashboard deployment

The existing `zerovault-api` Worker now serves the unified Zero dashboard and
public API. Its name remains unchanged to retain the Vault Durable Object and
KV namespaces.

- Dashboard: `https://dash.zeroapps.dev`
- Public API: `https://api.zeroapps.dev`
- Browser endpoints: `/api/vault/*`, `/api/errors/*`
- Public endpoints: `/vault/v1/*`, `/errors/v1/*`

`apps/vault-api` (`@zero/dashboard-api`) is the sole console Worker. It binds
Vault's existing `ORGDO` and `PROJECTVAULTDO`, plus a new `ERRORSDO` namespace.
`apps/dashboard-web` builds the SPA that its Workers Assets binding serves.

## Deploy

Workers Builds runs `pnpm run build` and deploys with:

```bash
pnpm --filter @zero/dashboard-api run deploy
```

The dashboard build needs `VITE_CLERK_PUBLISHABLE_KEY` configured as a Workers
Build variable. Runtime dashboard secrets come from the `zerovault` ZeroVault
project and are synced with `bin/sync-secrets-to-cloudflare`.

## Retirement sequence

After dashboard sign-in, public API, CLI, and error ingest are verified, deploy
the checked-in retirement revision and inspect Wrangler's migration result:

```bash
pnpm --dir apps/vault-api exec wrangler deploy --config ../../ops/zeroerrors-retirement/wrangler.jsonc
```

It appends the required `v2` migration that deletes the old `ErrorsDO` class.
Then remove the old Worker Build connection and delete the old Errors domain.

`vault.apps.juanibiapina.dev` is retired. Use `zerovault-cli@0.2.2` or later,
which defaults to `api.zeroapps.dev/vault`.
