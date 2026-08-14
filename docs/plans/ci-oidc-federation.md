# Plan: no API key in GitHub Actions — trust the workflow, not a secret

## Goal

A repository's workflow reads and writes ZeroVault secrets with **no
`ZERO_API_KEY` secret configured**. The workflow proves who it is with the OIDC
token GitHub already mints for it, and Zero exchanges that for a credential that
lives for minutes and cannot leave the job.

This finishes the half that `docs/plans/cli-oidc-login.md` deliberately skipped:
that plan gave humans a browser sign-in and left CI on keys, because workload
identity needs an issuer that vouches for the machine. GitHub Actions is exactly
such an issuer.

Non-goal: killing API keys. A bare VPS, a container on someone's server, and
Cloudflare Workers itself issue no workload token, so `zv_…` stays. Non-goal
for this plan: GitLab, Buildkite, CircleCI. The design should not make them
harder, but only GitHub ships here.

## Why this is worth doing

A CI key is the worst credential Zero hands out: it is long-lived, it is
org-wide, it sits in a provider's secret store where any workflow in the repo
can read it, and rotating it is a manual dance across repos. `zero login`
removed that credential from laptops; CI is where most of them actually live.
Cragstronauts is the live example — a single `ZERO_API_KEY` repository secret
feeding `bin/fetch-secrets`.

## What GitHub actually gives us (measured, not assumed)

Phase 1 ran a scratch repo (`juanibiapina/oidc-claims-spike`, created and
deleted 2026-08-14) whose workflow printed its own token claims for
`audience=https://api.zeroapps.dev`, across push, same-repo PR, **fork** PR,
`pull_request_target`, and jobs with an `environment`. Everything below is from
those runs or from the live discovery document, not from documentation prose.

Measured token, push to `main` of a repo created today:

```json
{"aud":"https://api.zeroapps.dev","iss":"https://token.actions.githubusercontent.com",
 "sub":"repo:juanibiapina@568764/oidc-claims-spike@1334281677:ref:refs/heads/main",
 "repository":"juanibiapina/oidc-claims-spike","repository_id":"1334281677",
 "repository_owner":"juanibiapina","repository_owner_id":"568764",
 "event_name":"push","ref":"refs/heads/main","repository_visibility":"public",
 "runner_environment":"github-hosted","iat":1786718719,"nbf":1786718419,"exp":1786719019}
```

- **Custom audience works**: the requested `https://api.zeroapps.dev` came back
  verbatim, so requiring it is enforceable.
- **Lifetime is 5 minutes** (`exp - iat = 300`), and `nbf = iat - 300`: GitHub
  already backdates by five minutes, so a Zero-side skew allowance is only needed
  on `exp`.
- **A repo created today emits the immutable `sub`**
  (`repo:OWNER@OWNER-ID/REPO@REPO-ID:…`), confirming that matching on `sub`
  strings would have been a trap and that `repository_id` /
  `repository_owner_id` are the right anchors.

All checked against the live provider on 2026-08-14:

```bash
curl -s https://token.actions.githubusercontent.com/.well-known/openid-configuration
```

- `issuer: https://token.actions.githubusercontent.com`,
  `jwks_uri: …/.well-known/jwks` (4 RS256 keys today), `response_types: [id_token]`.
- `claims_supported` includes `repository`, `repository_id`, `repository_owner`,
  `repository_owner_id`, `ref`, `environment`, `event_name`, `workflow_ref`,
  `job_workflow_ref`, `runner_environment`, `repository_visibility`, `actor`,
  `run_id`.
- A job requests a token only with `permissions: id-token: write`, then reads
  `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN` from the
  environment (`curl -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN"
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=…"`).
- `aud` **defaults to the repository owner's URL** and is caller-chosen per
  request.

Two facts that shape the design more than anything else:

1. **`sub` is not a stable identifier.** Repositories created after 2026-07-15
   use an immutable format
   (`repo:OWNER@OWNER-ID/REPO@REPO-ID:ref:refs/heads/BRANCH`) while older ones
   keep `repo:OWNER/REPO:ref:refs/heads/BRANCH` until they opt in — and a rename
   or transfer after that date silently moves a repo to the new format. Every
   other cloud provider binds trust to the `sub` string, and this is precisely
   the breakage that causes. **Zero binds to `repository_id` +
   `repository_owner_id`**, which are immutable integers, and treats
   `repository` (the name) as display only.
2. **`aud` is attacker-influenced.** Any workflow with `id-token: write` can mint
   a token for any audience, including ours. The audience is therefore not a
   security boundary by itself — the trust record is — but Zero must still
   **require** `aud: https://api.zeroapps.dev` so that a token a workflow minted
   for AWS cannot be replayed at Zero by whoever handles it in between.

## Design

### The exchange, not the token, is the credential

Two options were considered.

**A. Accept the GitHub JWT as the bearer on every `/vault/v1` request.** No new
endpoint, no new token type. But every request then costs a JWKS-cached
signature check *plus* a Durable Object read to find the trust record, on a path
that today is one KV read; and Zero would have no way to end a compromised job's
access short of deleting the trust.

**B. Exchange it once for a short-lived Zero token.** One new endpoint. The hot
path stays a single KV read, the token can carry a Zero-side expiry, and the
exchange is the natural place to log "job X of repo Y got access at time T".

Take **B**.

**The route cannot live under the existing middleware.** `dashboard-app.ts`
applies the auth middleware to `/vault/v1/*` (line ~70) *before* mounting any
router (line ~128), so a route added under that prefix would demand the very
credential it is supposed to issue. Register the exchange **before** the
middleware loop, or make the middleware skip that one exact path. Whichever is
chosen, add a test that an unauthenticated request reaches the handler — this
is the kind of thing that silently regresses when routes are reordered.

```
POST /vault/v1/ci/token
  { "token": "<github oidc jwt>", "orgId": "org_…" }   # orgId optional, see below
  -> 200 { "accessToken": "zci_…", "expiresIn": 900, "orgId": "org_…" }
  -> 401 { "error": "…" }  untrusted repo, bad signature, wrong audience
```

The minted token is `zci_<random>`, stored in KV under its SHA-256 exactly like
a `zv_` key but with `expirationTtl` (15 minutes, the shortest KV allows is 60s
so this is free) and a value of `{ v: 2, orgId, userId: "ci:github:<repo_id>" }`.
Nothing downstream changes: `orgId` routes the DOs, and the synthetic `userId`
is what shows up in attribution.

`packages/auth`'s `authenticate()` gains a third prefix branch: `zci_` reads the
same KV store as `zv_`. That keeps the request path identical to today's and
needs no new verification code on the hot path.

### Trust records

Per org, in `OrgDO` (new table `ci_trusts`, new migration):

| column | meaning |
|---|---|
| `id` | surrogate |
| `provider` | `github` today, so a second provider does not need a migration |
| `owner_id`, `repo_id` | the immutable integers the token is matched on |
| `repository` | `owner/repo` at creation time, display only |
| `ref` | optional exact match, e.g. `refs/heads/main` |
| `environment` | optional exact match |
| `allow_pull_request` | default false, see below |
| `label`, `created_at` | as for API keys |

Lookup must not scan every org, so creation also writes a KV index:
`ci:github:<owner_id>/<repo_id>` → JSON list of org ids. If that list has more
than one entry, the exchange **requires** the caller to pass `orgId` and returns
a 400 naming the ambiguity otherwise. This mirrors how `zv_` keys resolve
(hash → KV → org) and keeps the exchange to one KV read plus one DO read.

### What is checked at exchange time

In order, each a separate 401 message (they are different mistakes):

1. Signature against `token.actions.githubusercontent.com` JWKS, cached in KV
   with a TTL and re-fetched on unknown `kid` (GitHub rotates; there are 4 keys
   today).
2. `iss` exactly `https://token.actions.githubusercontent.com`.
3. `aud` exactly `https://api.zeroapps.dev` — the message must say to set
   `audience:` on the token request, because the default (owner URL) is what
   people hit first.
4. `exp` with ≤60s skew, and `nbf` as-is: GitHub already sets `nbf` five
   minutes before `iat`, so no extra allowance is needed there. The whole token
   is valid for 5 minutes from issue, which is the real bound on a replay.
5. A trust record for `repository_owner_id`/`repository_id`.
6. Any `ref` / `environment` constraint on that record.
7. `event_name`: **default-deny a list, not a single value.** Refuse
   `pull_request`, `pull_request_target` and `workflow_run` unless the trust
   record opts in per event, stored as a set (`allowed_events`) so opting into
   one does not open the others.

   Measured, on a PR opened from a fork in a different organization:

   | trigger | token issued? | claims |
   |---|---|---|
   | fork PR, `pull_request` | **no** — `ACTIONS_ID_TOKEN_REQUEST_URL` is unset | — |
   | fork PR, `pull_request_target` | **yes** | `repository_id` of the **base** repo, `ref: refs/heads/main`, `base_ref: main`, `head_ref: fork-change`, `sub: …:pull_request` |

   So the fork downgrade protects `pull_request` exactly as documented, and
   `pull_request_target` sails straight through with full base-repo identity.
   That run is triggered by a stranger's branch, and if the workflow checks that
   branch out, the stranger runs code in a job that can mint a Zero credential.

   **A `ref` constraint does not save you here.** On a `pull_request` run the
   `ref` is `refs/pull/1/merge`, so `--ref refs/heads/main` excludes it — but on
   `pull_request_target` the `ref` is `refs/heads/main`, which matches. The event
   allowlist is the only control that works.

`jti` is not replayed-checked in this slice: the token is single-use in practice
and the minted credential is 15 minutes. Note it as a possible hardening.

### CLI

- `zero ci trust add --repo owner/repo [--ref refs/heads/main] [--environment production] [--label ci]`,
  `zero ci trust list`, `zero ci trust rm <id>`. The CLI resolves `owner/repo` to
  the two ids at creation time and stores both, so a later rename does not break
  trust and a re-created repo with the same name does not inherit it.

  **Resolution does not work unauthenticated for private repositories**:
  `GET https://api.github.com/repos/<owner>/<repo>` returns 404 without a token
  (verified: `juanibiapina/zero` → 404, `cgcess/cragstronauts` → 200 with
  `id: 1233340365`, `owner.id: 190107074`). Unauthenticated calls are also capped
  at 60/hour. So: use `GITHUB_TOKEN`/`GH_TOKEN` when present, accept
  `--repo-id`/`--owner-id` explicitly as the escape hatch, and make the failed
  exchange's 401 body include the ids the token carried, so a user can copy them
  from a failing run instead of hunting through the API.
- Automatic use in a workflow: when no more explicit credential is present and
  `ACTIONS_ID_TOKEN_REQUEST_URL` is set, the CLI fetches an OIDC token with
  `audience=https://api.zeroapps.dev`, exchanges it, and keeps the result in
  memory for the process. Nothing is written to disk.
- Precedence becomes: `--api-key` > directory context > `ZERO_API_KEY` > **CI
  OIDC** > `zero login`. OIDC sits above the browser sign-in because a CI runner
  never has one, and below the env var so a repo can pin a key during migration.

A workflow then needs only:

```yaml
permissions:
  id-token: write
steps:
  - run: bin/fetch-secrets      # no ZERO_API_KEY anywhere
```

## System-wide impact

- `/vault/v1/ci/token` is a **public, unauthenticated** endpoint (its input is
  the credential). It must not leak whether a repo is trusted before the
  signature check.
- **Rate limiting it is harder than it looks.** Keying on
  `repository_id`/`repository_owner_id` read from the *unverified* token, as the
  first draft said, lets an attacker mint fresh keys at will and rate-limit
  nothing. Key on `CF-Connecting-IP` plus a global limiter on the endpoint, and
  treat the per-repo counter as observability rather than defence. A new
  `ratelimits` binding is needed in `wrangler.jsonc` either way (there are two
  today, both keyed by org).
- Zero gains a runtime dependency on GitHub's JWKS for the exchange only, not on
  the request path. Cache it; a GitHub outage then degrades to "no new CI
  sessions" instead of "CI down".
- KV writes: one per exchange (the `zci_` token) plus index writes on trust
  changes. Trivial next to the existing key path.
- Blast radius of a compromised trust record is the whole org, exactly like a
  key. That is a real limit worth writing down: per-project scoping is a
  separate, larger change.

## Implementation phases

1. ~~**Spike**~~ **Done** (2026-08-14). Findings are folded into the sections
   above: custom audience honoured, 5-minute lifetime with `nbf` backdated 5
   minutes, immutable `sub` on a new repo, fork `pull_request` gets no token,
   fork `pull_request_target` gets a full base-repo token, and `ref` is
   `refs/pull/N/merge` on PR runs but `refs/heads/main` on
   `pull_request_target`. An `environment:` job carries an `environment` claim
   and its `sub` switches to the `:environment:NAME` form, dropping the ref
   entirely — so a trust record must match on the claims, never on `sub`.
2. ~~**Server**~~ **Done** (PR #47). Verified in production with a real
   workflow: exchange returned an org-scoped token, `whoami` reported
   `ci:github:<repo_id>`, and the job listed 13 projects with no secret set.
3. ~~**CLI**~~ **Done.** `zero ci trust add/list/rm`, Actions auto-detect,
   precedence (key still wins), and `whoami` reporting `github actions`. Found
   in production: the KV trust index is eventually consistent, so the command
   now warns that the first run may need a minute.
4. ~~**Docs + skills**~~ **Done.** New docs page "GitHub Actions without an API
   key", CLI page and API-keys page updated, `docs/console-auth.md` records the
   design and the measured facts, `zero-skills` teaches the workflow, root
   `CHANGELOG.md` entry, CLI 0.5.0.
5. **Dogfood:** migrate this repo's own workflows and Cragstronauts off their
   `ZERO_API_KEY` secrets, then delete the secrets and revoke the keys.
6. **Later, not now:** dashboard UI for trusts, GitLab/Buildkite issuers,
   per-project scoping, `jti` replay cache.

## Test strategy

- `packages/auth`: the `zci_` prefix branch, including that a `zci_` token never
  reaches the OAuth verifier and an expired one is a plain 401. The `via` union
  gains a third member (`"ci"`), which ripples into the CLI's `whoami` line and
  the `ResolvedAuth` type — small, but it is a shared type, so change it once.
  Runs locally.
- Claim verification as a pure function over a decoded token plus a trust
  record: issuer, audience, expiry/skew, ref, environment, `pull_request`
  default-deny, and id-vs-name matching (a token whose `repository` name matches
  but whose `repository_id` does not must fail — that is the rename attack).
  Sign test tokens with a locally generated RSA key and inject the JWKS, so no
  network and no real GitHub token in the suite.
- `apps/vault-api`: route tests for the exchange endpoint (happy path, unknown
  repo, wrong audience, ambiguous org, rate limit). CI-gated: workerd does not
  run on the NixOS dev box.
- `packages/zero-cli`: auto-detect fires only when the Actions env vars exist and
  nothing more explicit is set; the token request carries the right audience;
  the exchanged token is used as the bearer; nothing touches the config file.
- End to end, in this repo's own CI: a job with `id-token: write` and no
  `ZERO_API_KEY` reads a secret. That is the acceptance test, and it cannot be
  faked locally.

## Risks and open questions

- **Fork PRs — measured.** A `pull_request` from a fork gets no token; a
  `pull_request_target` from the same fork gets one with the base repo's
  identity. The remaining unmeasured case is the repository setting **"Send
  write tokens to workflows from pull requests"**, which restores write
  permissions for fork PRs and would therefore also restore the token. The event
  allowlist covers both, but the docs must say plainly: turning that setting on
  means any fork PR author can mint a Zero credential for the repo's org.
- **`actor` is not the attacker's name.** On the fork `pull_request_target` run
  the `actor` claim was the base repo owner, not obviously the PR author (the
  spike's PR was opened by the same account, so this is suggestive rather than
  settled). Do not build any trust rule on `actor` without measuring it with two
  distinct accounts.
- **`sub` drift.** Binding to ids avoids it for Zero, but the docs must tell
  users not to copy AWS-style `sub` matching. GitHub Enterprise Server has no
  immutable subject format; whether its tokens still carry `repository_id` and
  `repository_owner_id` is unconfirmed, so promise nothing for GHES until
  someone checks against a real instance.
- **Ambiguous orgs.** Two orgs trusting the same repo is legitimate (a fork, a
  monorepo). Requiring an explicit `orgId` is the safe answer but adds a flag to
  the workflow; check whether `ZERO_ORG` as an env var reads better.
- **Revocation lag.** Deleting a trust does not kill already-minted `zci_`
  tokens; they expire within 15 minutes. Acceptable, but say it in the docs
  rather than letting someone assume it is instant.
- **An unauthenticated public endpoint** is new surface for this Worker. Rate
  limit it, keep its error messages free of "this repo is/is not trusted" before
  the signature check, and report failures to ZeroErrors so a brute-force shows
  up.
- **Clock skew** on self-hosted runners: allow 60s, no more.

## Skills to use

- `tdd` — claim verification and the dispatcher branch are pure logic with sharp
  edges; drive them test-first.
- `api-design` — the exchange endpoint is a public contract: status codes, error
  bodies, and the `orgId` ambiguity rule.
- `cli-design` — `zero ci trust …` output and the auto-detect's silence.
- `codebase-design` — keep the GitHub-specific verification behind a port so a
  second issuer is additive.
- `technical-writing`, `changelog`, `git-commit`, `open-pr`.

## Acceptance criteria

- A workflow with `permissions: id-token: write` and **no** `ZERO_API_KEY` runs
  `zero vault secrets download` successfully; removing the trust record makes the
  same workflow fail with a message naming the repo and how to trust it.
- A token minted for a different audience is refused, and the error says to set
  `audience: https://api.zeroapps.dev`.
- A repo renamed after being trusted keeps working; a *new* repo created with
  the old name does not inherit the trust.
- A `pull_request`-triggered job is refused unless the trust opted in.
- `zero whoami` in Actions reports the GitHub repo as the credential.
- This repo's CI and Cragstronauts' CI both run with their `ZERO_API_KEY`
  secrets deleted.
