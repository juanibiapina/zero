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

## Retired infrastructure

The old `zeroerrors-api` Worker, its `ErrorsDO` class, and its custom domains
are retired. The unified dashboard Worker owns the active Errors Durable Object.

`vault.apps.juanibiapina.dev` is retired. Use `@zeroapps/cli` (command `zero`),
which defaults to the `api.zeroapps.dev` origin and appends `/vault/v1` itself.
