# Google Workspace Integration

The Zero web app has a "Connect Google" button that grants the bot
access to your Gmail, Calendar, and Drive. Once connected, pi (running
inside the per-user agent container) can call those APIs on your behalf
via the `gmcli` (Gmail), `gccli` (Calendar), and `gdcli` (Drive) CLIs.

These are minimal Node clients (Mario Zechner's) chosen because they use
OpenSSL: they tolerate the Cloudflare intercepting proxy tearing down
TLS without a `close_notify`, where the previous rustls-based `gws`
treated that as a hard error and failed every request behind the proxy.

## How it works

1. The frontend (`<GoogleConnect />` in `apps/web/src/App.tsx`) calls
   Clerk's `user.createExternalAccount({ strategy: 'oauth_google',
   additionalScopes: [...] })`. Clerk handles the OAuth handshake with
   Google and stores the refresh token.
2. On every Telegram message, the worker's `AgentContainer.fetch`
   calls Clerk's Backend API
   (`users.getUserOauthAccessToken(clerkUserId, 'google')`) to mint a
   fresh access token. The token is **never injected directly** into
   the container. Instead the worker pushes it through
   `setOutboundHandler('substitute', { overrides })` so the container's
   `GOOGLE_WORKSPACE_CLI_TOKEN` env var only ever contains a constant
   sentinel (`Z3R0-FAKE-GOOGLE_WORKSPACE_CLI_TOKEN`). The catch-all
   outbound handler swaps the sentinel for the real token on the way
   to Google.
3. The container's `entrypoint.sh` writes a small `accounts.json` for
   each CLI under pi's HOME (`~/.gmcli`, `~/.gccli`, `~/.gdcli`), with
   the sentinel as the account's `accessToken` and no `expiry_date`. The
   clients build a googleapis `OAuth2Client` and send the sentinel
   verbatim in the `Authorization: Bearer …` header; with no expiry the
   client never tries to refresh, so the sentinel reaches egress
   unmodified and the worker substitutes the real token on the way to
   `*.googleapis.com`. These HOME files are non-persistent and rewritten
   fresh on each cold start.
4. The account `email` keys the CLIs' local credential store and is
   stamped into the `From:` header of outgoing Gmail, so it must be the
   user's real address. The worker sources it from Clerk
   (`getGoogleAccountEmail`) and injects it as the plaintext, non-secret
   `GOOGLE_ACCOUNT_EMAIL` env var (no sentinel, no substitution).

The worker never persists the access token, and Clerk never sees the
plaintext API responses. Tokens expire within an hour and are
re-minted on the next container start. See `docs/design.md` “Secret
Proxying” for the mechanism.

## Scopes requested

The "Connect Google" button is all-or-nothing across three scopes,
defined in `apps/web/src/google-scopes.ts`:

| Scope | Lets the bot |
|-------|--------------|
| `gmail.modify` | Read your mail, send mail as you, modify labels |
| `calendar` | Read and write your calendars and events |
| `drive` | Read and write your Drive files |

If you later want to add a fourth scope, bump the array and existing
users will see the button switch to "Grant required scopes"
(driven by the `missingScopes` helper) until they re-consent.

## When the user hasn't connected Google

`getGoogleAccessToken` returns `null`, the worker omits the
`GOOGLE_WORKSPACE_CLI_TOKEN` sentinel from `envVars` entirely (and so
also omits `GOOGLE_ACCOUNT_EMAIL`), and the override map pushed to
`setOutboundHandler` is empty. The entrypoint then skips the
`accounts.json` bootstrap, so any `gmcli`/`gccli`/`gdcli` invocation
exits non-zero with a "no account" error — pi sees that as a tool
failure and can respond accordingly. No worker-side error, no failed
container start.

## Revoking

Two ways:

- **In the app**: click "Disconnect" on the Google Workspace card. The
  Clerk `ExternalAccountResource.destroy()` call removes the
  connection. The next container fetch sees no Google token and omits
  the `GOOGLE_WORKSPACE_CLI_TOKEN` sentinel from `envVars`.
- **At Google**: visit
  [`myaccount.google.com`](https://myaccount.google.com/permissions)
  and revoke the "Zero" app. Clerk's next `getUserOauthAccessToken`
  call throws (or returns empty); the helper logs
  `google_token_unavailable` and the sentinel is omitted as above.

## Dev environment caveat

Clerk's shared development credentials only request the minimum
`email/profile/openid` scopes from Google; `additionalScopes` is
silently ignored on the dev instance. To exercise the full flow
locally, either:

1. **Reuse the prod OAuth client for dev** (recommended for this
   single-user app): add the dev Clerk Frontend API's
   `/v1/oauth_callback` URI as a second authorized redirect on the
   existing `zero-496518` OAuth client in Google Cloud, then switch
   the dev Clerk instance's Google connection to "custom credentials"
   with the same `client_id` + `client_secret`. Trade-off: dev tokens
   grant real Google access to your real account. Fine here, less so
   for multi-tenant setups.
2. Or skip local testing and verify only in prod. The connect button
   is the only path that's environment-sensitive — the worker side
   works identically in `wrangler dev` as long as a real access token
   is available.
