# Console authentication

The Zero dashboard is served from `https://dash.zeroapps.dev`. Vault lives under
`/vault/*` and Errors under `/errors/*`, so both products share one browser
origin, Clerk session, and sign-in flow.

## Clerk instances

- **Dashboard:** one Clerk instance with `zeroapps.dev` as its primary domain.
  Its Clerk frontend API and account portal are `clerk.zeroapps.dev` and
  `accounts.zeroapps.dev`; `dash.zeroapps.dev` is an allowed subdomain.
- **Agent:** a separate Clerk instance for `zero.juanibiapina.dev`. Do not merge
  its keys or domains with the dashboard instance.

`AuthProvider` uses relative `/sign-in` and `/sign-up` paths. Sign-in returns to
`/vault/projects` by default, while dashboard product links stay on the same
origin and preserve the session.

## CLI sign-in (OAuth application)

`zero login` signs the CLI in against the **dashboard** Clerk instance. The
OAuth application lives in Clerk, not in this repo, so nothing here can enforce
its settings:

- id `oa_3HuG8LoTNK3WoKVWs1FqxZl538p`, name **Zero CLI**
- client id `2kOnZBfUZx8kl0KL` — public, ships in the CLI source, not a secret
- public client, PKCE (S256) required, consent screen enabled
- redirect URI: `http://127.0.0.1:8976/callback` — a single entry is enough, the
  port is a wildcard (RFC 8252 §7.3). The host spelling and the path are not:
  `localhost`, `127.0.0.2` and any other path are rejected.
- scopes: `openid profile email offline_access user:org:read`

`user:org:read` is load-bearing: it puts the consent screen's organization
selector in front of the user and the resulting `org_id` in the token, and
ZeroVault cannot route a request without an org.

The create call returned a client secret. Nothing uses it — the CLI is a public
client and the Worker verifies tokens through `/oauth/userinfo`, which takes no
client credentials. Rotate it if anything ever adopts `/oauth/token_info`, which
does require them.

Facts worth keeping (measured against the live instance, 2026-08-14):

- Access tokens expire after **1 day** and the TTL is not configurable per app.
- Refresh tokens never expire but **rotate**, and replaying an old one revokes
  the whole family. The CLI therefore persists a rotated pair before using it.
- Revocation (`/oauth/token/revoke`, no client secret needed) kills the access
  token immediately, which is why `apps/vault-api` verifies remotely rather than
  checking the JWT locally.

**Degradation mode:** `/vault/v1/*` and `/errors/v1/*` now call Clerk to verify
an OAuth token (cached 60s in the `APIKEYS` KV). A Clerk outage fails requests
made with a sign-in; requests made with a `zv_` key are unaffected, since those
never leave the Worker.

## Signup webhook

In the dashboard Clerk instance, add a webhook endpoint for dashboard account
creation:

- URL: `https://dash.zeroapps.dev/api/webhooks/clerk`
- Event: `user.created`

Store the endpoint's signing secret as `CLERK_WEBHOOK_SIGNING_SECRET` in the
`zerovault` ZeroVault project. Set `DISCORD_SIGNUP_WEBHOOK_URL` there for the
Discord notification channel. Both secrets are required in `development` and
`production`. See `docs/clerk-webhook.md` for the full setup.

## Domain changes

Changing the Clerk frontend domain reissues the publishable key. Before a
cutover, update the Clerk DNS records, Google OAuth callback, allowed origins,
worker `CLERK_SECRET_KEY`, local dashboard env files, and the Workers Build
`VITE_CLERK_PUBLISHABLE_KEY` value. Verify in a fresh browser session before
retiring old domains.
