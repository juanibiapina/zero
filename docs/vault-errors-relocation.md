# Unified dashboard deployment

The Zero dashboard (Vault and Errors) runs as two Workers on one hostname:

| Worker | Package | Serves |
|---|---|---|
| `zeroapps-dashboard-web` | `@zeroapps/dashboard-web` | `https://dash.zeroapps.dev` (custom domain): the SPA, with SPA fallback |
| `zeroapps-api` | `@zeroapps/api` | `https://api.zeroapps.dev` (custom domain), plus `dash.zeroapps.dev/api/*` and `/ping*` (zone routes) |

- Browser endpoints: `/api/vault/*`, `/api/errors/*` on `dash.zeroapps.dev`
- Public endpoints: `/vault/v1/*`, `/errors/v1/*` on `api.zeroapps.dev`

The zone routes take precedence over the custom domain, so the SPA's `/api`
calls stay same-origin and reach `zeroapps-api`. `zeroapps-api` returns 404 for
any other path on the dashboard host.

`zeroapps-api` binds Vault's `ORGDO` and `PROJECTVAULTDO` plus `ERRORSDO`. It
was named `zerovault-api` until 2026-10-05 and was renamed in place, so its
Durable Object namespaces still carry the `zerovault-api_` prefix.

The dashboard bundle needs `VITE_CLERK_PUBLISHABLE_KEY`, set as a build variable
on the `zeroapps-dashboard-web` connector. Runtime secrets come from the
`zerovault` ZeroVault project and are synced with `bin/sync-secrets-to-cloudflare`.
Build and deploy commands are in AGENTS.md (Deployment).

## Retired infrastructure

The old `zeroerrors-api` Worker, its `ErrorsDO` class, and its custom domains
are retired. `zeroapps-api` owns the active Errors Durable Object.

`vault.apps.juanibiapina.dev` is retired. Use `@zeroapps/cli` (command `zero`),
which defaults to the `api.zeroapps.dev` origin and appends `/vault/v1` itself.
