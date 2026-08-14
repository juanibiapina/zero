# Plan: `zero login` — browser sign-in for the CLI, no long-lived key on disk

## Goal

A developer runs `zero login`, approves in a browser with their existing Clerk
account (MFA, SSO, passkey — whatever the instance enforces), and every later
`zero …` command works on that machine without `ZERO_API_KEY` ever being set.
The credential on disk becomes an individually revocable, org-scoped OAuth token
pair instead of a permanent `zv_…` key that reaches every secret in the org. It
is not short-lived (see lifetimes below); it is narrower and revocable alone.

Non-goal: removing API keys. Keys stay the credential for CI, servers, and any
unattended runtime. See `docs/plans/oidc-research.md` reasoning summarized under
"Why only humans" below.

## Why (decision + evidence)

**What OIDC actually buys here.** The refresh token still sits on disk, so this
is not "no secret on the laptop". Clerk's published lifetimes bound the claim
further: **OAuth access tokens expire after 1 day, refresh tokens never expire**,
(`clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth`,
"Token expiration and management"; the `default_token_ttl` field in the Backend
API belongs to **Machines** (M2M), not to OAuth applications, so the 1 day is not
tunable). Refresh tokens do rotate with reuse detection, which the docs do not
mention and phase 1 measured (see Risks). Still, do not sell this as
"short-lived credentials".

What it does buy, all real: login passes through the instance's MFA/SSO policy;
the credential is per machine and per user and revocable alone, without rotating
an org-wide key; it is not the same secret used in CI and in a Worker; and it
carries a single `org_id` instead of reaching every org the key's owner can see.

**Why only humans.** Workload identity federation (the CI half of OIDC) needs an
issuer that vouches for the machine. GitHub Actions, GitLab, Vercel, Fly and
Cloud Run have one; a bare VPS does not, and **Cloudflare Workers do not issue
workload OIDC tokens at all**, which is where Zero itself runs. So the key path
must stay. This plan does the half that is fully supported today.

**Clerk supports exactly one flow, verified against the live instance.**

```bash
curl -s https://clerk.zeroapps.dev/.well-known/oauth-authorization-server
```
```json
"grant_types_supported":["authorization_code","refresh_token"],
"code_challenge_methods_supported":["S256"],
"token_endpoint_auth_methods_supported":["client_secret_basic","none","client_secret_post"],
"scopes_supported":["openid","profile","email","public_metadata","private_metadata","offline_access","user:org:read"],
"claims_supported":["sub","iss","aud","exp","iat","email","name","org_id"],
"authorization_endpoint":"https://clerk.zeroapps.dev/oauth/authorize",
"token_endpoint":"https://clerk.zeroapps.dev/oauth/token",
"revocation_endpoint":"https://clerk.zeroapps.dev/oauth/token/revoke"
```

Consequences, each load-bearing:

- **Authorization code + PKCE (S256) only.** There is no
  `device_authorization_endpoint` and no `urn:ietf:params:oauth:grant-type:device_code`.
  A headless box cannot be logged in directly; see "Headless" below.
- `none` in `token_endpoint_auth_methods_supported` means a **public client** is
  supported, so the CLI ships a client id and no secret.
- `offline_access` yields a refresh token, so login survives between runs.
- **`user:org:read` puts an `org_id` claim in the token**, and the consent screen
  shows an organization selector. This is the linchpin: ZeroVault routes every
  Durable Object by `orgId`, so without that claim an OAuth token cannot address
  a vault at all.
- **Loopback redirect on any port works — measured, phase 1.** With only
  `http://127.0.0.1:8976/callback` registered, an authorize request for
  `http://127.0.0.1:9999/callback` was accepted and redirected. The wildcard is
  **port only**: `http://127.0.0.1:9999/other` (path), `http://localhost:9999/callback`
  (host spelling) and `http://127.0.0.2:9999/callback` are all rejected with
  `invalid_request … does not match any of the OAuth 2.0 Client's pre-registered
  redirect urls`, as is `https://example.com/evil-cb`. So: register exactly
  `http://127.0.0.1:8976/callback`, use an ephemeral port, keep the path
  `/callback`, and never use the spelling `localhost`.

**The dashboard Clerk instance is the right one.** `clerk.zeroapps.dev` is the
console instance that `apps/vault-api` already trusts for `/api/*`
(`clerkMiddleware()` in `dashboard-app.ts`), and whose orgs own the vaults. The
agent runs on a *separate* Clerk instance (`docs/console-auth.md`); it is not
involved here.

**Server-side verification is already available.** `apps/vault-api` depends on
`@clerk/backend@3.15.0`, which supports
`authenticateRequest(req, { acceptsToken: ['oauth_token'] })` and returns an
authenticated machine object with `userId`, `clientId` and `scopes`
(`dist/tokens/authObjects.d.ts`, `dist/tokens/tokenTypes.d.ts`). `CLERK_SECRET_KEY`
is already a required Worker secret. That covers authentication but **not**
authorization, per the next paragraph.

**Settled, not open: the SDK cannot give the org.** In the vendored
`@clerk/backend@3.15.0`, the `oauth_token` machine object is typed with exactly
`userId` and `clientId` (plus the shared `id`/`subject`/`scopes`) and explicitly
**no `claims` and no `orgId`**
(`node_modules/.pnpm/@clerk+backend@3.15.0*/node_modules/@clerk/backend/dist/tokens/authObjects.d.ts:91`,
and the comment at :102 "oauth_token won't have claims"). So
`authenticateRequest({ acceptsToken: ['oauth_token'] })` alone cannot authorize a
vault. Two ways to get the org:

1. Verify the JWT access token against the instance JWKS and read `org_id` from
   the payload. Networkless, fits a Worker, blind to revocation for up to 24h.
2. Ask Clerk per request. Both endpoints exist on the live instance
   (`/.well-known/openid-configuration`, absent from the
   `oauth-authorization-server` document quoted above):
   `introspection_endpoint: https://clerk.zeroapps.dev/oauth/token_info`,
   `userinfo_endpoint: https://clerk.zeroapps.dev/oauth/userinfo`. One network
   hop per request, instantly revocable.

**Decision, from phase 1 measurements: keep the default JWT format and verify
remotely with `/oauth/userinfo`, cached.** What the spike established:

- A JWT access token carries `org_id` and `sub`; the `id_token` carries `email`,
  `name` and `org_id`; the access token carries no email.
- `POST /oauth/token_info` returns `active`, `sub`, `org_id` and `scope`, but
  **requires client credentials** (`client_secret_basic`); the Clerk secret key
  is rejected. Using it would mean a new Worker secret. ~345ms from this box.
- `GET /oauth/userinfo` with just the access token returns `sub`, `email`,
  `org_id` and `org_slug`. **No client secret needed.** ~265ms from this box.
- Revocation is instant and total: after `POST /oauth/token/revoke` (public
  client, no secret) the *access* token stopped working at `userinfo` right away,
  and `token_info` reported `active: false`. Local JWT verification would not
  notice for up to 24h.

So the token format is irrelevant to the choice — what matters is local vs remote
check. Take **remote `userinfo`, cached ~60s in KV**: it costs one ~250ms hop on
a cache miss, needs no new secret, and makes `zero logout` and a dashboard revoke
effective within a minute instead of a day. Keep local JWKS verification as the
documented fallback if the hop proves too slow from a Worker, and state the 24h
window out loud if it is ever taken.

## What to change

### 1. Clerk: an OAuth application for the CLI

Dashboard → OAuth applications → new app "Zero CLI":

- **Public** client (no secret), PKCE S256 enforced.
**Already created in phase 1** on the live instance:

- id `oa_3HuG8LoTNK3WoKVWs1FqxZl538p`, **client id `2kOnZBfUZx8kl0KL`**, name
  "Zero CLI".
- `public: true`, `pkce_required: true`, `consent_screen_enabled: true`.
- Redirect URI: `http://127.0.0.1:8976/callback` (single entry; any port matches,
  see above).
- Scopes: `openid profile email offline_access user:org:read`.
- Token format: default (JWT). Not load-bearing — verification is remote, see
  above. Access-token TTL is fixed at 1 day and is not tunable per app.

The create call also returned a client secret. The CLI must not ship it and the
Worker does not need it (`userinfo` takes none); treat it as unused, and rotate
it if the `token_info` fallback is ever adopted.

The client id is not a secret and ships in the CLI source. Record the app's
settings in `docs/console-auth.md`, since they live in Clerk and nothing in the
repo can enforce them.

### 2. `packages/auth`: a second scheme behind one front door

Today `validateApiKey(apikeys, authHeader)` is the whole door: `zv_` prefix →
SHA-256 → KV → `{ orgId, userId }`. Add a sibling that verifies a Clerk OAuth
token and returns the **same shape**, then a dispatcher that picks by token
shape:

```
authenticate(env, authHeader) -> { orgId, userId, via: "api_key" | "oauth" } | null
  zv_…            -> existing KV path (unchanged)
  anything else   -> Clerk OAuth verification via /oauth/userinfo, needs org_id
```

Rules:

- A token without `org_id` is a **401 with a specific message** ("sign in again
  and select an organization"), not a generic invalid-token error. This is the
  failure users will actually hit, because the consent screen makes the org
  selection optional-looking.
- Keep the returned shape identical so `dashboard-app.ts`, both rate limiters
  (keyed by `orgId`) and every route handler stay untouched.
- `packages/auth` today has only `apps/vault-api` as a consumer
  (`apps/vault-api/package.json:18`; `apps/agent-api` does not depend on it), so
  "both Workers import it" is not a reason for anything. The reason to keep the
  Clerk call behind a narrow port injected by `apps/vault-api` is testability:
  the dispatcher's tests then need no network and no Clerk keys.

### 3. `apps/vault-api`: accept both on the API-key surface

`dashboard-app.ts` runs one middleware for `/vault/v1/*` and `/errors/v1/*`.
Swap `validateApiKey` for the dispatcher. Everything downstream (`c.get("orgId")`,
rate limiting, DO routing) is unchanged by construction.

Consequence worth stating: `zero keys create` over an OAuth token means a user
can mint their **first** API key from the terminal, which today requires the
dashboard. That removes the bootstrap step called out in
`apps/docs/.../account/api-keys.md` and in both public skills.

### 4. `packages/zero-cli`: `zero login` / `zero logout` / `zero whoami`

New `auth/oauth.ts`:

- `login`: generate `code_verifier` + S256 challenge, start a one-shot
  `127.0.0.1` listener on the first free port of the registered set (8976-8979),
  open the browser (and **print the URL** for the case where opening fails, which is most SSH sessions), exchange
  the code, store the token set.
- `refresh`: exchange the refresh token when the access token is within ~60s of
  expiry, persist the new pair (rotation-safe: write before use).
- `logout`: call the revocation endpoint, then delete the local record.

Storage: extend the existing `~/.config/zero/config.json` (already 0600 inside a
0700 dir, already the home of contexts) with a `logins` map keyed by base URL:
`{ accessToken, refreshToken, expiresAt, userId, orgId }`. **Do not** add an OS
keychain dependency in this slice: the file already holds plaintext `zv_` keys,
so a keychain would be an inconsistent half-measure. Note it as a follow-up.

Precedence, extending `resolveAuth` (`config.ts`), most explicit first:

1. `--api-key` flag
2. directory-bound context
3. `ZERO_API_KEY` env
4. stored login for the resolved base URL

Rationale: a login is ambient machine state, like the env var but less explicit,
so it sits last. `zero whoami` gains a line saying which credential answered
("api key" vs "signed in as <email>"), because otherwise a stale env var
silently shadows a fresh login and nothing tells the user. The email does **not**
come from the API: `/vault/v1/whoami` returns only `userId` and `orgId`
(`apps/vault-api/src/dashboard-app.ts:78`). Store the `id_token`'s `email` claim
at login and print that, or call `/oauth/userinfo`.

### 5. Headless machines

No device flow exists on this instance, so `zero login` on a box with no browser
must fail with instructions rather than hang:

> No browser available. Either forward the callback port
> (`ssh -L 8976:127.0.0.1:8976 …`) and run `zero login --port 8976`, or use an
> API key: `export ZERO_API_KEY=…`.

A `--port` flag makes the SSH-forward path deterministic. Building a Zero-owned
device flow (`POST /vault/v1/device/code`, approval page on `dash.zeroapps.dev`)
is the real fix and is **out of scope**; note it in the doc as the known gap.

## System-wide impact

- No change to `zv_` keys, KV values, DO routing, or any existing route.
- `apps/vault-api` gains a Clerk dependency on the `/v1` path, which previously
  needed no network call to authenticate. A Clerk outage would break OAuth
  requests while API-key requests keep working — worth saying out loud in
  `docs/console-auth.md`.
- Latency: every `/v1` request on an OAuth credential costs one `userinfo` call
  (~265ms measured from a dev box, unmeasured from a Worker) unless it hits the
  ~60s KV cache. If that dominates, the fallback is local JWKS verification, at
  the cost of a 24h revocation window.
- The public `zero-skills` repo documents "create your first key in the
  dashboard". If step 3 lands, that sentence changes in the same PR, per the
  repo's source-of-truth rule.

## Implementation phases

Each is a separate commit; 1-2 can land before any CLI work is visible.

1. ~~**Spike**~~ **Done.** OAuth app created, full PKCE flow run against the live
   instance with a real user. Findings are folded into the sections above:
   loopback port wildcard yes / path and host exact; `org_id` present in the
   access token, id token and `userinfo`; `expires_in` 86399; refresh rotates
   with family-wide reuse detection; revocation is immediate and needs no client
   secret; `token_info` needs client credentials, `userinfo` does not.
2. ~~**Server**~~ **Done.** `authenticate()` dispatcher plus the
   `createClerkOAuthVerifier` adapter, both in `packages/auth` (the adapter
   needs only `fetch` and KV, so its tests run on any box; in `apps/vault-api`
   they would need workerd and run only in CI). `dashboard-app.ts` calls the
   dispatcher for `/vault/v1/*` and `/errors/v1/*`, and takes an injected
   verifier so route tests need no Clerk. Verified with a real token from the
   live instance: `{ok:true, auth:{orgId, userId, via:"oauth"}}`, second call
   served from cache.
3. **CLI:** `zero login` / `logout`, storage, refresh, precedence, and `whoami`
   reporting the credential in use.
4. **Docs + skills:** `apps/docs/src/content/docs/cli/overview.mdx` gains a
   "Sign in" section ahead of the API-key section; `account/api-keys.md` stops
   claiming the first key must come from the dashboard; `docs/console-auth.md`
   records the OAuth app; both `zero-skills` files updated; root `CHANGELOG.md`
   entry.

## Test strategy

- `packages/auth`: 17 local tests — dispatcher (prefix routing, missing
  `org_id`, expired, malformed, `zv_` path untouched, verifier never called for
  a `zv_` token) and the Clerk adapter (host derived from the publishable key,
  org-less token, revoked token, Clerk unreachable, cache hit, token never used
  as a cache key, failures not cached).
- `apps/vault-api`: route-level tests through `createDashboardApp` for both
  credential types on `/vault/v1/*` and `/errors/v1/*`. **These cannot run on
  this dev box** (workerd will not start on NixOS); CI is the gate, so keep the
  local unit coverage in `packages/auth` meaningful.
- `packages/zero-cli`: `resolveAuth` precedence including a stored login;
  refresh-when-expiring; the no-browser error text; and a stub-server test that a
  logged-in CLI sends `Authorization: Bearer <access token>`. Reuse the existing
  `commands.test.ts` harness (a real child process against a local HTTP server;
  it must stay async — a synchronous spawn deadlocks the stub server).
- Do **not** write a test that performs a real Clerk login.

## Risks and open questions

- **`org_id` may be absent** for a user with no organization. The consent screen
  shows the org (verified: "Juan's Organization" on the live screen) and the
  claim came through, but a user with zero orgs was not tested. Still a product
  decision: does `zero login` refuse, or point at the dashboard to create an org?
  Decide before phase 3.
- **Multi-org users** get one org per token. Contexts already model "one machine,
  several orgs"; a login should probably create/refresh a context rather than a
  single global record. Revisit once phase 1 shows what the token carries.
- **Refresh tokens never expire, but they do rotate, and reuse is detected.**
  Measured in phase 1: a refresh returns a new refresh token, and replaying the
  old one fails with `invalid_grant` **and kills the whole family** — the just
  issued refresh token stopped working too, and the access token went
  `active: false`. Undocumented but real, and it makes theft self-limiting. The
  CLI must therefore persist the rotated pair before using it; a crash between
  refresh and write logs the user out (acceptable: `zero login` again).
  Still never advertise "short-lived": absent a reuse event, the on-disk
  credential is permanent until revoked.
- **Clerk becomes a runtime dependency of the `/v1` API surface**, and with
  opaque tokens it is a per-request dependency, not a first-fetch one. A Clerk
  outage breaks every OAuth request beyond the cache TTL while API-key requests
  keep working. Accept, and document the degradation mode.
- **Scope creep magnet:** device flow, keychain storage, per-project scoping of
  tokens, and OIDC federation for CI are all adjacent and all out of scope here.

## Skills to use

- `tdd` — the dispatcher and every CLI behavior.
- `cli-design` — `login`/`logout` UX, the no-browser failure, stdout/stderr split.
- `codebase-design` — keeping the Clerk adapter behind a port so `packages/auth`
  stays thin.
- `api-design` — the 401 semantics for a token without an org.
- `technical-writing`, `changelog`, `git-commit`, `open-pr`.

## Acceptance criteria

- On a machine with no `ZERO_API_KEY` and no context, `zero login` then
  `zero vault projects list` works, and `zero whoami` says which account and org
  answered.
- `zero errors issues list` works with the same login (one credential, both
  products).
- `zero keys create` works over a login, so a brand-new user never has to visit
  the dashboard for a first key.
- `zero logout` makes the next command fail with the no-credential error, and the
  refresh token is revoked server-side (a stolen copy is useless).
- An existing `ZERO_API_KEY` user sees no change whatsoever.
- A token without `org_id` produces a 401 whose message names the fix.
