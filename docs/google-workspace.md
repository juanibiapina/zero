# Google Workspace Integration

The Zero web app has a "Connect Google" button that grants the bot
access to your Gmail, Calendar, and Drive via Clerk's Google OAuth.

> **Status: connect-plumbing only.** The connect button, the OAuth
> handshake, scope tracking, admin visibility, and access-token minting
> all exist, but there is **no consumer** yet. The per-user container that
> used to call the Google APIs (via the `gmcli`/`gccli`/`gdcli` CLIs behind
> a secret proxy) was removed with the container runtime (see
> `docs/design.md`). `getGoogleAccessToken` and `getGoogleAccountEmail` in
> `apps/api/src/google-token.ts` are currently unused; they are the
> reattachment point for a future meta-agent Google tool.

## How connecting works

1. The frontend calls Clerk's
   `user.createExternalAccount({ strategy: 'oauth_google', additionalScopes: [...] })`.
   Clerk handles the OAuth handshake with Google and stores the refresh
   token. The button lives in the settings and onboarding pages
   (`apps/web/src/pages/SettingsPage.tsx`, `Onboarding.tsx`).
2. A consumer that needs Google mints a fresh access token by calling
   Clerk's Backend API
   (`users.getUserOauthAccessToken(clerkUserId, 'google')`, wrapped by
   `getGoogleAccessToken`). Tokens expire within an hour and are re-minted
   on demand; the worker never persists them.
3. `getGoogleAccountEmail` sources the account's real address from Clerk
   (needed as the Gmail `From:` and as the CLI credential-store key when a
   consumer is wired up).

## Scopes requested

The "Connect Google" button is all-or-nothing across three scopes,
defined in `apps/web/src/google-scopes.ts`:

| Scope | Lets the bot |
|-------|--------------|
| `gmail.modify` | Read your mail, send mail as you, modify labels |
| `calendar` | Read and write your calendars and events |
| `drive` | Read and write your Drive files |

If you later add a fourth scope, bump the array and existing users see the
button switch to "Grant required scopes" (driven by the `missingScopes`
helper) until they re-consent.

## When the user hasn't connected Google

`getGoogleAccessToken` returns `null` and never throws — a Google outage or
an unconnected user must not block a turn.

## Revoking

Two ways:

- **In the app**: click "Disconnect" on the Google Workspace card. The
  Clerk `ExternalAccountResource.destroy()` call removes the connection.
- **At Google**: visit
  [`myaccount.google.com`](https://myaccount.google.com/permissions) and
  revoke the "Zero" app. Clerk's next `getUserOauthAccessToken` call throws
  or returns empty; the helper logs `google_token_unavailable`.

## Dev environment caveat

Clerk's shared development credentials only request the minimum
`email/profile/openid` scopes from Google; `additionalScopes` is silently
ignored on the dev instance. To exercise the full flow locally, either:

1. **Reuse the prod OAuth client for dev** (recommended for this
   single-user app): add the dev Clerk Frontend API's `/v1/oauth_callback`
   URI as a second authorized redirect on the existing `zero-496518` OAuth
   client in Google Cloud, then switch the dev Clerk instance's Google
   connection to "custom credentials" with the same `client_id` +
   `client_secret`. Trade-off: dev tokens grant real Google access to your
   real account.
2. Or skip local testing and verify only in prod. The connect button is
   the only path that's environment-sensitive.
