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

A token's org is fixed at sign-in and cannot be re-scoped, so reaching a second
organization means a second sign-in. The CLI therefore stores logins keyed by
origin **plus org** (`https://api.zeroapps.dev#org_…`), with the bare origin key
still holding the machine-wide sign-in. A named context can point at one of
them, which is how a project directory runs against another organization
(`zero login --context <name>`). Because the consent screen offers the session's
active organization, a repeat sign-in can return the same org; the CLI reports
that rather than storing a duplicate silently.

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

## CI federation (GitHub Actions)

`POST /vault/v1/ci/token` trades a GitHub Actions OIDC token for a 15-minute
`zci_` credential, so a workflow needs no API key. Design notes that are not
obvious from the code:

- The route is mounted **before** the `/vault/v1/*` auth middleware in
  `dashboard-app.ts`. It issues a credential, so it cannot require one; moving
  it below the middleware would make every exchange fail with "Invalid API key".
- Trust binds to GitHub's numeric `repository_id` / `repository_owner_id`, never
  `sub`. Repos created after 2026-07-15 emit
  `repo:OWNER@OWNER-ID/REPO@REPO-ID:…`, older ones keep the old shape, and a
  rename moves a repo between them.
- Tokens must carry `aud: https://api.zeroapps.dev`. GitHub's default audience
  is the owner URL, and the audience is caller-chosen, so this only stops replay
  of a token minted for another provider — the trust record is the real check.
- `pull_request`, `pull_request_target` and `workflow_run` need an explicit
  opt-in per event. Measured 2026-08-14: a fork's `pull_request` gets no token,
  but its `pull_request_target` gets one with the **base** repo's ids and
  `ref: refs/heads/main`, so a ref constraint does not contain it.
- Measured token facts: 5-minute lifetime, `nbf` backdated 5 minutes, so only
  `exp` needs a skew allowance.
- The repository→org index lives in KV (`ci:github:<owner_id>/<repo_id>`), which
  is eventually consistent: a run seconds after `zero ci trust add` can still be
  refused. The CLI says so; the docs say so.
- The minted `zci_` token is **signed, not stored**: payload plus HMAC, with the
  key derived from `MASTER_KEY` by HKDF. The first version put a random token in
  KV, and a job read it back milliseconds later — that read missed in production
  and the build failed with "Invalid API key". Verification is now local, so the
  request path has no KV read and no race. The trade is that a CI token cannot be
  revoked before it expires, which the KV version could not do either.
- The endpoint is unauthenticated, so it is rate limited by connecting IP
  (`CI_TOKEN_RATE_LIMITER`). Limiting by the repository ids in the body would be
  useless: they are attacker-chosen until the signature is checked.

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
