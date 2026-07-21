# Design: unified "Zero" SaaS console (ZeroVault + ZeroErrors)

Single source of truth for merging the two SaaS products (vault + errors) into
one branded **Zero** console. The **agent** app is out of scope and stays
untouched. Four implementation tasks plan against this doc:

- Task 2 — product selector in `@zero/ui`
- Task 3 — serve vault+errors under their subdomains + Zero branding
- Task 4 — Clerk repoint + frontend-domain rename
- Task 5 — secrets consolidation + key propagation

Research backing every current-state claim: `docs/plans/unified-console-research.md`.
Ops guardrails (never rename workers/KV/DO/migrations): `docs/vault-errors-relocation.md`.

---

## Summary

Vault and errors already share one Clerk instance, one Google connection, one
`APIKEYS` KV, one org model, and the `@zero/ui` shell. What is missing to feel
like "one product" is: (a) a shared **Zero** brand and a **left-side product
selector** to move between the two, (b) a Clerk frontend-API domain that is not
named after `zerovault`, and (c) a login flow that does not always dump the user
on the vault domain. This design delivers those three with **no bundle merge and
no react-router base-path rework**: the two workers stay, each keeps serving its
own Vite `dist` via Workers Assets, and the products are stitched together by a
cross-subdomain selector plus Clerk Dashboard config.

### Goals

- One **Zero** brand across vault + errors, one login, one Clerk instance on a
  generic frontend-API domain (`clerk.juanibiapina.dev`).
- A left-side product selector that cross-links vault ↔ errors.
- Login lands on whichever product the user came from, never a forced bounce to
  vault.
- Zero production-data risk: no worker/KV/DO/migration renames.

### Non-goals

- **Agent app is out of scope.** Separate Clerk instance
  (`clerk.zero.juanibiapina.dev`), separate shell (does not use `@zero/ui`),
  separate domain (`zero.juanibiapina.dev`). No change of any kind.
- No merge of the two Vite bundles into one SPA. No single-origin path routing
  (`/vault`, `/errors`). No react-router `basename` changes.
- No Clerk user-pool merge. No merge of the SaaS instance with the agent
  instance.
- No data migration (auth store already shared).

---

## Current state (from the research doc)

- **Shared Clerk instance (vault + errors).** Both dev publishable keys decode to
  `good-wallaby-70.clerk.accounts.dev`; both prod keys decode to
  `clerk.zerovault.juanibiapina.dev`. The instance is the "zero vault" project;
  errors reuses it. Confirmed by decoding keys, not guessing.
- **Agent is a separate Clerk instance:** dev `talented-prawn-97.clerk.accounts.dev`,
  prod `clerk.zero.juanibiapina.dev`.
- **Shared code:** `@zero/ui` (web shell: `AuthProvider`, `AppLayout`,
  `SignInPage`, `SignUpPage`) and `@zero/auth` (API-key validation), plus the same
  `APIKEYS` KV id `7c218b0980404d559204b24f9e0f1a47` on both workers.
- **One org model** across vault+errors (`getAuth(c).orgId`, `OrganizationSwitcher`
  in `AppLayout`). Agent has **no** org model (per-user `UserDO`).
- **The "always redirect to vault" is not in this repo.** Repo-wide search for
  `forceRedirectUrl|fallbackRedirectUrl|afterSignInUrl|allowedRedirectOrigins`
  returns nothing. It is a property of the shared Clerk instance: its Account
  Portal / after-sign-in home lives on the vault domain, and its frontend API is
  `clerk.zerovault.juanibiapina.dev`. Any app using these keys inherits the vault
  landing.
- **Two workers, each serving its own assets** (`apps/vault-api/wrangler.jsonc`,
  `apps/errors-api/wrangler.jsonc`): `zerovault-api` on `zerovault.juanibiapina.dev`
  from `../vault-web/dist`; `zeroerrors-api` on `zeroerrors.juanibiapina.dev` from
  `../errors-web/dist`. Both SPA fallback, `run_worker_first: /ping,/v1/*,/api/*`.
- **No product-selector component exists.** `AppLayout`
  (`packages/ui/src/components/AppLayout.tsx`) has brand + per-app nav +
  `OrganizationSwitcher` + `UserButton`, no cross-product switch, and no left
  sidebar (the shell is a top sticky header today).
- **Secrets:** four ZeroVault projects feed vault+errors —
  `zerovault`/`zerovault-web` and `zeroerrors`/`zeroerrors-web` — wired in
  `bin/fetch-secrets` and `bin/sync-secrets-to-cloudflare`. `VITE_CLERK_PUBLISHABLE_KEY`
  is also a **Workers Build variable** on both `zerovault-api` and
  `zeroerrors-api` (Workers Builds do not run `bin/fetch-secrets`).

---

## Target architecture

Two SaaS subdomains under `juanibiapina.dev`, one shared **Zero** brand, one
SaaS Clerk instance on `clerk.juanibiapina.dev`, a left-side product selector
that cross-links the two subdomains with absolute URLs. Agent untouched.

```
                 clerk.juanibiapina.dev  (ONE SaaS Clerk instance)
                        |            |
        +---------------+            +----------------+
        |                                            |
  vault.juanibiapina.dev                    errors.juanibiapina.dev
  worker zerovault-api  (UNCHANGED name)    worker zeroerrors-api (UNCHANGED name)
  serves ../vault-web/dist                  serves ../errors-web/dist
        |                                            |
        +--------- left product selector -----------+
                (absolute cross-subdomain links)

  agent: zero.juanibiapina.dev / clerk.zero.juanibiapina.dev  (SEPARATE, no change)
```

### Web subdomain rename decision: **rename to `vault.` / `errors.`**

Recommendation: move the web subdomains from `zerovault.juanibiapina.dev` /
`zeroerrors.juanibiapina.dev` to **`vault.juanibiapina.dev` /
`errors.juanibiapina.dev`**.

- This is a **wrangler `custom_domain` change only** (the `routes` block in
  `apps/vault-api/wrangler.jsonc` and `apps/errors-api/wrangler.jsonc`), plus a
  Cloudflare DNS record per new subdomain. It is **not** a worker rename: the
  worker `name` fields (`zerovault-api`, `zeroerrors-api`), KV ids, DO classes,
  and migration tags all stay verbatim, so production data is untouched (the hard
  constraint holds).
- Reasoning: the brand is **Zero**, and the selector labels are "Vault" /
  "Errors". Product-scoped subdomains (`vault.`, `errors.`) read as
  "Zero's vault", matching the brand, and drop the doubled `zero` in
  `zerovault.`. Cleaner URLs, no data risk.
- Cost: the new custom domains provision fresh Cloudflare edge certs; keep the
  old `zerovault.`/`zeroerrors.` custom domains attached in parallel during
  cutover and add **both** old and new origins to Clerk allowed origins so
  in-flight sessions do not break. Optionally leave a redirect from the old hosts.

Alternative considered — **keep `zerovault.`/`zeroerrors.`**: zero infra churn,
but perpetuates the `zerovault` naming the whole effort is trying to shed, and
still needs the Clerk allowed-origins work anyway. Rejected for branding.

> If the reviewer wants zero DNS churn, keeping the current hosts is a valid
> fallback and only affects Task 3 cosmetics; everything else in this doc is
> identical. See residual decisions.

### One SaaS Clerk instance on `clerk.juanibiapina.dev`

Rename the SaaS instance's Clerk **frontend API domain** from
`clerk.zerovault.juanibiapina.dev` to the generic `clerk.juanibiapina.dev`. Same
instance, same user pool, same Google connection, same org model — only the
frontend-API hostname changes. This re-issues the publishable + secret keys (the
frontend-API domain is embedded in the publishable key), so keys propagate
everywhere (see Secrets section). Runbook below.

---

## Product selector design

### Where it lives

`@zero/ui` `AppLayout` (`packages/ui/src/components/AppLayout.tsx`), consumed by
`apps/vault-web/src/main.tsx` and `apps/errors-web/src/main.tsx`. Agent-web does
not use `@zero/ui`, so it is unaffected by construction.

### Model: cross-subdomain absolute links

Because vault and errors are **separate SPAs on separate subdomains**, the
selector cannot be react-router `<Link>` (in-app routing stays within one
origin). It is a set of **absolute URLs** to the sibling subdomains, e.g.
`https://vault.juanibiapina.dev/` and `https://errors.juanibiapina.dev/`.
Clicking the non-current product is a full navigation to the other worker's SPA;
the shared Clerk session (same instance, cookies scoped to the parent domain
`juanibiapina.dev`) keeps the user signed in across the hop.

> Clerk cookie scope: with both products under `*.juanibiapina.dev` and one
> instance on `clerk.juanibiapina.dev`, the session is shared across subdomains,
> so the cross-product hop does not re-prompt login. Verify the instance's cookie
> domain during Task 4 (Clerk sets this from the frontend-API domain).

### How each app declares the product list and current product

Add to `AppLayoutProps` (new fields, both optional for a safe rollout):

```ts
export interface ProductLink {
  id: string;          // "vault" | "errors"
  label: string;       // "Vault" | "Errors"
  icon: LucideIcon;
  href: string;        // absolute, e.g. https://vault.juanibiapina.dev/
}

export interface AppLayoutProps {
  brand: { name: string; icon: LucideIcon; to: string };
  navItems: NavItem[];
  afterOrgUrl?: string;
  products?: ProductLink[];   // full SaaS product list, same on both apps
  currentProductId?: string;  // which one is "this" app
}
```

Each app passes the **same** `products` array and its own `currentProductId`:

- `apps/vault-web/src/main.tsx`: `currentProductId="vault"`, brand becomes
  **Zero** (icon stays vault's `Shield` or a shared Zero mark — see brand note).
- `apps/errors-web/src/main.tsx`: `currentProductId="errors"`.

The `products` array is small and static; define it once (e.g. a
`packages/ui/src/products.ts` export the two apps import, or inline in each
`main.tsx`). Prefer a shared `@zero/ui` export so the two apps cannot drift.
The absolute hrefs read from env is optional; hardcoding the two prod subdomains
is acceptable given they are stable, but a `VITE_*` override lets dev point at
localhost. **Recommendation:** export a helper from `@zero/ui` that builds the
product list from env vars with prod defaults, so dev (5176/5177/5178) and prod
both work.

### Visual placement (Cloudflare-style left sidebar)

Today `AppLayout` is a top sticky header only. Introduce a **left sidebar** that
holds the product selector at the top (the Zero mark + Vault/Errors switch),
Cloudflare-dashboard style, with the per-product `navItems` below it. Keep the
top bar for `OrganizationSwitcher` + `UserButton`. Concretely:

- Left rail (desktop `md+`): Zero brand, product selector (Vault / Errors, active
  one highlighted), then `navItems` for the current product.
- Top bar: org switcher + user button (unchanged Clerk components).
- The selector's non-active entries are `<a href>` absolute links; the active
  entry is inert.

This is additive to `AppLayout`; the existing `navItems` render moves from the
header into the rail. Behavior (auth redirect, outlet, toaster) unchanged.

### Mobile behavior

The current mobile nav is a horizontal scroll of `navItems` under the header
(`md:hidden`). For mobile: collapse the left rail into a top drawer/sheet or a
compact product dropdown next to the brand. Minimum viable: a product `<select>`
or dropdown (Vault / Errors) in the mobile header that navigates to the absolute
href, with `navItems` staying in the existing horizontal strip. Keep it simple;
the selector is two items.

### Brand note

`brand.name` changes from "ZeroVault"/"ZeroErrors" to **"Zero"** on both apps so
the shell reads as one product; the current **product** is conveyed by the
selected item in the selector, not the brand text. Icons: keep per-product
lucide icons in the selector (`Shield` for vault, `Bug` for errors); the brand
mark can be a neutral Zero glyph.

---

## Clerk frontend-domain rename runbook (Task 4)

Goal: move the SaaS instance's frontend API from
`clerk.zerovault.juanibiapina.dev` to `clerk.juanibiapina.dev` with **no login
downtime**. The publishable key embeds the frontend-API domain, so **old builds
break the instant the old domain stops resolving** — sequence so new keys are
deployed to both workers before the old domain is retired.

### Key ordering principle

1. New frontend-API domain live (DNS + cert green in Clerk) **and**
2. New publishable/secret keys deployed to both workers' builds **before**
3. Retiring the old `clerk.zerovault...` domain.

Never cut over DNS on the old host until every build serving users carries the
new publishable key.

### Steps (outside-repo = Clerk Dashboard / Cloudflare DNS; in-repo = build vars)

1. **[Clerk Dashboard]** On the SaaS instance, add production frontend-API domain
   `clerk.juanibiapina.dev` (Domains / "Add domain" or "Change domain"
   depending on plan). Clerk shows the required **CNAME** targets (frontend API +
   the `clerkstatic`/`accounts` CNAMEs Clerk requires).
2. **[Cloudflare DNS]** Create the CNAME record(s) Clerk specifies for
   `clerk.juanibiapina.dev` (and any `accounts.` / mail CNAMEs). Wait for Clerk to
   verify and issue the SSL cert (status green). Do **not** remove the old
   `clerk.zerovault.juanibiapina.dev` CNAME yet.
3. **[Clerk Dashboard]** Copy the **re-issued** production publishable key
   (`pk_live_...`, now decoding to `clerk.juanibiapina.dev`) and secret key
   (`sk_live_...`). The dev instance keys (`good-wallaby-70...`) are unaffected;
   dev needs no rename.
4. **[In-repo / ZeroVault]** Propagate the new keys to every location (see
   Secrets section): local env files, both Workers Build variables, and the
   ZeroVault secret projects. This is where Task 4 and Task 5 interlock.
5. **[Deploy]** Redeploy both workers (`zerovault-api`, `zeroerrors-api`) so the
   web bundles are rebuilt with the new `VITE_CLERK_PUBLISHABLE_KEY` and the
   workers pick up the new `CLERK_SECRET_KEY`. Verify both dashboards load and
   login works against `clerk.juanibiapina.dev`.
6. **[Clerk Dashboard]** Only after both products are confirmed on the new
   domain, retire `clerk.zerovault.juanibiapina.dev` (remove the old domain).
7. **[Cloudflare DNS]** Remove the stale old `clerk.zerovault...` CNAME.

> Downtime window: between step 5 deploy and step 6/7, both old and new frontend
> API domains resolve, so any bundle (old or new) works. Retiring the old domain
> (step 6/7) is the only irreversible cut; do it last and only after
> verification.

---

## Redirect fix (Task 4, Clerk Dashboard)

The forced-to-vault landing is Clerk Dashboard config on the SaaS instance, not
code. Change, on the SaaS instance:

- **Account Portal → Home URL / after-sign-in / after-sign-up**: repoint from the
  vault host to the unified console entry. Because the two products live on
  separate subdomains, set these to a neutral entry that respects `redirect_url`
  rather than hardcoding vault. Practically: set the Account Portal home to the
  product the user is expected to start on, but rely on **allowed redirect
  origins + `redirect_url`** so login returns the user to the product they came
  from.
- **Allowed redirect origins / allowed origins**: add **both** product
  subdomains — `https://vault.juanibiapina.dev` and
  `https://errors.juanibiapina.dev` (and, during cutover, the old
  `zerovault.`/`zeroerrors.` hosts and localhost dev origins). This is what lets
  errors' sign-in return to errors instead of bouncing to vault.
- **Sign-in / Sign-up URLs**: point at the console's sign-in path
  (`/sign-in`, `/sign-up`) served by each app's `SignInPage`/`SignUpPage`.

### Optional in-repo reinforcement (`@zero/ui`)

`SignInPage` (`packages/ui/src/pages/SignInPage.tsx`) and `SignUpPage` are today
`<SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />` with no redirect
props. To make each product deterministically return to itself regardless of
Account Portal defaults, optionally add per-app
`fallbackRedirectUrl`/`forceRedirectUrl` (e.g. vault →`/projects`, errors
→`/issues`). Thread it as an `AppLayout`/page prop from each `main.tsx`. This is
belt-and-suspenders on top of the Dashboard allowed-origins fix; the Dashboard
change is the necessary one, the code prop is the nice-to-have.

---

## Secrets / build-var propagation (Task 5)

The rename in Task 4 re-issues `VITE_CLERK_PUBLISHABLE_KEY` (public, baked at
build) and `CLERK_SECRET_KEY` (worker runtime). Every place they live must be
updated. Locations:

| Location | What | File / system |
|---|---|---|
| Local worker env (vault) | `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `apps/vault-api/.dev.vars` |
| Local worker env (errors) | `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `apps/errors-api/.dev.vars` |
| Local web env (vault) | `VITE_CLERK_PUBLISHABLE_KEY` | `apps/vault-web/.env`, `.env.production` |
| Local web env (errors) | `VITE_CLERK_PUBLISHABLE_KEY` | `apps/errors-web/.env`, `.env.production` |
| Workers Build var (vault) | `VITE_CLERK_PUBLISHABLE_KEY` | `zerovault-api` build config (Cloudflare) |
| Workers Build var (errors) | `VITE_CLERK_PUBLISHABLE_KEY` | `zeroerrors-api` build config (Cloudflare) |
| Worker prod secret (vault) | `CLERK_SECRET_KEY` (+ `CLERK_PUBLISHABLE_KEY`) | via `wrangler secret bulk` from ZeroVault |
| Worker prod secret (errors) | same | via `wrangler secret bulk` from ZeroVault |
| ZeroVault project `zerovault` | `CLERK_*` | `bin/fetch-secrets`, `bin/sync-secrets-to-cloudflare` |
| ZeroVault project `zerovault-web` | `VITE_CLERK_PUBLISHABLE_KEY` | `bin/fetch-secrets` |
| ZeroVault project `zeroerrors` | `CLERK_*` | both bin scripts |
| ZeroVault project `zeroerrors-web` | `VITE_CLERK_PUBLISHABLE_KEY` | `bin/fetch-secrets` |

Note dev keys (`good-wallaby-70...`) are unchanged; only the **production**
`pk_live_`/`sk_live_` values change. So the `development` environments in
ZeroVault stay as-is; only `production` values rotate.

### bin scripts

- `bin/fetch-secrets` downloads per-project into the local env files above. After
  the key rotation, re-running it (with updated ZeroVault production values)
  refreshes local `.env.production`. No structural change needed if projects are
  kept as-is; only the stored values change.
- `bin/sync-secrets-to-cloudflare` pushes `zerovault` and `zeroerrors` production
  secrets to the two workers via `wrangler secret bulk`. After updating those
  projects' `CLERK_SECRET_KEY`, run this to push to both workers. Note it pushes
  worker **secrets** only; the web `VITE_CLERK_PUBLISHABLE_KEY` on Workers Builds
  is **not** covered by this script and must be updated by hand in each worker's
  Cloudflare Build config (as `docs/vault-errors-relocation.md` documents).

### Collapse the four ZeroVault projects?

**Recommendation: do not collapse in this effort.** The four projects
(`zerovault`, `zerovault-web`, `zeroerrors`, `zeroerrors-web`) map cleanly to the
two workers' runtime vs build-time secrets, and vault has a `MASTER_KEY` errors
does not, so the worker projects are not identical. Collapsing web projects into
one shared `zero-web-saas` (both carry the same `VITE_CLERK_PUBLISHABLE_KEY`) is
tempting and low-risk, but it is orthogonal to the rename and adds churn to
`bin/fetch-secrets`. Defer consolidation to a follow-up; keep Task 5 focused on
**rotating values in place**. (Residual decision if the reviewer wants the
web-project merge now.)

---

## Refined implementation task list (order + dependencies)

Recommended order: **2 → 3 → (4 + 5 together) → cutover retire**.

### Task 2 — product selector in `@zero/ui` (in-repo, no external deps)

- Add `ProductLink`, `products`, `currentProductId` to `AppLayoutProps`; render
  the left-rail selector; move `navItems` into the rail; mobile dropdown.
- Both `main.tsx` pass the shared product list + their `currentProductId`; brand
  → "Zero".
- Ships independently: absolute hrefs can point at the current
  `zerovault.`/`zeroerrors.` hosts until Task 3 renames them. Safe to merge first;
  no auth or infra change.
- **Depends on:** nothing. **Blocks:** nothing hard (Task 3 updates hrefs if
  domains rename).

### Task 3 — serve vault+errors under subdomains + Zero branding (in-repo + Cloudflare DNS)

- **[In-repo]** Update `routes[].pattern` in `apps/vault-api/wrangler.jsonc` and
  `apps/errors-api/wrangler.jsonc` to the new `vault.`/`errors.` custom domains
  (worker names untouched). Update the selector hrefs (Task 2) to the new hosts.
- **[Cloudflare DNS / dashboard]** Provision the new custom domains (certs), keep
  the old ones attached during cutover.
- **Depends on:** Task 2 (selector to update hrefs). **Interlocks with:** Task 4
  allowed-origins (new hosts must be allowed in Clerk).
- If the reviewer keeps `zerovault.`/`zeroerrors.`, this task is branding-only
  (brand text + selector) with no wrangler/DNS change.

### Task 4 — Clerk repoint + frontend-domain rename (mostly Clerk Dashboard + Cloudflare DNS)

- **[Clerk Dashboard]** Frontend-domain rename to `clerk.juanibiapina.dev` (add
  domain, get CNAMEs), redirect fix (Account Portal home + allowed origins for
  both product subdomains + sign-in/up URLs).
- **[Cloudflare DNS]** Add `clerk.juanibiapina.dev` CNAME(s); verify cert.
- **[In-repo, optional]** `forceRedirectUrl`/`fallbackRedirectUrl` on
  `SignInPage`/`SignUpPage`.
- **Must run together with Task 5** because the rename re-issues keys that Task 5
  propagates. Do not retire the old Clerk domain until Task 5's key deploy is
  verified.
- **Depends on:** Task 3 hosts existing (so allowed origins are correct).

### Task 5 — secrets consolidation + key propagation (in-repo bin + ZeroVault + Cloudflare Build vars)

- Update production `CLERK_SECRET_KEY` + `VITE_CLERK_PUBLISHABLE_KEY` in ZeroVault
  projects; run `bin/fetch-secrets` (local) and `bin/sync-secrets-to-cloudflare`
  (worker secrets); update both Workers Build `VITE_CLERK_PUBLISHABLE_KEY` vars by
  hand; redeploy both workers.
- **Runs in lockstep with Task 4** (the rename produces the keys this task
  ships). This pair is the only downtime-sensitive step.

### Cross-task safe sequence (the key rotation)

1. Land Task 2 (selector) and Task 3 (subdomains + branding); verify both
   products load on the new hosts against the **old** Clerk domain.
2. Task 4 step 1–2: bring `clerk.juanibiapina.dev` live in parallel with the old
   Clerk domain; add both product subdomains to allowed origins.
3. Task 5: propagate new keys everywhere; redeploy both workers. Verify login on
   both products.
4. Task 4 final: retire the old `clerk.zerovault...` domain and DNS.

Outside-repo steps: Clerk Dashboard (domain rename, redirect config, key
issuance), Cloudflare DNS (new `clerk.` CNAME + new product custom domains),
Cloudflare Workers Build vars (`VITE_CLERK_PUBLISHABLE_KEY` on both). In-repo:
`AppLayout` selector, `wrangler.jsonc` routes, optional redirect props, ZeroVault
values + bin scripts.

---

## Risks + rollback

- **Baked-in publishable key gotcha (highest risk).** `VITE_CLERK_PUBLISHABLE_KEY`
  is compiled into the web bundle; it embeds the frontend-API domain. The instant
  `clerk.zerovault...` stops resolving, any still-deployed bundle with the old key
  fails. Mitigation: keep old + new Clerk domains live in parallel; retire the old
  only after both workers are redeployed with new keys and verified.
  **Rollback:** if a new-key deploy misbehaves while the old Clerk domain still
  resolves, redeploy the previous bundle (old key) — it still works until the old
  domain is retired. After retiring the old domain, rollback means re-adding it in
  Clerk + DNS.
- **Downtime window during rotation.** Between deploying new keys and Clerk fully
  serving the new domain, a user mid-session could see a transient auth error.
  Mitigation: parallel domains + verify before retire. Window is minutes and
  reversible until the old domain is cut.
- **Custom-domain cert provisioning (Task 3).** New `vault.`/`errors.` custom
  domains need fresh edge certs; provisioning can lag. Mitigation: provision and
  verify the new hosts **before** repointing the selector/Clerk origins; keep old
  hosts attached. **Rollback:** selector hrefs and Clerk origins can point back to
  `zerovault.`/`zeroerrors.` since those workers/domains are unchanged.
- **Clerk cookie / cross-subdomain session.** If the instance's session cookie is
  not scoped to `juanibiapina.dev`, the cross-product hop could re-prompt login.
  Mitigation: verify cookie domain after the frontend-domain rename; Clerk scopes
  it from the frontend API host. **Rollback:** none needed if verified before
  cutover.
- **Org-model assumption.** The selector and shared session assume both products
  use the same org context (they do: shared `orgId`, shared `OrganizationSwitcher`).
  Agent has no org model but is out of scope, so no cross-contamination. Risk only
  if a future product without orgs joins the selector.
- **Hard constraint (data-orphaning) — mitigated by design.** No worker names, KV
  ids, DO classes, or migration tags change. Only `routes[].pattern` (custom
  domain) and secret values change. This keeps `docs/vault-errors-relocation.md`'s
  guarantee intact. **Rollback** for any wrangler change is a one-line revert +
  redeploy.
- **Secrets drift.** Two Workers Build vars are edited by hand (not scripted).
  Risk of updating one worker and not the other. Mitigation: update both in the
  same session; verify both `/ping` and a login on each product post-deploy.

---

## What each user will observe (for CHANGELOG)

- One **Zero** login shared across Vault and Errors (no separate branding per
  product).
- A left-side product switcher to move between Vault and Errors without signing
  in again.
- Signing in from Errors returns you to Errors instead of always bouncing to
  Vault.
- (If the subdomain rename ships) Vault and Errors live at
  `vault.juanibiapina.dev` and `errors.juanibiapina.dev`.

Changelog entries land in the same change as the code, per `AGENTS.md`. Load the
`changelog` skill when writing them. Note the Clerk/domain steps are partly
outside-repo; the CHANGELOG entry ships with the in-repo change that makes the
behavior observable (selector, subdomain routes).

---

## Skills to use during implementation

- `code` — executing each task's edits.
- `changelog` — user-observable entries for tasks 2/3 (selector, subdomains,
  redirect fix).
- `cloudflare` — Workers Assets / custom domains / Build vars for tasks 3 and 5.
- `git-commit` — committing each task.

## Acceptance criteria

- Both products render the Zero brand + left product selector; clicking the other
  product navigates cross-subdomain without re-login.
- Login initiated from either product returns to that product.
- SaaS Clerk frontend API is `clerk.juanibiapina.dev`; both workers run on the new
  keys; old `clerk.zerovault...` domain retired.
- No worker/KV/DO/migration renames in any diff.
- Agent app unchanged (no diff under `apps/agent-*`, no change to its Clerk
  instance/domain).

---

## Residual decisions (could not settle without reviewer / Dashboard access)

- **Web subdomain rename vs keep.** Recommended `vault.`/`errors.`; needs a call
  since it adds DNS/cert churn. If kept, Task 3 becomes branding-only.
- **Collapse ZeroVault web projects** (`zerovault-web` + `zeroerrors-web` → one
  shared `VITE_CLERK_PUBLISHABLE_KEY` project) now vs later. Recommended later.
- **Exact Clerk Dashboard capabilities** for the frontend-domain rename (whether
  the current plan allows in-place domain change vs requires re-add) — verify in
  the Dashboard during Task 4.
- **Account Portal home** target: whether to pick a default product for a bare
  login (no `redirect_url`) or host a neutral chooser. Leaning: default to Vault
  for bare logins, rely on allowed-origins + `redirect_url` for product-initiated
  logins.
- **Clerk session cookie domain** across subdomains — confirm it is
  `juanibiapina.dev`-scoped so the cross-product hop stays signed in.
- **Selector product list source** (shared `@zero/ui` export vs env-driven
  hrefs) — recommended shared export with env override for dev.
