# Plan: Task 4 — Clerk repoint + frontend-domain rename

Repoint the shared SaaS Clerk instance so login stops always landing on vault,
and rename its **frontend API domain** from `clerk.zerovault.juanibiapina.dev`
to the generic `clerk.juanibiapina.dev`. Authoritative design:
`docs/plans/unified-console-design.md` ("Clerk frontend-domain rename runbook",
"Redirect fix", "Secrets" sections). Background:
`docs/plans/unified-console-research.md`.

## Goal

- One SaaS Clerk instance on a brand-neutral frontend-API domain
  (`clerk.juanibiapina.dev`), same user pool / Google connection / org model.
- Login initiated from a product returns the user to **that** product; no forced
  bounce to vault.
- **Minimize login downtime** during the rename: the publishable key embeds the
  frontend-API domain (confirmed: changing the frontend API domain re-issues
  `pk_live`), so old bundles break the instant the old Frontend API **host** stops
  being served. The no-downtime path depends on a prerequisite that is **not
  guaranteed** — that Clerk keeps serving the old Frontend API host in parallel
  after the domain change. See the prerequisite below; the sequence and rollback
  are conditional on it.

## Context already established (do not redo)

- **Task 3 shipped.** `vault.juanibiapina.dev` and `errors.juanibiapina.dev`
  serve 200; the old `zerovault.`/`zeroerrors.` hosts still serve in parallel.
  Worker names (`zerovault-api`, `zeroerrors-api`), KV ids, DO classes, and
  migration tags are all unchanged and stay unchanged (hard data-safety
  constraint per `docs/vault-errors-relocation.md`).
- **Task 2 shipped.** Both apps render brand "Zero" + product selector via
  `@zero/ui` `getProducts()` (`packages/ui/src/products.ts`).
- **Shared Clerk instance.** Both vault and errors prod publishable keys decode
  to `clerk.zerovault.juanibiapina.dev`; both dev keys decode to
  `good-wallaby-70.clerk.accounts.dev`. Agent is a **separate** instance
  (`clerk.zero.juanibiapina.dev`) and is out of scope — no change of any kind.
- **The forced-to-vault redirect is not in this repo.** It is Clerk Dashboard
  config on the shared instance (Account Portal home + allowed origins). Repo
  search for `forceRedirectUrl|fallbackRedirectUrl|afterSignInUrl|allowedRedirectOrigins`
  returns nothing.
- **Dev keys (`good-wallaby-70...`) are unchanged.** Only the **production**
  `pk_live_`/`sk_live_` values rotate. ZeroVault `development` environments stay
  as-is; only `production` values change.

## Step tags used in this runbook

- **[Clerk Dashboard]** — outside-repo, user-driven, 2FA. Agent cannot do it.
- **[Cloudflare DNS]** — outside-repo, user-driven Dashboard/DNS.
- **[In-repo]** — code/config edits in this repo (agent can do).
- **[Task 5]** — key propagation, executed in the separate Task 5 runbook. Task 4
  **produces** the keys and hands them off; it does not propagate them.
- **[User-present, irreversible]** — retiring the old Clerk domain. Only after
  Task 5 deploys + verifies.

---

## Part A — Clerk frontend-domain rename (outside-repo)

Goal: bring `clerk.juanibiapina.dev` live, re-issue the prod keys, deploy them to
both workers (Task 5), and retire the old domain last. Whether the old and new
domains can be live **in parallel** depends on the prerequisite below.

### PREREQUISITE — confirm the old Frontend API host keeps serving (blocking)

The whole no-downtime, no-maintenance-window rollout rests on Clerk continuing to
**serve** the old Frontend API host `clerk.zerovault.juanibiapina.dev` in parallel
after the domain change. This is **not** something DNS controls: DNS resolving the
old CNAME is necessary but **not sufficient**, because Clerk routes by SNI/Host,
and a production instance's Frontend API domain is normally **singular**. Whether
changing the domain leaves the old host live or cuts it immediately is
instance- and plan-specific.

**Before relying on the parallel window, confirm** in the Clerk Dashboard (or with
Clerk support) that the old Frontend API host keeps serving requests after the
domain change. Do not assume it.

**Contingency — if Clerk cuts the old host immediately on change** (no parallel
window), do **not** use the in-place parallel approach. Instead choose one of:

- **(a) Satellite/secondary domain:** verify Clerk supports satellite or secondary
  domains on this instance/plan so both `clerk.zerovault...` and
  `clerk.juanibiapina.dev` stay live simultaneously; if so, run the parallel
  sequence using that mechanism.
- **(b) Short user-present maintenance window:** schedule a brief window, pre-stage
  everything in Task 5 (ZeroVault values, scripts, Workers Build vars ready to
  apply), then switch the domain, immediately deploy the new keys to **both**
  workers, and accept a short auth interruption while bundles rebuild and secrets
  propagate.

### Key ordering principle (the rollout rule)

1. New frontend-API domain live (DNS + cert green in Clerk) **and**
2. New publishable/secret keys deployed to **both** workers' builds (Task 5)
   **before**
3. Retiring the old `clerk.zerovault...` domain.

Never cut the old host until every user-facing build carries the new publishable
key. **If** the prerequisite holds (or a satellite domain is used), then between
step A5 verify and step A6/A7 retire **both** Clerk hosts serve, so any bundle
(old key or new key) works — this is the parallel window. If the prerequisite does
not hold, follow contingency (b) and treat the domain switch as a maintenance
window instead.

### Steps

- **A1. [Clerk Dashboard]** On the SaaS instance (the "zero vault" instance, the
  one whose prod keys decode to `clerk.zerovault.juanibiapina.dev`; confirm by
  decoding the current `VITE_CLERK_PUBLISHABLE_KEY` before touching anything),
  open **Domains** and add/change the production frontend-API domain to
  `clerk.juanibiapina.dev` ("Add domain" / "Change domain" depending on plan).
  Clerk displays the required CNAME targets. Do **not** remove the old domain in
  this step. (Residual: the Dashboard may require re-add rather than in-place
  change; verify live. Either way, keep the old domain until A6.)

- **A2. [Cloudflare DNS]** In the `juanibiapina.dev` zone, create the CNAME
  record(s) Clerk specifies for the new frontend API. Clerk typically requires
  several CNAMEs, all shown in the Dashboard:
  - `clerk` (frontend API) → Clerk's `frontend-api.clerk.services` target (exact
    target is shown per-instance in the Dashboard; use what Clerk shows).
  - `accounts` (Account Portal), `clkmail` / `clk._domainkey` / `clk2._domainkey`
    (email + DKIM) as listed.

  These are **DNS-only** (grey cloud, not proxied) unless Clerk states otherwise.
  Leave the existing `clerk.zerovault...` CNAME(s) in place.

- **A3. [Clerk Dashboard]** Wait for Clerk to verify DNS and issue the SSL cert;
  status must go **green** for `clerk.juanibiapina.dev`. Cert provisioning can lag
  minutes to tens of minutes. Do not proceed to key handoff until green.

- **A4. [Clerk Dashboard]** Copy the **re-issued** production keys: publishable
  key (`pk_live_...`, now decoding to `clerk.juanibiapina.dev`) and secret key
  (`sk_live_...`). Sanity-check the publishable key: base64-decode the segment
  after `pk_live_` and confirm it reads `clerk.juanibiapina.dev`. These are the
  keys Task 5 propagates. **Dev keys are untouched.**

- **A5. [Task 5]** Propagate the new keys everywhere and redeploy both workers
  (see Part C for the full location list, executed in the Task 5 runbook). Verify
  both dashboards load and login works against `clerk.juanibiapina.dev`. **Pause
  Task 4 here until Task 5 reports both products verified on the new keys.**

- **A6. [Clerk Dashboard] [User-present, irreversible]** Only after Task 5
  confirms both products live on the new domain, retire
  `clerk.zerovault.juanibiapina.dev` (remove the old domain from the instance).
  This is the single irreversible cut; any still-deployed bundle carrying the old
  key breaks the instant this domain stops resolving.

- **A7. [Cloudflare DNS] [User-present]** Remove the stale
  `clerk.zerovault...` CNAME record(s) from the `juanibiapina.dev` zone.

### Part A rollback

- Before A6, **and only if the prerequisite holds** (old host still served, or a
  satellite domain keeps both live): fully reversible. If a new-key deploy
  misbehaves while the old Clerk host still serves, redeploy the previous bundle
  (old key) — it still works because both hosts serve in parallel. Removing the
  new domain / new CNAMEs is harmless.
- If the prerequisite does **not** hold (Clerk cuts the old host on change): there
  is no old-key fallback once the domain switches. Rollback then means switching
  the Frontend API domain **back** to `clerk.zerovault...` in Clerk and waiting
  for its cert — a second maintenance window. This is why contingency (b) pre-
  stages Task 5 so the new-key deploy lands immediately after the switch.
- After A6/A7: rollback means **re-adding** `clerk.zerovault...` in Clerk +
  recreating its CNAME and waiting for the cert. This is why A6/A7 run last,
  user-present, and only after verification.

---

## Part B — Redirect fix

Two layers: the necessary **[Clerk Dashboard]** change, plus an optional but
recommended **[In-repo]** reinforcement.

### B1. Clerk Dashboard settings (necessary)

On the SaaS instance:

- **B1a. [Clerk Dashboard]** Account Portal → **Home URL / after-sign-in /
  after-sign-up**: repoint away from the hardcoded vault host. Set the Account
  Portal home to the default product for a bare login (no `redirect_url`) — lean
  **Vault** (`https://vault.juanibiapina.dev`) — but rely on allowed redirect
  origins + `redirect_url` so product-initiated logins return to their origin.

- **B1b. [Clerk Dashboard]** **Allowed redirect origins / allowed origins**: add
  **both** new product subdomains plus the old hosts (kept during cutover) plus
  localhost dev origins:
  - `https://vault.juanibiapina.dev`
  - `https://errors.juanibiapina.dev`
  - `https://zerovault.juanibiapina.dev` (old, keep during cutover)
  - `https://zeroerrors.juanibiapina.dev` (old, keep during cutover)
  - `http://localhost:5178` (vault-web dev), `http://localhost:5177`
    (errors-web dev)

  (Do **not** add `http://localhost:5176` — that is the **agent** web app, out
  of scope for this task.)

  This is what lets errors' sign-in return to errors instead of bouncing to
  vault.

- **B1c. [Clerk Dashboard]** **Sign-in / Sign-up URLs**: point at each app's
  path-routed pages (`/sign-in`, `/sign-up`) served by
  `SignInPage`/`SignUpPage`.

### B2. In-repo reinforcement (recommended — ship in Task 4)

**Decision: yes, ship the in-repo redirect props in Task 4.** They make each
product deterministically return to itself regardless of Account Portal
defaults, and they are safe, reversible code (a bare default on each web app).
This is belt-and-suspenders on top of B1b (the Dashboard allowed-origins fix is
the necessary one).

Current shape (confirmed by reading the files):

- `packages/ui/src/pages/SignInPage.tsx` is
  `<SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />` — no redirect
  props. Same for `SignUpPage.tsx` (`<SignUp ... signInUrl="/sign-in" />`).
- Each app's `main.tsx` renders these bare, as sibling routes to the `AppLayout`
  route:
  ```tsx
  { path: "sign-in/*", element: <SignInPage /> },
  { path: "sign-up/*", element: <SignUpPage /> },
  ```
  There is no prop threading today; brand/nav/products are passed to `AppLayout`,
  not to the sign-in pages.

Change: add an optional `fallbackRedirectUrl` prop to both pages and thread it
from each `main.tsx`. Use `fallbackRedirectUrl` (not `forceRedirectUrl`) so a
`redirect_url` on the URL — set by Clerk when a signed-out user is bounced from a
deep link — still wins; the fallback only applies when there is no explicit
redirect. Vault falls back to `/projects`, errors to `/issues` (matching each
app's `brand.to` / `afterOrgUrl`).

#### Exact in-repo diff

**File: `packages/ui/src/pages/SignInPage.tsx`**

```tsx
import { SignIn } from "@clerk/clerk-react";

export interface SignInPageProps {
  /** Where to land after sign-in when the URL carries no explicit redirect_url. */
  fallbackRedirectUrl?: string;
}

export function SignInPage({ fallbackRedirectUrl }: SignInPageProps = {}) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        fallbackRedirectUrl={fallbackRedirectUrl}
      />
    </div>
  );
}
```

**File: `packages/ui/src/pages/SignUpPage.tsx`**

```tsx
import { SignUp } from "@clerk/clerk-react";

export interface SignUpPageProps {
  /** Where to land after sign-up when the URL carries no explicit redirect_url. */
  fallbackRedirectUrl?: string;
}

export function SignUpPage({ fallbackRedirectUrl }: SignUpPageProps = {}) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        fallbackRedirectUrl={fallbackRedirectUrl}
      />
    </div>
  );
}
```

**File: `packages/ui/src/index.ts`** — export the new prop types alongside the
existing page exports:

```ts
export { SignInPage, type SignInPageProps } from "./pages/SignInPage";
export { SignUpPage, type SignUpPageProps } from "./pages/SignUpPage";
```

**File: `apps/vault-web/src/main.tsx`** — pass the vault fallback:

```tsx
{ path: "sign-in/*", element: <SignInPage fallbackRedirectUrl="/projects" /> },
{ path: "sign-up/*", element: <SignUpPage fallbackRedirectUrl="/projects" /> },
```

**File: `apps/errors-web/src/main.tsx`** — pass the errors fallback:

```tsx
{ path: "sign-in/*", element: <SignInPage fallbackRedirectUrl="/issues" /> },
{ path: "sign-up/*", element: <SignUpPage fallbackRedirectUrl="/issues" /> },
```

Notes:
- `fallbackRedirectUrl` is relative (`/projects`, `/issues`), so it resolves
  within whichever origin served the page — vault returns to vault, errors to
  errors — without hardcoding hosts.
- Passing `undefined` to Clerk's `fallbackRedirectUrl` is a no-op, so the shared
  pages stay usable without the prop (safe default).

### Part B rollback

- B1 (Dashboard): revert the Account Portal home / allowed-origins to prior
  values in the Dashboard. Non-destructive; take a screenshot of current settings
  before editing so the prior state is recoverable.
- B2 (in-repo): one-line revert of the props + redeploy. The old bare
  `<SignIn .../>` behavior returns immediately.

---

## Part C — Key propagation interlock (executed in Task 5)

The Part A rename re-issues `pk_live` (public, baked into the web bundle at build)
and `sk_live` (worker runtime secret). **Task 4's job is to produce these keys
(A4) and hand them off. The actual propagation and worker redeploy happen in
Task 5.** The old Clerk domain is retired (A6/A7) only after Task 5 deploys +
verifies. Dev keys (`good-wallaby-70`) are unchanged, so only ZeroVault
`production` values and the two Workers Build vars rotate.

Every location that must update (from the design's Secrets table; confirmed
against `bin/fetch-secrets` and `bin/sync-secrets-to-cloudflare`):

| # | Location | Key(s) | File / system | How |
|---|---|---|---|---|
| 1 | Local worker env (vault) | `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `apps/vault-api/.dev.vars` | `bin/fetch-secrets` after ZeroVault update |
| 2 | Local worker env (errors) | `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `apps/errors-api/.dev.vars` | `bin/fetch-secrets` |
| 3 | Local web env (vault) | `VITE_CLERK_PUBLISHABLE_KEY` | `apps/vault-web/.env`, `apps/vault-web/.env.production` | `bin/fetch-secrets` |
| 4 | Local web env (errors) | `VITE_CLERK_PUBLISHABLE_KEY` | `apps/errors-web/.env`, `apps/errors-web/.env.production` | `bin/fetch-secrets` |
| 5 | Workers Build var (vault) | `VITE_CLERK_PUBLISHABLE_KEY` | `zerovault-api` build config (Cloudflare Dashboard) | **manual** — not scripted |
| 6 | Workers Build var (errors) | `VITE_CLERK_PUBLISHABLE_KEY` | `zeroerrors-api` build config (Cloudflare Dashboard) | **manual** — not scripted |
| 7 | Worker prod secret (vault) | `CLERK_SECRET_KEY` (+ `CLERK_PUBLISHABLE_KEY`) | `zerovault-api` via `wrangler secret bulk` | `bin/sync-secrets-to-cloudflare` |
| 8 | Worker prod secret (errors) | same | `zeroerrors-api` via `wrangler secret bulk` | `bin/sync-secrets-to-cloudflare` |
| 9 | ZeroVault project `zerovault` (production) | `CLERK_*` | ZeroVault | edit stored value |
| 10 | ZeroVault project `zerovault-web` (production) | `VITE_CLERK_PUBLISHABLE_KEY` | ZeroVault | edit stored value |
| 11 | ZeroVault project `zeroerrors` (production) | `CLERK_*` | ZeroVault | edit stored value |
| 12 | ZeroVault project `zeroerrors-web` (production) | `VITE_CLERK_PUBLISHABLE_KEY` | ZeroVault | edit stored value |

Task 5 order (summary; full detail in the Task 5 runbook):
1. Update ZeroVault production values (#9–#12) with the A4 keys.
2. `bin/fetch-secrets` refreshes local env files (#1–#4).
3. `bin/sync-secrets-to-cloudflare` pushes worker secrets (#7, #8). Note: this
   script also re-pushes the **agent** worker (`zero-api`) secrets. Since the
   agent Clerk instance is untouched, that is a harmless no-op — expected, not a
   sign anything went wrong.
4. Manually set the two Workers Build `VITE_CLERK_PUBLISHABLE_KEY` vars (#5, #6)
   — **not** covered by any script; both must be updated in the same session to
   avoid drift.
5. Redeploy both workers so bundles rebuild with the new publishable key and
   workers pick up the new secret. Verify login on both, then unblock A6/A7.

No structural change to `bin/fetch-secrets` or `bin/sync-secrets-to-cloudflare`
is needed — the four ZeroVault projects stay as-is, only their stored production
values change. (Collapsing the web projects is explicitly deferred per the
design.)

---

## Consolidated runbook (ordered, tagged)

0. **[Clerk Dashboard]** PREREQUISITE — confirm the old Frontend API host
   `clerk.zerovault.juanibiapina.dev` keeps serving after the domain change
   (Dashboard or Clerk support). If it does **not**, pick contingency (a)
   satellite/secondary domain or (b) short user-present maintenance window with
   Task 5 pre-staged, before proceeding.
1. **[Clerk Dashboard]** A1 — add frontend-API domain `clerk.juanibiapina.dev`,
   keep old domain.
2. **[Cloudflare DNS]** A2 — create the CNAME(s) Clerk specifies; leave old
   `clerk.zerovault...` CNAME.
3. **[Clerk Dashboard]** A3 — wait for cert green on the new domain.
4. **[Clerk Dashboard]** A4 — copy re-issued `pk_live`/`sk_live`; verify the
   publishable key decodes to `clerk.juanibiapina.dev`. Hand off to Task 5.
5. **[Clerk Dashboard]** B1a/B1b/B1c — Account Portal home, allowed origins (both
   new + both old + localhost), sign-in/up URLs. (Can run any time after A1; do
   before verifying redirects.)
6. **[In-repo]** B2 — add `fallbackRedirectUrl` props to `SignInPage`/`SignUpPage`
   + thread from both `main.tsx`; export new prop types; add CHANGELOG entry.
   Commit and push (auto-deploys via Workers Builds — but note the bundle still
   carries the **old** publishable key until Task 5 updates the Build var. This
   is fine **as long as the prerequisite holds** and the old Frontend API host
   keeps serving; under contingency (b) the old-key bundle stops working the
   moment the domain switches, which is why (b) deploys the new keys immediately).
7. **[Task 5]** A5/Part C — propagate the new keys to all 12 locations; redeploy
   both workers; verify login on vault and errors against
   `clerk.juanibiapina.dev`. **Task 4 pauses here until Task 5 reports verified.**
8. **[Clerk Dashboard] [User-present, irreversible]** A6 — retire
   `clerk.zerovault.juanibiapina.dev`.
9. **[Cloudflare DNS] [User-present]** A7 — remove old `clerk.zerovault...`
   CNAME(s).
10. **[Clerk Dashboard]** post-cutover cleanup — remove the old
    `zerovault.`/`zeroerrors.` origins from allowed origins once the old web hosts
    are also retired (separate from this task; keep them while old web hosts
    serve).

**Must be done with the user present:** every **[Clerk Dashboard]** and
**[Cloudflare DNS]** step (2FA, no agent access), and specifically steps 8–9
(irreversible). The process **pauses at step 7 for Task 5** and does not proceed
to the irreversible retire until Task 5 verifies.

---

## Verification

### In-repo (before/independent of cutover)

Per-package, since the dev box can't boot whole-repo `workerd` (per AGENTS.md):

```bash
pnpm --filter @zero/ui run typecheck && pnpm --filter @zero/ui run lint
pnpm --filter @zero/vault-web run typecheck && pnpm --filter @zero/vault-web run lint && pnpm --filter @zero/vault-web run build
pnpm --filter @zero/errors-web run typecheck && pnpm --filter @zero/errors-web run lint && pnpm --filter @zero/errors-web run build
```

Both web builds must succeed (the `fallbackRedirectUrl` prop is a valid Clerk
`SignIn`/`SignUp` prop; a build/type error would flag a typo).

### Post-cutover (after Task 5 deploy, before A6)

- Load `https://vault.juanibiapina.dev`, sign out, sign in → lands on
  `/projects` (vault), **not** bounced to a foreign host.
- Load `https://errors.juanibiapina.dev`, sign out, sign in → lands on `/issues`
  (errors), **not** bounced to vault.
- Cross-product hop: signed in on vault, click "Errors" in the selector → lands
  on errors **without** re-login (shared session cookie scoped to
  `juanibiapina.dev`; confirm the instance cookie domain after the rename).
- Both hosts' Clerk frontend resolves to `clerk.juanibiapina.dev`:
  ```bash
  # publishable key baked into each deployed bundle now decodes to the new domain
  curl -s https://vault.juanibiapina.dev/  | grep -oE 'pk_live_[A-Za-z0-9_-]+' | head -1
  curl -s https://errors.juanibiapina.dev/ | grep -oE 'pk_live_[A-Za-z0-9_-]+' | head -1
  # decode each: base64 -d of the part after pk_live_ should read clerk.juanibiapina.dev
  ```
  Both should decode to `clerk.juanibiapina.dev`. If either still decodes to
  `clerk.zerovault...`, that worker's Build var (#5/#6) was missed — fix before
  A6.
- While both Clerk hosts serve (before A6, and only if the prerequisite holds or
  a satellite domain keeps both live), an old-key bundle still works; this is the
  safety window. Under contingency (b) there is no such window.

---

## Rollback summary (per step)

| Step | Rollback |
|---|---|
| A1/A2 add new domain + CNAMEs | Remove the new domain in Clerk + delete CNAMEs. Harmless; old domain still serves. |
| B1 Dashboard redirect config | Revert to pre-edit values (screenshot before editing). Non-destructive. |
| B2 in-repo props | One-line revert + redeploy; bare `<SignIn>` behavior returns. |
| Task 5 key deploy | **If prerequisite holds:** redeploy the previous bundle (old key still works while old Clerk host serves); the parallel window is the safety net. **If it does not hold:** no old-key fallback — roll back by switching the Frontend API domain back to `clerk.zerovault...` (second maintenance window). |
| A6/A7 retire old domain | **Irreversible-ish**: re-add `clerk.zerovault...` in Clerk + recreate CNAME + wait for cert. This is why it runs last, user-present, post-verify. |

**Parallel-domains window (the safety net — conditional on the prerequisite):**
this window exists **only if** the PREREQUISITE holds (Clerk keeps serving the old
Frontend API host after the domain change) or a satellite/secondary domain keeps
both live. When it holds, between Task 5's deploy and A6 both
`clerk.zerovault...` and `clerk.juanibiapina.dev` serve, so any bundle (old or new
key) authenticates, and this window is the rollback path for the whole rotation.
Do not retire the old domain until every user-facing bundle carries the new key
(verified above). **If the prerequisite does not hold**, there is no parallel
window: follow contingency (b) and treat the domain switch as a short user-present
maintenance window with Task 5 pre-staged to deploy the new keys immediately.

---

## CHANGELOG entry

Add to the top of `CHANGELOG.md` (repo flat-dated format, most recent first).
Ships with the Part B in-repo change (step 6), since that is when the behavior
becomes observable in-repo; the full effect lands once Task 5 deploys the new
keys.

```
- 2026-07-22: Signing in from Vault or Errors now returns you to the product you came from, instead of always landing on Vault.
```

---

## Skills to use

- `code` — for the Part B in-repo edits (props + threading + exports).
- `changelog` — the flat-dated entry above.
- `cloudflare` — DNS records (A2/A7) and Workers Build vars (Part C #5/#6).
- `git-commit` — committing the Part B change.

## Acceptance criteria

- SaaS Clerk frontend API is `clerk.juanibiapina.dev`; both workers' deployed
  bundles carry a `pk_live` decoding to that domain; old `clerk.zerovault...`
  domain retired (after Task 5 verify).
- Login from vault returns to vault (`/projects`); login from errors returns to
  errors (`/issues`); no forced bounce; cross-product hop keeps the session.
- No worker/KV/DO/migration renames in any diff (Part B touches only
  `@zero/ui` pages + both `main.tsx` + `CHANGELOG.md`).
- Agent app and its Clerk instance untouched.
```
