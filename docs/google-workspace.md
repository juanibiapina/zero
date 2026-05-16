# Google Workspace Integration

The Zero web app has a "Connect Google" button that grants the bot
access to your Gmail, Calendar, Drive, and Sheets. Once connected, pi
(running inside the per-user agent container) can call any of those
APIs on your behalf via the `gws` CLI.

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
3. `gws` reads the sentinel from the env var, includes it in the
   `Authorization: Bearer …` header, and the worker substitutes the
   real token on egress to `*.googleapis.com`.

The worker never persists the access token, and Clerk never sees the
plaintext API responses. Tokens expire within an hour and are
re-minted on the next container start. See `docs/design.md` “Secret
Proxying” for the mechanism.

## Scopes requested

The "Connect Google" button is all-or-nothing across four scopes,
defined in `apps/web/src/google-scopes.ts`:

| Scope | Lets the bot |
|-------|--------------|
| `gmail.modify` | Read your mail, send mail as you, modify labels |
| `calendar` | Read and write your calendars and events |
| `drive` | Read and write your Drive files |
| `spreadsheets` | Read and write your Google Sheets |

If you later want to add a fifth scope, bump the array and existing
users will see the button switch to "Grant required scopes"
(driven by the `missingScopes` helper) until they re-consent.

## When the user hasn't connected Google

`getGoogleAccessToken` returns `null`, the worker omits the
`GOOGLE_WORKSPACE_CLI_TOKEN` sentinel from `envVars` entirely, and the
override map pushed to `setOutboundHandler` is empty. Any `gws`
invocation inside the container then exits non-zero with an “auth
error” — pi sees that as a tool failure and can respond accordingly.
No worker-side error, no failed container start.

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
