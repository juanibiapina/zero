# Plan: Fix console Google sign-in landing on the Account Portal

After the Clerk frontend-domain rename to `clerk.apps.juanibiapina.dev`, Google
sign-in on `vault.juanibiapina.dev` / `errors.juanibiapina.dev` completes but the
user lands on the hosted Account Portal user page
(`accounts.apps.juanibiapina.dev`) instead of returning to the app.

Goal: a vault-initiated sign-in returns the user to
`vault.juanibiapina.dev/projects`; an errors-initiated sign-in returns to
`errors.juanibiapina.dev/issues`.

This plan is research + options only. No production code lands from it directly;
it names the exact files and dashboard settings to change and how to verify.

---

## Root cause

Two layers, one underlying architectural fault.

### The architectural fault: the apps are foreign origins to the Clerk instance

Live Clerk dashboard (instance `ins_3EGKil7J2EWNSe96p54lMOqt25X`, app
`app_3EGJu5MjQcEhWYQgYeHUwhwJDTr`, read-only recon on 2026-07-22):

- **Domains → Primary:** `apps.juanibiapina.dev` (Verified, SSL Issued). So the
  Frontend API is `clerk.apps.juanibiapina.dev` and the Account Portal is
  `accounts.apps.juanibiapina.dev`.
- **Domains → Satellites:** *"Multi-domain is not available on your current
  plan."* No satellite domains exist. **Hobby/Free plan.**
- **Domains → Allowed subdomains:** accepts only subdomains **of the primary
  domain** (placeholder `app.apps.juanibiapina.dev`). Currently none enabled.

The two consoles are served on `vault.juanibiapina.dev` and
`errors.juanibiapina.dev`. Those are **siblings** of `apps.juanibiapina.dev`, not
the primary domain and not subdomains of it. Clerk scopes the session cookie to
the Frontend API's domain (`apps.juanibiapina.dev`) and its subdomains. A sibling
host cannot read that cookie, so **neither console can hold a Clerk session on its
own origin.** Cross-registrable-domain or cross-sibling session sharing is exactly
what **satellite domains** are for, and those require the **Pro** plan. On the
current config there is no way for `vault.` / `errors.` to be first-class Clerk
origins.

This is a regression introduced by the rename. Before the rename the primary
domain was `zerovault.juanibiapina.dev` and the vault app was served from that
same host, so vault was same-origin with the instance and worked (errors was
already the broken one that "always bounced to vault"). The rename moved the
primary to `apps.juanibiapina.dev` and moved both apps to `vault.` / `errors.`,
making **both** apps foreign origins. Note: `docs/plans/clerk-repoint.md` step A1
specified renaming the Frontend API to `clerk.juanibiapina.dev` (i.e. primary
domain = the registrable parent `juanibiapina.dev`). The implementation instead
used `clerk.apps.juanibiapina.dev` (primary = the `apps.` subdomain). That one
deviation is what put the apps on sibling origins.

### The visible layer: auth entry routes users to the Account Portal

`packages/ui/src/components/AppLayout.tsx` gates the app with:

```tsx
<SignedOut>
  <RedirectToSignIn />
</SignedOut>
```

`packages/ui/src/auth/AuthProvider.tsx` wraps everything in a bare
`<ClerkProvider publishableKey=… />` with **no `signInUrl` / `signUpUrl`** and no
router integration. With no `signInUrl` configured, Clerk's `RedirectToSignIn`
(and any hosted redirect) uses the instance **Component path** for `<SignIn>`,
which the dashboard has set to *"Sign-in page on Account Portal"* =
`https://accounts.apps.juanibiapina.dev/sign-in`.

Live Paths config (Configure → Paths):

| Setting | Value |
|---|---|
| Home URL | *(blank → Account Portal root)* |
| `<SignIn />` | **Account Portal** → `https://accounts.apps.juanibiapina.dev/sign-in` |
| `<SignUp />` | **Account Portal** → `https://accounts.apps.juanibiapina.dev/sign-up` |
| Signing out | **Account Portal** → `https://accounts.apps.juanibiapina.dev/sign-in` |
| OAuth consent | **Account Portal** → `https://accounts.apps.juanibiapina.dev/oauth-consent` |

Live Account Portal → Redirects:

| Setting | Value |
|---|---|
| After sign-up fallback | `vault.juanibiapina.dev/projects` |
| After sign-in fallback | `vault.juanibiapina.dev/projects` |
| After logo click | `vault.juanibiapina.dev` |

So the actual flow is:

1. User opens `vault.juanibiapina.dev/projects` while signed out.
2. `AppLayout` → `RedirectToSignIn` → **Account Portal** sign-in
   (`accounts.apps.juanibiapina.dev/sign-in`), because no `signInUrl` is set and
   the Component path is the Account Portal.
3. User clicks "Continue with Google". OAuth completes **on the Account Portal
   domain**, and the session cookie is set on `apps.juanibiapina.dev`.
4. The Account Portal now has an active session. Per Clerk's documented rule,
   *"if a user is already signed in and the application only allows a single
   session, Clerk redirects the user to the Home URL instead"* — Home URL is
   blank, which resolves to the Account Portal root (the "My account" user page).
   The user is stranded on `accounts.apps.juanibiapina.dev`.
5. Even if the Account Portal instead honored its after-sign-in fallback
   (`vault.juanibiapina.dev/projects`), the browser would land on vault with a
   cookie it cannot read (foreign origin) → `<SignedOut>` fires again →
   `RedirectToSignIn` → back to the Account Portal. The single-value fallback is
   also vault-only, so it can never send an errors-initiated login back to
   errors.

### Why the previous fix did nothing

Commit `21d69d3` ("web: force same-origin redirect after console sign-in") added
an absolute same-origin `forceRedirectUrl` to the in-app `<SignIn>` / `<SignUp>`
in `apps/*/src/main.tsx` (via `packages/ui/src/pages/SignInPage.tsx` /
`SignUpPage.tsx`). Those props only affect the **in-app** `<SignIn>` component
mounted at the `sign-in/*` route. But users never reach that route: step 2 sends
them to the Account Portal instead. The in-app sign-in page (and its
`/sign-in/sso-callback` handler and `forceRedirectUrl`) is effectively dead code
in the current flow. The prop is harmless and can stay, but it is not the fix.

### One-line root cause

The consoles run on origins (`vault.` / `errors.juanibiapina.dev`) that are
neither the Clerk primary domain nor subdomains of it, so they cannot hold a
Clerk session; combined with `RedirectToSignIn` having no `signInUrl`, every
sign-in is finalized on the Account Portal and the user is left there. Returning
each app to itself requires making the apps first-class Clerk origins.

---

## What already exists in the repo (keep)

- `apps/vault-web/src/main.tsx` and `apps/errors-web/src/main.tsx` already render
  `<SignInPage>` / `<SignUpPage>` at a catch-all `sign-in/*` and `sign-up/*`
  route, so the in-app `/sign-in/sso-callback` is handled in-app **once users
  actually reach the in-app page**. Vault passes `fallbackRedirectUrl="/projects"`
  + `forceRedirectUrl={origin+"/projects"}`; errors passes `/issues`.
- `packages/ui/src/pages/SignInPage.tsx` / `SignUpPage.tsx` mount
  `<SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" …>` /
  `<SignUp routing="path" path="/sign-up" signInUrl="/sign-in" …>`. Correct shape;
  the mounted component internally serves its own `…/sso-callback`.
- These pieces become live the moment the apps are first-class Clerk origins and
  `RedirectToSignIn` targets the in-app `/sign-in`.

The missing repo piece in every option is `signInUrl` / `signUpUrl` on
`ClerkProvider` (`packages/ui/src/auth/AuthProvider.tsx`), so `RedirectToSignIn`
stops pointing at the Account Portal.

---

## Options (ranked)

### Option 1A — Re-home the Clerk primary to `juanibiapina.dev` (recommended, free)

Finish the rename the way `clerk-repoint.md` originally specified: make the Clerk
**primary domain the registrable parent `juanibiapina.dev`** (Frontend API
`clerk.juanibiapina.dev`, Account Portal `accounts.juanibiapina.dev`). Then
`vault.juanibiapina.dev` and `errors.juanibiapina.dev` are **subdomains of the
primary**, share the `.juanibiapina.dev` session cookie, and each self-hosts its
own `<SignIn>` in-app. No Pro plan, no satellite domains, clean URLs unchanged.

Why this works on Hobby: apps on subdomains of the primary domain share the
session automatically (the same mechanism the "Allowed subdomains" screen
governs). Satellite domains are only needed for a **different registrable
domain**; here every app is under `juanibiapina.dev`, so subdomain sharing is the
supported free path.

Dashboard/DNS changes (user-present; Clerk 2FA; DNS access):

1. **Domains → Change domain** to `juanibiapina.dev`. This re-issues the
   production `pk_live` / `sk_live` (the publishable key embeds the Frontend API
   domain) and requires new CNAMEs under `juanibiapina.dev` (`clerk`, `accounts`,
   `clkmail`, `clk._domainkey`, `clk2._domainkey` — exact targets shown per
   instance). Wait for cert green. This is a **domain migration with brief login
   downtime**; follow the sequencing, key-propagation table (12 locations), and
   rollback in `docs/plans/clerk-repoint.md` Parts A and C verbatim — same
   mechanics, new target host.
   - Pre-check: confirm no other Clerk instance already claims `juanibiapina.dev`.
     The **agent** app is a separate Clerk instance on `clerk.zero.juanibiapina.dev`
     (a subdomain) and must not be touched; it does not conflict with a
     `juanibiapina.dev` primary, but verify before the change.
2. **Configure → Paths:** set **Home URL** to `https://vault.juanibiapina.dev/projects`
   (the default landing for a bare login with no `redirect_url`). Set the
   Component paths for `<SignIn>`, `<SignUp>`, Signing out, OAuth consent to
   **"on application domain"** (their single-value limitation is discussed below).
3. **Account Portal → Redirects:** leave after-sign-in / after-sign-up fallback at
   `vault.juanibiapina.dev/projects`; update "after logo click" to
   `vault.juanibiapina.dev`. These are only hit if the Account Portal is ever
   reached, which after this fix is the rare bare-login case.
4. (Optional) **Domains → Allowed subdomains:** enable and add
   `vault.juanibiapina.dev`, `errors.juanibiapina.dev` (and dev/preview hosts) to
   restrict which subdomains may use the instance. Optional hardening, not
   required for the fix.

Repo changes (agent can do):

- `packages/ui/src/auth/AuthProvider.tsx`: add `signInUrl="/sign-in"` and
  `signUpUrl="/sign-up"` (relative, so they resolve per-origin) to
  `<ClerkProvider>`, plus `afterSignOutUrl="/sign-in"`. This makes
  `RedirectToSignIn` (in `AppLayout`) and Clerk's hosted links stay **in-app**
  instead of bouncing to the Account Portal. `signInUrl` set in code takes
  precedence over the dashboard Component path, which sidesteps the single-value
  Paths limitation entirely: each origin's `ClerkProvider` resolves `/sign-in`
  against its own host, so vault points at vault's sign-in and errors at errors'.
- Keep the existing `main.tsx` `forceRedirectUrl` / `fallbackRedirectUrl` and the
  `SignInPage`/`SignUpPage` shape as-is; they now actually run.
- `apps/*/CHANGELOG.md` is the console changelog (`CHANGELOG.md` at repo root per
  `AGENTS.md`): add a user-facing entry, e.g.
  `- 2026-07-22: Signing in with Google from Vault or Errors now returns you to that product instead of the Clerk account page.`

Single-value Paths limitation and how it is worked around: the dashboard
Component path for `<SignIn>` is one value for the whole instance, so it cannot
name both `vault.` and `errors.` sign-in pages. That does not matter here because
each app mounts its **own** `<SignIn routing="path" path="/sign-in">` and sets
`signInUrl="/sign-in"` on its own `ClerkProvider`; the SDK resolves that relative
path against the current origin, so both apps self-host correctly. The dashboard
Component path becomes a fallback that is not exercised in the normal flow. Set it
to "application domain" for cleanliness and point Home URL at the default product.

Cost / who / risk:

- **Cost:** free (stays on Hobby).
- **Needs the user:** yes — Clerk Dashboard (2FA), Cloudflare DNS, and the key
  propagation + redeploy from `clerk-repoint.md` Part C. Brief login downtime
  during the domain switch.
- **Risk:** a second/third domain migration re-issues keys; every location in the
  12-row Part C table must update or bundles break. Rollback = switch the primary
  back and wait for its cert (a maintenance window), same as documented.

### Option 1B — Move the apps under the current primary as subdomains (free, no key reissue)

Keep the Clerk primary at `apps.juanibiapina.dev` and instead serve the consoles
at `vault.apps.juanibiapina.dev` and `errors.apps.juanibiapina.dev`. Now they are
subdomains of the primary and share the session with no Pro plan and **no Clerk
domain change / no key reissue**.

- Repo/infra: change the Cloudflare Worker routes and DNS for both apps to the new
  hostnames (`apps/vault-api/wrangler.jsonc`, `apps/errors-api/wrangler.jsonc`,
  DNS records), enable **Allowed subdomains** for the two new hosts, add the same
  `signInUrl`/`signUpUrl` code change from Option 1A.
- **Cost:** free. **No key reissue** (publishable key domain unchanged), so lower
  blast radius than 1A.
- **Trade-off:** uglier URLs and it reverses the clean Zero-branded subdomains
  shipped in Task 3 (`5842aca`, "serve vault and errors on clean Zero-branded
  subdomains"). Product/branding regression.
- **Needs the user:** Cloudflare DNS + Clerk Dashboard (Allowed subdomains). No
  Clerk domain migration, so no login downtime from key rotation.
- **Risk:** lower than 1A on the Clerk side; requires redirects from the old
  `vault.`/`errors.` hosts for existing links/bookmarks.

Given the branding cost, 1B is the fallback if the domain re-home in 1A is
undesirable.

### Option 2 — Pro satellite domains

Upgrade to **Pro** and register `vault.juanibiapina.dev` and
`errors.juanibiapina.dev` as **satellite domains** of the primary
`apps.juanibiapina.dev`. Keep all current hostnames.

- Repo: per app, set `<ClerkProvider isSatellite domain="vault.juanibiapina.dev"
  signInUrl="https://<primary-sign-in-host>/sign-in" …>` (and the errors
  equivalent), wire the satellite sign-in handshake, and set the
  `VITE_CLERK_*` env vars Clerk requires for satellites. `AuthProvider` becomes
  per-app (it can no longer be a single shared bare provider), or takes the
  satellite domain as a prop.
- **Cost:** Pro plan (~$25/mo) — **billing decision only the user can make.**
- **Reliability:** this is Clerk's officially supported multi-domain path, but it
  is aimed at **different registrable domains**. Here both apps share the
  registrable domain `juanibiapina.dev`, so satellites are heavier than needed;
  Option 1A achieves the same result for free. Satellites also add a primary-app
  handshake hop on every cold sign-in.
- **Needs the user:** billing upgrade + Clerk Dashboard satellite setup + env.
- **Verdict:** not the only reliable route, and not the cleanest here. Choose it
  only if re-homing the primary (1A) or moving app hostnames (1B) is off the
  table for other reasons.

### Recommendation

**Option 1A.** It is free, matches the original `clerk-repoint.md` intent, keeps
the clean `vault.` / `errors.` URLs, and makes both apps first-class Clerk origins
so each self-hosts sign-in and returns to itself. Option 1B is the free fallback
if a Clerk domain migration is unwanted (at a URL-branding cost). Option 2 is a
paid last resort and is overkill for a single registrable domain.

---

## Verification

The real proof is a Google OAuth round trip, which only the user can perform (a
live Google login). Automated checks can only cover the pre-OAuth redirect and the
baked publishable key.

### Manual (user, real Google login) — the acceptance test

Run after the chosen option is deployed and keys propagated. Use a fresh
incognito window each time.

1. Open `https://vault.juanibiapina.dev/projects` signed out → the browser must
   redirect to `vault.juanibiapina.dev/sign-in` (**in-app**, same origin), **not**
   to `accounts.*.juanibiapina.dev`.
2. Click "Continue with Google", finish the Google login → the browser lands on
   `https://vault.juanibiapina.dev/projects`, signed in. The URL must never come
   to rest on `accounts.*.juanibiapina.dev`.
3. Repeat from `https://errors.juanibiapina.dev/issues` → lands on
   `https://errors.juanibiapina.dev/issues`, signed in.
4. Cross-product: while signed in on vault, click "Errors" in the switcher →
   errors loads already signed in, no re-login (shared `.juanibiapina.dev`
   session; only applies to 1A/1B/2 once origins share the cookie).
5. Sign out → returns to the app's own `/sign-in`, not the Account Portal.

### Automated (agent, no Google login)

- Assert the pre-OAuth redirect target is same-origin. From a signed-out request
  to `https://vault.juanibiapina.dev/projects`, the client-side redirect must go
  to `…/sign-in` on the same host, not `accounts.*`. (Check via a headless browse
  session that loads the page and reads `window.location`, since the redirect is
  client-side.)
- Confirm the deployed bundle carries the expected publishable key domain:
  ```bash
  curl -s https://vault.juanibiapina.dev/  | grep -oE 'pk_live_[A-Za-z0-9_-]+' | head -1
  curl -s https://errors.juanibiapina.dev/ | grep -oE 'pk_live_[A-Za-z0-9_-]+' | head -1
  # base64-decode the part after pk_live_; Option 1A expects clerk.juanibiapina.dev
  ```
- Per-package build/type/lint on the touched packages (dev box can't boot
  whole-repo `workerd`, per `AGENTS.md`):
  ```bash
  pnpm --filter @zero/ui run typecheck && pnpm --filter @zero/ui run lint
  pnpm --filter @zero/vault-web run build
  pnpm --filter @zero/errors-web run build
  ```

---

## Skills to use

- `code` — the `AuthProvider` `signInUrl`/`signUpUrl` change (and any per-app
  provider change under Option 2).
- `changelog` — the console-facing entry (root `CHANGELOG.md`).
- `cloudflare` — DNS / Worker routes (Option 1A CNAMEs, Option 1B hostnames) and
  Workers Build `VITE_CLERK_PUBLISHABLE_KEY` vars.
- `reproducible-locally` — framing the verification so the OAuth round trip is
  actually proven, not assumed.
- `git-commit` — committing the repo change.

## Acceptance criteria

- Sign-in initiated from vault returns to `vault.juanibiapina.dev/projects`;
  sign-in initiated from errors returns to `errors.juanibiapina.dev/issues`.
- The browser never rests on `accounts.*.juanibiapina.dev` during or after a
  console sign-in; unauthenticated users are sent to the app's own in-app
  `/sign-in`.
- Cross-product hop keeps the session (no re-login).
- No Worker / KV / DO / migration renames (data-safety constraint from
  `docs/vault-errors-relocation.md`); repo diff is limited to `@zero/ui`
  `AuthProvider`, the console `CHANGELOG.md`, and — for Option 1B/2 — Worker
  route / provider config.
- The agent app and its separate Clerk instance are untouched.

---

## Open questions for the user

- **Plan choice:** re-home the Clerk primary to `juanibiapina.dev` (1A, free, one
  more domain migration), move app hostnames under `apps.` (1B, free, uglier
  URLs), or pay for Pro satellites (2)? 1A recommended.
- **1A pre-check:** confirm nothing else needs the Clerk primary to stay on
  `apps.juanibiapina.dev`, and that no other Clerk instance claims
  `juanibiapina.dev`.
- **Downtime window:** 1A re-issues keys, so schedule the brief login-downtime
  window and pre-stage the Part C key propagation as in `clerk-repoint.md`.
