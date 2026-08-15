# GitHub Integration

Zero connects to GitHub in two distinct ways. Don't confuse them:

| Purpose | Identity | Credential |
|---------|----------|------------|
| **User sign-in** (log in with GitHub) | OAuth App "Zero" | Clerk-vended OAuth token (`read:user`, `user:email`) |
| **Repo actions** (clone, commit, push, PR) | GitHub App `zerocoding-app` | short-lived installation access token |

Sign-in only proves who you are. It does **not** grant repo access — the
Clerk-vended token carries login scopes only. Repository work is meant to
be done by the **GitHub App acting as itself** (`zerocoding-app[bot]`), not
as the user.

> **Status: connect-plumbing only.** The GitHub App, the install flow, and
> the installation-token minting all exist, but there is **no consumer**
> yet. The per-user container that used to clone/commit/push was removed
> with the container runtime (see `docs/design.md`). `getGithubInstallationToken`
> in `apps/agent-api/src/github-token.ts` is currently unused; it is the
> reattachment point for a future meta-agent GitHub tool.

> **Capability granted by the app.** `contents: write`,
> `pull_requests: write`, `issues: write`, and `workflows: write`. When a
> consumer is wired up, all changes should land via a feature branch + PR
> the user reviews and merges; there is no branch-protection backstop.

## How repo access works

1. The user installs the GitHub App on their own GitHub account (on
   GitHub's site), choosing which repositories Zero may touch. This
   install is the permission grant — there is no in-app "connect" button
   like the Google one; it's a hand-off to GitHub.
2. When a consumer needs GitHub, the worker mints a fresh **installation
   access token** (`apps/agent-api/src/github-token.ts`):
   - sign an app JWT (RS256) with the app's private key,
   - find the user's installation via their connected GitHub username
     (`GET /users/{username}/installation`),
   - exchange the JWT for an installation token
     (`POST /app/installations/{id}/access_tokens`), valid ~1 hour.

The worker never persists the token; it expires within the hour and is
re-minted on demand.

## Why the GitHub App (not an OAuth `repo` token)

- **Least privilege**: the user picks exact repositories at install time,
  rather than granting the coarse OAuth `repo` scope (all repos).
- **Short-lived**: installation tokens last ~1h.
- **Bot identity**: commits and PRs are attributed to
  `zerocoding-app[bot]`, the expected behaviour for an agent.
- **No extra UI**: repo selection lives in GitHub's install screen.

## When the user hasn't installed the app

`getGithubInstallationToken` returns `null` (no connected GitHub account,
no installation, or GitHub unreachable) and never throws — mirroring the
Google flow.

## Admin visibility

`/admin` shows a per-user **GitHub** column (backed by
`GET /api/admin/github/status?userId=…`, `getGithubInstallationStatus`)
reporting whether each user has connected GitHub, whether the app is
installed, and whether a token can be minted — without ever exposing the
token itself.

## Secrets

Stored in the `zero-api` ZeroVault project:

- `GITHUB_APP_ID` — the app's numeric id.
- `GITHUB_APP_PRIVATE_KEY` — **PKCS#8** PEM (`BEGIN PRIVATE KEY`). GitHub
  issues a PKCS#1 key (`BEGIN RSA PRIVATE KEY`); it must be converted with
  `openssl pkcs8 -topk8 -nocrypt` because the Workers runtime (Web Crypto /
  `jose`) only imports PKCS#8.
There is no webhook secret. One was provisioned before any webhook code
existed, went unread for months, and was removed. When webhooks are wired up,
generate a fresh secret in the GitHub App settings, store it as
`GITHUB_WEBHOOK_SECRET` in both environments, and add it to `secrets.required`
in `apps/agent-api/wrangler.jsonc` so a deploy without it fails.
