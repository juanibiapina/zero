# GitHub Integration

Zero connects to GitHub in two distinct ways. Don't confuse them:

| Purpose | Identity | Credential |
|---------|----------|------------|
| **User sign-in** (log in with GitHub) | OAuth App "Zero" | Clerk-vended OAuth token (`read:user`, `user:email`) |
| **Repo actions** (clone, commit, push, PR) | GitHub App `zerocoding-app` | short-lived installation access token |

Sign-in only proves who you are. It does **not** grant repo access — the
Clerk-vended token carries login scopes only. All repository work is done
by the **GitHub App acting as itself** (`zerocoding-app[bot]`), not as the
user.

## How repo access works

1. The user installs the GitHub App on their own GitHub account (on
   GitHub's site), choosing which repositories Zero may touch. This
   install is the permission grant — there is no in-app "connect" button
   like the Google one; it's a hand-off to GitHub.
2. When the container needs GitHub, the worker mints a fresh **installation
   access token** (`apps/api/src/github-token.ts`):
   - sign an app JWT (RS256) with the app's private key,
   - find the user's installation via their connected GitHub username
     (`GET /users/{username}/installation`),
   - exchange the JWT for an installation token
     (`POST /app/installations/{id}/access_tokens`), valid ~1 hour.
3. The token is **never injected directly** into the container. It rides
   through `setOutboundHandler('substitute', { overrides })` so the
   container's env only holds the sentinel `Z3R0-FAKE-GH_TOKEN`. The
   outbound proxy swaps the sentinel for the real token on egress to
   github.com — including inside `Authorization: Basic` headers, so
   `git push` works (see `docs/design.md` "Secret Proxying" and the
   Basic-auth-aware branch in `secret-proxy.ts`).

The worker never persists the token; it expires within the hour and is
re-minted on the next container start.

## Why the GitHub App (not an OAuth `repo` token)

- **Least privilege**: the user picks exact repositories at install time,
  rather than granting the coarse OAuth `repo` scope (all repos).
- **Short-lived**: installation tokens last ~1h; nothing long-lived sits
  in the container.
- **Bot identity**: commits and PRs are attributed to
  `zerocoding-app[bot]`, which is the expected behaviour for an agent.
- **No extra UI**: repo selection lives in GitHub's install screen.

## When the user hasn't installed the app

`getGithubInstallationToken` returns `null` (no connected GitHub account,
no installation, or GitHub unreachable) and never throws — mirroring the
Google flow. The worker omits the `GH_TOKEN` sentinel, and any in-container
`git`/`gh` call fails with a clean auth error rather than blocking startup.

## Admin visibility

`/admin` shows a per-user **GitHub** column (backed by
`GET /api/admin/github/status?userId=…`) reporting whether each user has
connected GitHub, whether the app is installed, and whether a token can be
minted — without ever exposing the token itself.

## Secrets

Stored in the `zero-api` Doppler project:

- `GITHUB_APP_ID` — the app's numeric id.
- `GITHUB_APP_PRIVATE_KEY` — **PKCS#8** PEM (`BEGIN PRIVATE KEY`). GitHub
  issues a PKCS#1 key (`BEGIN RSA PRIVATE KEY`); it must be converted with
  `openssl pkcs8 -topk8 -nocrypt` because the Workers runtime (Web Crypto /
  `jose`) only imports PKCS#8.
- `GITHUB_WEBHOOK_SECRET` — provisioned; webhooks are not yet wired up.
