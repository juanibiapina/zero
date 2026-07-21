# Google Workspace Integration

The Zero web app has a "Connect Google" button that grants the bot
access to your Gmail, Calendar, and Drive via Clerk's Google OAuth.

> **Status: wired (Gmail + Calendar).** The interface agent has in-Worker
> Gmail and Calendar tools that call Google's REST APIs (`gmail/v1`,
> `calendar/v3`) directly with a bearer token — no container, no CLIs. The
> old per-user container (`gmcli`/`gccli`/`gdcli` behind a secret proxy)
> was removed with the container runtime (see `docs/design.md`) and
> replaced by plain `fetch` adapters. See `docs/google-tools.md` for the
> port/adapter, the tool list, the Gmail id spaces, the calendar/timezone
> contract, and the confirmation policy.
>
> **Approach.** A `GoogleWorkspace` port (`apps/agent-api/src/google/types.ts`)
> hides all REST/MIME/base64url detail; a REST adapter
> (`google/rest.ts`) serves production and an in-memory adapter
> (`google/memory.ts`) serves tests, mirroring the WebSearch seam.
> `createGoogleWorkspace` takes a **token provider** (`() => Promise<string
> | null>`), not a raw token, so a turn that never touches Google mints
> nothing. The DO memoizes the provider per turn
> (`memoizeTokenProvider`) so multiple Google tool calls share one Clerk
> round-trip. REST calls use `users/me` (Gmail) and `calendarList` +
> `calendars/{id}/events` (Calendar), so no account email is needed;
> `primary` is the default write target. `getGoogleAccountEmail` remains
> **unused** (available if a `From:` display is ever wanted). Drive is
> still unwired.
>
> **Confirmation policy.** Reads (`gmail_search`, `gmail_thread`,
> `calendar_list_calendars`, `calendar_list_events`) run freely; the
> side-effecting `gmail_send` and `calendar_create_event` require explicit
> user confirmation of the exact content first (enforced by the interface
> prompt, not a hard guard — an accepted v1 risk).

## How connecting works

1. The frontend calls Clerk's
   `user.createExternalAccount({ strategy: 'oauth_google', additionalScopes: [...] })`.
   Clerk handles the OAuth handshake with Google and stores the refresh
   token. The button lives in the settings and onboarding pages
   (`apps/agent-web/src/pages/SettingsPage.tsx`, `Onboarding.tsx`).
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
defined in `apps/agent-web/src/google-scopes.ts`:

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
an unconnected user must not block a turn. The REST adapter turns a `null`
token into a typed `GoogleNotConnectedError`; the tool layer converts that
to `{ error: "Google isn't connected..." }` data (never a throw), so the
model tells the user to connect it in the Zero app and the turn completes
normally. A `401` from Google (revoked grant or missing scope) maps to a
distinct error message.

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
