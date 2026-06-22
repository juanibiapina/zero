# Plan: GitHub development capability for Zero (0.2)

Goal: let Zero clone a user's GitHub repositories, make changes, commit,
push, and open pull requests on the user's behalf — the same workflow the
current dev agent used to ship the "silent notes" change.

This is broken into features that stack. Each builds on the previous one
and is independently shippable/verifiable. The hard part is not the UI or
the Clerk wiring (we already do this for Google) — it's getting a GitHub
credential to `github.com` through the secret proxy without the container
ever seeing the real token, especially for `git push`. That is de-risked
first in Phase 0.

## Status & key decision (update)

- **Phase 0 (proxy spike)** — DONE.
- **Phase 2a (Basic-auth-aware proxy)** — DONE.
- **Phase 1 (GitHub login via Clerk)** — DONE and live in prod. This is a
  classic OAuth App ("Zero") used purely for sign-in; its Clerk-vended
  token only carries `read:user` / `user:email` and is **not** used for
  repo work.
- **Repo credential decision — use the GitHub App, not OAuth `repo`.**
  Research showed the login token lacks repo scope, while the GitHub App
  `zerocoding-app` is already installed (all repos). So repo work uses
  short-lived **installation tokens** minted from the app key — the
  least-privilege path the original plan deferred to "later" is adopted
  now. Commits/PRs are attributed to `zerocoding-app[bot]`. This replaces
  the OAuth-token plan in Phase 2 below. See `docs/github.md`.
- **Phase 2 (token plumbing) — DONE.** Worker-side installation token
  minting landed: `apps/api/src/github-token.ts`
  (`getGithubInstallationToken` + `getGithubInstallationStatus`), plus an
  admin verification surface (`GET /api/admin/github/status`, shown on
  each user's `/admin/users/{userId}` detail page). The app private key in ZeroVault was converted
  PKCS#1 → PKCS#8 (Workers/`jose` require PKCS#8). `AgentContainer`
  injects `GH_TOKEN` as a sentinel (omitted when the user has no
  installation). Verified end-to-end against real GitHub.
- **Phase 3 + 4 (tooling + skill) — DONE (read-only).** `git` + `gh`
  installed in the container image; `git` auth via a credential helper
  that emits the `$GH_TOKEN` sentinel as the HTTP Basic password. Added
  the read-only `github` skill (clone to `/workspace/repos/<owner>/<repo>`,
  reuse clones, read code/issues/PRs). Scoped read-only on purpose: the
  app still has `contents: read`, so `git push` is rejected by GitHub.
- **Write access — DONE.** Bumped the app's permissions (`contents`
  read → write, plus `pull_requests: write`, `issues: write`,
  `workflows: write`), added the `zerocoding-app[bot]` git identity to the
  container gitconfig (`262345351+zerocoding-app[bot]@users.noreply.github.com`),
  and rewrote the `github` skill with branch/commit/push/PR/issue flow.
  **Behavioral boundary, not a permission boundary:** Zero gets
  `contents: write` (needed to push feature branches) but **never pushes to
  the default branch** — it always branches and opens a PR. The boundary is
  enforced by the skill + Prime Directives only; no branch protection, per
  decision. Model A (same-repo branch + PR). Re-approval of each existing
  installation is required after the permission bump.

## What we can reuse (the Google blueprint)

The Google Workspace integration already implements the exact shape we
need. GitHub mirrors it almost 1:1:

| Concern | Google (today) | GitHub (to build) |
| --- | --- | --- |
| OAuth login | Clerk `oauth_google` external account, `apps/web/src/pages/SettingsPage.tsx` `GoogleConnect` | Clerk `oauth_github`, new `GitHubConnect` card |
| Scopes | `apps/web/src/google-scopes.ts` | new `github-scopes.ts` (`repo`, `read:org`, `workflow`) |
| Token fetch | `apps/api/src/google-token.ts` → Clerk Backend API | `github-token.ts`, same pattern |
| Token injection | `AgentContainer.refreshEnvVars` pushes `GOOGLE_WORKSPACE_CLI_TOKEN` override + sentinel | add `GH_TOKEN` runtime secret |
| Secret hiding | `secret-proxy.ts` byte-substitutes sentinel → real on egress | reuse; **see Phase 0 caveat** |
| In-container CLI | `gmcli`/`gccli`/`gdcli` (installed in Dockerfile, read token from injected `accounts.json`) | `git` + `gh` (to install) |
| Onboarding skill | `skills/google-onboarding` | new `skills/github` conventions skill |

The persisted `/workspace` tree means cloned repos survive container
sleep/wake for free, as long as we clone under `/workspace`.

## Phase 0 — Spike: get a token to github.com through the proxy — DONE

**Why first:** the secret proxy (`apps/api/src/secret-proxy.ts`) does a
raw byte substitution of the sentinel `Z3R0-FAKE-<NAME>` in the URL,
headers, and body of every outbound request. This works when the token
appears verbatim. It does **not** work when the token is transformed
(e.g. base64-encoded) before it leaves the container.

### Findings (verified against github.com)

1. **`gh` API calls** send `Authorization: token <TOKEN>` — the sentinel
   appears verbatim, so the existing proxy substitutes it cleanly. Works
   with no changes.
2. **`git push` over HTTPS** uses HTTP Basic auth only — GitHub's
   smart-HTTP endpoints advertise `WWW-Authenticate: Basic realm="GitHub"`
   and nothing else. The token rides inside
   `Authorization: Basic base64("x-access-token:<TOKEN>")`, so the raw
   sentinel never appears on the wire and the current proxy misses it.
   This is the real blocker.
3. **Bearer is not a reliable path.** A dummy `Authorization: Bearer ...`,
   `Token ...`, and even a garbage `Frobnicate ...` all return the same
   generic `401 invalid credentials`, while Basic returns a distinct
   message. GitHub does not advertise or specially handle Bearer for git
   smart-HTTP, so we will not depend on it.
4. **base64 alignment is real but fragile.** Because `x-access-token:` is
   exactly 15 bytes (a multiple of 3), `base64("x-access-token:" + X)`
   contains `base64(X)` verbatim as a suffix. So a base64-template
   substitution *could* work — but only while the sentinel sits at a
   3-byte-aligned offset, and a real token of a different length shifts
   the base64 phase of anything after it. Too brittle to rely on.

### Decision: make the proxy Basic-auth-aware

Enhance `secret-proxy.ts`: when an outbound request carries
`Authorization: Basic <b64>`, base64-decode the value, run the existing
sentinel→real substitution on the decoded `user:pass`, and re-encode.
This is a small, contained change to a file we already own and trust, and
it makes the substitution robust regardless of username/alignment. Net
result: **one GitHub token injected as a sentinel in container env makes
both `gh` and `git push` work, exactly as if it were the user's own
machine.** `gh` API traffic keeps working through the existing verbatim
path; only the Basic-auth branch is new.

### SSH is out of scope (and unnecessary)

Some users push via SSH locally, but SSH is neither viable nor needed in
the container:

- SSH auth needs the user's **private key**, which we cannot obtain (it
  lives on their machine; Clerk doesn't store it). Generating a keypair
  in the container and registering the public key via the API would need
  extra `write:public_key` scope and would modify the user's account —
  invasive and avoidable.
- Container egress is HTTP-based; raw TCP/SSH on port 22 wouldn't carry
  our token and may not be supported.
- **How the user pushes locally is irrelevant.** Zero owns the clone in
  the container, so we always normalize remotes to
  `https://github.com/<owner>/<repo>.git` and push with the OAuth token
  over HTTPS. SSH-preferring users are fully served.

**Exit criteria (met by analysis; re-verify end-to-end in Phase 2/3):**
with only a sentinel in env, `gh api user` works today, and `git push`
works once the Basic-aware substitution lands.

## Phase 2a — Basic-auth-aware secret proxy (testing plan)

First concrete implementation step, done TDD. The proxy
(`apps/api/src/secret-proxy.ts`) gains a branch that decodes
`Authorization: Basic <b64>` header values, runs the existing
sentinel→real substitution on the decoded `user:pass`, and re-encodes,
so `git push` (which only sends Basic auth) works with an injected
sentinel.

Tested through the public `outbound` handler by stubbing global `fetch`
and asserting on the forwarded request (no implementation-detail tests).
Behaviors, in TDD order:

1. **Regression — verbatim header substitution** still swaps a sentinel
   that appears raw in a header value (locks existing behavior; builds
   the harness).
2. **Basic auth, token as password** —
   `Authorization: Basic base64("x-access-token:<sentinel>")` is
   forwarded as `base64("x-access-token:<real>")`.
3. **Basic auth, token as username** —
   `base64("<sentinel>:x-oauth-basic")` is substituted the same way
   (covers both git credential conventions).
4. **Runtime secret via overrides** — a `GH_TOKEN` override (not an env
   secret) is substituted inside a Basic header (the real GitHub path).
5. **Pass-through** — a Basic header whose decoded value contains no
   sentinel is forwarded byte-for-byte unchanged.
6. **Malformed/non-base64 Basic value** — left untouched, never throws.

**End-to-end validation (the point of doing this now):** once landed,
deploy and confirm from a real container that, with only a sentinel in
env, `gh api user` and a real `git push` to a test repo both succeed.

## Phase 1 — GitHub OAuth login via Clerk

- Register a GitHub OAuth App; configure GitHub as a Clerk social
  connection with **custom credentials** and token vending enabled
  (so `clerk.users.getUserOauthAccessToken(userId, "github")` returns a
  usable token, exactly like Google).
- Decide scope set. Start with OAuth `repo` (full control of private
  repos) + `read:org` + `workflow`. Note the tradeoff in Phase 5.
- Web: add `github-scopes.ts` and a `GitHubConnect` card in
  `SettingsPage.tsx`, copied from `GoogleConnect` (connect / reauthorize
  for missing scopes / disconnect). Uses
  `user.createExternalAccount({ strategy: "oauth_github", additionalScopes })`.

**Verify:** a user can connect GitHub on the settings page and the
external account shows the approved scopes.

## Phase 2 — Token plumbing into the container

- `apps/api/src/github-token.ts`: `getGithubAccessToken(env, clerkUserId)`
  via Clerk Backend API; returns `null` on absence/error (never throws),
  mirroring `google-token.ts`.
- `AgentContainer.ts`: add `GH_TOKEN` (and alias `GITHUB_TOKEN`) to the
  `createSecretProxy(..., ["GOOGLE_WORKSPACE_CLI_TOKEN", "GH_TOKEN"])`
  runtime-secret list. In `refreshEnvVars`, fetch the GitHub token, push
  it as an override, inject the sentinel into `envVars`, and omit the
  sentinel when the token is absent (clean auth failure, like Google).
- Apply whatever egress mechanism Phase 0 settled on (likely a git
  `http.extraHeader` baked into container config).

**Verify:** container env contains `GH_TOKEN=Z3R0-FAKE-GH_TOKEN`; egress
to api.github.com is authenticated; the real token never appears in
container memory/logs.

## Phase 3 — git + gh in the container image

- Install `git` and the GitHub CLI (`gh`) in
  `packages/agent-server/Dockerfile`.
- Configure non-interactive git:
  - identity (`user.name` / `user.email`) — derive from the GitHub
    profile or `User.md`; set per-clone or globally at entrypoint.
  - auth: `gh` reads `GH_TOKEN` from env automatically; configure git
    push auth via the Phase 0 mechanism (`gh auth setup-git` or
    `http.extraHeader`).
- Confirm egress for github.com (and codeload.github.com for clones,
  and ghcr if needed) routes through the substitution handler with
  `interceptHttps = true`.

**Verify:** inside the container `gh auth status`, `git clone`, `git
push` all work end-to-end against a real test repo.

## Phase 4 — Repo workspace conventions skill

- Add `packages/agent-server/skills/github/SKILL.md`, analogous to the
  local `workspace` skill: clone to a stable, persisted location like
  `/workspace/repos/<owner>/<repo>`, one dir per repo, how to branch,
  commit with a meaningful message, push, and open a PR with `gh pr
  create`.
- Encode the safe-by-default workflow: work on a branch, never force-push
  shared branches, open a PR rather than pushing to `main` unless the
  user owns the repo and asked.
- Because `/workspace` persists, clones and worktrees survive across
  conversations; the skill should tell Zero to reuse an existing clone.

**Verify:** ask Zero to "clone X, make a small change, open a PR" and it
follows the conventions.

## Phase 5 — Repo access scoping & "ask permission" UX

The user's question — "how do we ask the user to allow us to look at
their repositories" — is answered at two levels:

- **OAuth scope consent (Phase 1):** the Clerk OAuth flow is itself the
  permission grant. `repo` scope is coarse (all repos). Simple, ships
  first.
- **Least-privilege (future):** a **GitHub App** with per-repository
  installation lets the user pick exactly which repos Zero can touch, and
  issues short-lived (8h) user-to-server tokens. This is the "new system"
  the user wondered about. It's more robust but heavier: Clerk must
  support refresh, or we manage installation tokens ourselves. Recommend
  shipping OAuth first, then migrating to a GitHub App for granular repo
  selection.
- **Onboarding:** when GitHub connects, a `github-onboarding` step can
  list the user's repos (`gh repo list`), ask which they want Zero to
  work on, and record the answer in a `GitHub.md` note.

## Phase 6 — Guardrails & memory

- Reinforce Prime Directives for code actions: confirm before pushing to
  repos the user doesn't own, before deleting branches, before force
  pushing; never commit secrets found in a repo.
- Note-taking: record per-repo context (default branch, conventions, CI
  command) in notes so Zero gets better over time.

## Suggested order

0. Phase 0 spike (unblocks everything; decides if `secret-proxy.ts`
   changes are needed).
1. Phase 1 (login) — independently demoable.
2. Phase 2 + 3 (token plumbing + tooling) — usually land together.
3. Phase 4 (skill) — makes the capability usable.
4. Phase 5 / 6 (scoping, onboarding, guardrails) — hardening.

## Open questions

- ~~Does GitHub accept `Authorization: Bearer` on git smart-HTTP?~~
  Resolved: no — git uses Basic only; proxy becomes Basic-aware.
- OAuth App vs GitHub App for v1 — coarse `repo` scope now, App later?
- Where exactly to clone and how to name worktrees under `/workspace`.
- Git identity: a per-user bot identity vs the user's own name/email.
- Always force HTTPS remotes in the container (SSH ruled out).
