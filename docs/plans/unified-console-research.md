# Research: merging ZeroVault + ZeroErrors into one "Zero" console

Findings on the current auth, Clerk, domain, and app structure, to plan a
unified console (one Clerk project, one Google OAuth, one domain, left-side
product selector) while keeping the **agent** app separate. No code was changed.

## Key facts up front

- **Vault and Errors already share one Clerk instance.** Both dev keys decode to
  `good-wallaby-70.clerk.accounts.dev`; both prod keys decode to
  `clerk.zerovault.juanibiapina.dev`. The Clerk instance is literally the "zero
  vault" project; errors reuses it. So most of the "one Clerk project" goal is
  already true for vault+errors.
- **Agent is a separate Clerk instance.** Dev `talented-prawn-97.clerk.accounts.dev`,
  prod `clerk.zero.juanibiapina.dev`. Keep it separate as requested.
- **Vault and Errors already share code**: `@zero/ui` (web shell) and `@zero/auth`
  (API-key validation), plus the same `APIKEYS` KV namespace id.
- The "always redirects to vault" behavior is **not in this repo**. No
  `forceRedirectUrl` / `afterSignInUrl` / redirect code exists. It comes from the
  shared Clerk instance's Account Portal config (hosted on `clerk.zerovault...`),
  a Clerk Dashboard setting.

---

## 1. Auth package `packages/auth` (@zero/auth)

- Source: `packages/auth/src/index.ts` (the whole package). Exports:
  - `type ApiKeyKVValue` — `{ v: 2; orgId; userId }` (v2 org-scoped keys; legacy
    v1 rejected).
  - `hashApiKey(key)` — SHA-256 hex.
  - `validateApiKey(apikeys: KVNamespace, authHeader)` — validates a `zv_` bearer
    token via KV lookup, returns `{ orgId, userId }` or null.
- **This package has nothing to do with Clerk.** It is only the read path for
  `zv_` API keys (created/revoked in vault, read by every product). It takes the
  `APIKEYS` KV binding directly.
- Consumed by `apps/vault-api` and `apps/errors-api` only
  (`apps/{vault,errors}-api/package.json` list `@zero/auth`). Not used by any web
  app and not by agent.
- **Clerk is configured separately** in each web app and API, not in `@zero/auth`:
  - Web: `packages/ui/src/auth/AuthProvider.tsx` wraps `<ClerkProvider>` with
    `import.meta.env.VITE_CLERK_PUBLISHABLE_KEY`. Shared by vault-web and
    errors-web.
  - API: `apps/{vault,errors}-api/src/app.ts` use `@hono/clerk-auth`
    (`clerkMiddleware()`, `getAuth(c)`) reading `CLERK_PUBLISHABLE_KEY` /
    `CLERK_SECRET_KEY` from env (`apps/{vault,errors}-api/src/types.ts`).
- **How the Clerk instance is identified:** purely by the publishable/secret key
  pair supplied via env vars. There is no hardcoded Clerk domain or per-app
  discriminator in code. The instance is whatever the injected keys point to. So
  vault and errors point at the same instance because they are fed the same keys
  (see §7).
- JWT verification: standard `@hono/clerk-auth`; org context comes from
  `getAuth(c).orgId` (populated when an org is active on the session). No org →
  403 (`apps/vault-api/src/app.ts` ~line 116, `apps/errors-api/src/app.ts` ~line
  116). CORS `origin: "*"` on `/v1/*` (public API); `/api/*` is Clerk-guarded.

## 2. Vault app `apps/vault-api` + `apps/vault-web`

- **Sign-in flow (web):** `apps/vault-web/src/App.tsx` wraps everything in
  `AuthProvider` (`@zero/ui`). `apps/vault-web/src/main.tsx` mounts `AppLayout`
  (from `@zero/ui`) with `brand: { name: "ZeroVault", to: "/projects" }` and
  routes `sign-in/*` → `SignInPage`, `sign-up/*` → `SignUpPage`. `AppLayout`
  redirects unauthenticated users via `<RedirectToSignIn />`
  (`packages/ui/src/components/AppLayout.tsx`).
- `SignInPage` (`packages/ui/src/pages/SignInPage.tsx`) is
  `<SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />` — **no**
  `forceRedirectUrl`/`fallbackRedirectUrl`.
- **The "always redirect to vault" is not in this repo.** A repo-wide search for
  `forceRedirectUrl|fallbackRedirectUrl|afterSignInUrl|allowedRedirectOrigins`
  returns nothing. The redirect is a property of the shared Clerk instance: its
  Account Portal / after-sign-in home URL is configured (in the Clerk Dashboard)
  to the vault domain, and the instance's frontend API lives at
  `clerk.zerovault.juanibiapina.dev`. Any app using these keys inherits that
  redirect. This is a Clerk-side config a plan must change, not code here.
- **Domain / wrangler:** `apps/vault-api/wrangler.jsonc`
  - `name: "zerovault-api"`, custom domain route `zerovault.juanibiapina.dev`.
  - Serves the web app via **Workers Assets**: `assets.directory:
    "../vault-web/dist"`, SPA fallback, `run_worker_first: ["/ping","/v1/*","/api/*"]`.
  - Secrets required: `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `ENVIRONMENT`,
    `MASTER_KEY`.
  - KV `APIKEYS` id `7c218b0980404d559204b24f9e0f1a47`.
  - DOs: `OrgDO`, `ProjectVaultDO` (migrations v1/v2/v3).
- **Clerk key used:** prod `VITE_CLERK_PUBLISHABLE_KEY` decodes to
  `clerk.zerovault.juanibiapina.dev`; dev to `good-wallaby-70.clerk.accounts.dev`.

## 3. Errors app `apps/errors-api` + `apps/errors-web`

- **Sign-in flow:** identical shape to vault. `apps/errors-web/src/App.tsx` +
  `main.tsx` mount the same `@zero/ui` `AuthProvider` + `AppLayout`, brand
  `{ name: "ZeroErrors", to: "/issues" }`, same `sign-in/*` and `sign-up/*`
  routes and same `SignInPage`. Same `RedirectToSignIn`.
- **Domain / wrangler:** `apps/errors-api/wrangler.jsonc`
  - `name: "zeroerrors-api"`, custom domain `zeroerrors.juanibiapina.dev`.
  - Workers Assets from `../errors-web/dist`, same SPA + `run_worker_first` config.
  - Secrets required: `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `ENVIRONMENT`
    (no `MASTER_KEY`; that's vault-only).
  - KV `APIKEYS` id **`7c218b0980404d559204b24f9e0f1a47`** — the **same** id as
    vault (intentional, per `docs/vault-errors-relocation.md`). One shared API-key
    store across both products.
  - DO: `ErrorsDO` (migration v1).
- **Shared Clerk with vault — confirmed by decoding the keys, not by guessing:**
  - errors dev key → `good-wallaby-70.clerk.accounts.dev` (same as vault dev).
  - errors prod key → `clerk.zerovault.juanibiapina.dev` (same as vault prod).
  - So the user is right: the Clerk project is the "zero vault" instance, and
    errors reuses it. `docs/vault-errors-relocation.md` states outright: "the
    public key shared by both dashboards' Clerk instance."
- Because the Clerk frontend API and Account Portal live on the **vault** domain,
  signing in on errors bounces through vault's hosted Clerk pages — the mechanism
  behind "post-login always goes to vault."

## 4. Agent app `apps/agent-api` + `apps/agent-web` + `apps/agent-mobile`

- **Separate Clerk instance — confirmed.**
  - `apps/agent-web` prod `VITE_CLERK_PUBLISHABLE_KEY` → `clerk.zero.juanibiapina.dev`;
    dev → `talented-prawn-97.clerk.accounts.dev`. Different instance from
    vault/errors.
  - Web wires Clerk itself in `apps/agent-web/src/App.tsx`
    (`ClerkProvider` with `VITE_CLERK_PUBLISHABLE_KEY`), **not** via `@zero/ui`.
    Agent-web has its own shell (`src/components/AppHeader.tsx`) and does not
    depend on `@zero/ui` or `@zero/auth`.
  - API: `apps/agent-api/src/app.ts` uses `@clerk/hono` `clerkMiddleware()` +
    `getAuth`; `apps/agent-api/src/google-token.ts` and `github-token.ts` use
    `@clerk/backend` `createClerkClient` with the agent's `CLERK_SECRET_KEY` /
    `CLERK_PUBLISHABLE_KEY`.
  - Mobile: `apps/agent-mobile/src/lib/env.ts` reads
    `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` and defaults the API to
    `https://zero.juanibiapina.dev`. AGENTS.md says mobile shares the same Clerk
    instance as agent **web** (the agent instance), which is consistent — it is
    the agent instance, still separate from vault/errors.
- Agent has **no org model** (no `OrganizationSwitcher`, no `orgId` in
  `apps/agent-api/src`); it is per-user (`UserDO`, `clerkUserId`). Vault/errors
  are org-scoped. This is a structural difference from the vault/errors Clerk
  setup.
- **Conclusion:** agent's Clerk is separate from vault/errors Clerk. Keeping agent
  separate (as requested) is the current state; no change needed there.

## 5. Domains / routing

Every custom domain / route across wrangler configs:

| Worker | Config | Domain / route | Web served by |
|---|---|---|---|
| `zerovault-api` | `apps/vault-api/wrangler.jsonc` | `zerovault.juanibiapina.dev` (custom_domain) | Workers Assets `../vault-web/dist`, SPA, `run_worker_first: /ping,/v1/*,/api/*` |
| `zeroerrors-api` | `apps/errors-api/wrangler.jsonc` | `zeroerrors.juanibiapina.dev` (custom_domain) | Workers Assets `../errors-web/dist`, same |
| `zero-api` (agent) | `apps/agent-api/wrangler.jsonc` | `zero.juanibiapina.dev/*` (route, `zone_name juanibiapina.dev`) | Workers Assets `../agent-web/dist`, SPA, `run_worker_first: /api/*` |

- All three web apps are **Cloudflare Workers Assets** (not Pages): each API
  worker serves its own `dist` with SPA fallback and runs the worker first only
  for API paths. Web is a Vite build (`build.outDir: dist`) baked with
  `VITE_CLERK_PUBLISHABLE_KEY` at build time.
- Clerk frontend API domains (from the keys): agent `clerk.zero.juanibiapina.dev`,
  vault+errors `clerk.zerovault.juanibiapina.dev`. Each is a CNAME the Clerk
  instance owns.
- **What "one domain with a product selector" requires:**
  - Two viable shapes:
    - **Path-based** (Cloudflare-style, `zero.dev/vault`, `zero.dev/errors`): one
      worker (or a router) serving one combined SPA, each product mounted under a
      base path. Needs: merge the two Vite apps into one bundle (or one worker
      routing `/vault/*` and `/errors/*` to the right assets), rework
      react-router base paths, and set Clerk redirect URLs to the single origin.
    - **Subdomain** (`vault.zero.dev`, `errors.zero.dev`): keep two workers/bundles
      but move them under one apex and one Clerk instance; the "product selector"
      links across subdomains. Less code churn, but not truly "one domain."
  - Either way the **Clerk instance's allowed origins / redirect URLs / Account
    Portal home** must be pointed at the new unified domain instead of
    `zerovault...`. That is the concrete fix for the forced-to-vault redirect.
  - The shared `APIKEYS` KV and org model already span vault+errors, so a merged
    console does not need data migration for auth.

## 6. Shared UI `packages/ui` (@zero/ui)

- Exports (`packages/ui/src/index.ts`): `AuthProvider`, `AppLayout`
  (+ `AppLayoutProps`, `NavItem`), `SignInPage`, `SignUpPage`, `fetchApi`,
  `cn`, and shadcn primitives (`Button`, `Card`, `Input`, `Label`, `Toaster`,
  `Table`).
- `AppLayout` (`packages/ui/src/components/AppLayout.tsx`) is the shared shell:
  sticky header with `brand` (name/icon/link), `navItems` list, Clerk
  `OrganizationSwitcher` + `UserButton`, responsive mobile nav, `<Outlet/>`,
  and `SignedIn`/`SignedOut` → `RedirectToSignIn`. Product-specific bits (brand,
  nav, `afterOrgUrl`) are **props**, so vault and errors already render "one
  visual family."
- **No existing product-selector / cross-product shell component.** The header
  has brand + per-app nav + org switcher + user button, but nothing to switch
  between vault and errors. That component would be new work. The natural home is
  `@zero/ui` `AppLayout` (add a product selector slot next to the brand).
- Consumed by vault-web and errors-web only. Agent-web does not use it.

## 7. Env / secrets (ZeroVault projects)

From `bin/fetch-secrets` (source of truth for which project feeds which app):

| App | Worker runtime (`.dev.vars` / CF) | Web build-time (`.env` / `.env.production`) |
|---|---|---|
| agent | project `zero-api` | project `zero-web` |
| vault | project `zerovault` | project `zerovault-web` |
| errors | project `zeroerrors` | project `zeroerrors-web` |

- **Clerk/auth-related secret names:**
  - Worker (`zero-api`, `zerovault`, `zeroerrors`): `CLERK_PUBLISHABLE_KEY`,
    `CLERK_SECRET_KEY` (agent-api also has Clerk webhook secret per
    `docs/clerk-webhook.md`; vault adds `MASTER_KEY`, both add `ENVIRONMENT`).
  - Web (`zero-web`, `zerovault-web`, `zeroerrors-web`): `VITE_CLERK_PUBLISHABLE_KEY`
    (agent-web also `VITE_TELEGRAM_BOT_USERNAME`).
- **Confirmed shared values:** local generated env files show `zerovault-web` and
  `zeroerrors-web` carry the **same** Clerk publishable key (both decode to
  `clerk.zerovault...` in prod, `good-wallaby-70...` in dev). Their worker
  secret keys are the same Clerk instance too.
- Build note (`docs/vault-errors-relocation.md`): Workers Builds do not run
  `bin/fetch-secrets`, so `VITE_CLERK_PUBLISHABLE_KEY` is also set as a **Workers
  Build variable** on both `zerovault-api` and `zeroerrors-api` build configs.
  A merged console changes where this is set.
- `docs/secrets.md` documents only the agent (`zero-api`/`zero-web`) projects;
  the vault/errors projects are documented in `docs/vault-errors-relocation.md`.

## 8. Google OAuth

- Google sign-in is a **Clerk social connection**, configured per Clerk instance
  in the Clerk Dashboard. There is **no separate Google OAuth client** in the
  repo: a search for `GOOGLE_CLIENT`/`client_id` finds only the agent's Workspace
  scope list, not an OAuth app.
- Agent uses Google through Clerk: `apps/agent-api/src/google-token.ts` calls
  `clerk.users.getUserOauthAccessToken(userId, "google")`; scopes requested in
  `apps/agent-web/src/google-scopes.ts` (gmail.modify, calendar, drive) via
  Clerk's `createExternalAccount`/`reauthorize`.
- Vault/errors: any Google sign-in they offer is the Google social connection on
  the shared vault Clerk instance (Dashboard config, nothing in this repo).
- **Because Google is per-Clerk-instance**, "one Google OAuth" for the console is
  automatically satisfied once vault+errors share one Clerk instance (they
  already do). The agent instance has its own Google connection (with Workspace
  scopes) and stays separate.

---

## Implications for merging (decisions & unknowns a plan must resolve)

**Already true (low risk):**
- Vault and errors share one Clerk instance, one Google connection, one
  `APIKEYS` KV, one org model, and one shared UI shell (`@zero/ui` `AppLayout`).
  The "one Clerk project / one Google OAuth" goal is essentially met for
  vault+errors today.
- Agent is a cleanly separate Clerk instance and app shell; keeping it separate
  needs no change.

**Decisions to make:**
1. **Domain shape:** path-based single origin (`zero.dev/vault`, `/errors`, true
   "one domain") vs. subdomains under one apex. Path-based means merging the two
   Vite bundles or one worker routing to two asset sets; subdomains keep two
   workers. This is the biggest architectural fork.
2. **Where the product selector lives:** add it to `@zero/ui` `AppLayout` (new
   component; none exists). Decide selector model — links vs. in-app routing —
   which depends on decision 1.
3. **Clerk redirect config:** the forced-to-vault redirect is a Clerk Dashboard
   setting (Account Portal home + allowed origins on the `clerk.zerovault...`
   instance). Repoint it to the unified domain. Consider renaming the Clerk
   instance/domain away from `zerovault` if the console is "Zero" (the frontend
   API CNAME `clerk.zerovault.juanibiapina.dev` is baked into every prod
   publishable key — changing it re-issues keys and updates every build var).
4. **Worker/deploy topology:** two workers (`zerovault-api`, `zeroerrors-api`)
   today, each serving its own assets with a custom domain and Workers Build
   config + `VITE_CLERK_PUBLISHABLE_KEY` build var. A merged domain changes routes,
   asset serving, and where that build var is set. Do not rename workers, KV ids,
   DO classes, or migration tags (relocation doc warns this orphans prod data).
5. **Secrets consolidation:** whether to collapse `zerovault*` + `zeroerrors*`
   ZeroVault projects (and their build vars) into one console project, and update
   `bin/fetch-secrets` / `bin/sync-secrets-to-cloudflare` accordingly.

**Unknowns / to verify outside the repo:**
- Exact Clerk Dashboard settings on the vault instance (Account Portal home URL,
  allowed redirect origins, sign-in/up URLs) — these drive the redirect behavior
  and are not in the repo.
- Whether the vault Clerk instance's Google connection scopes suffice for the
  console, or whether renaming the instance/domain is desired for branding.
- Cloudflare custom-domain / zone setup for the new unified domain (DNS, the
  `clerk.*` CNAME) — infra outside the repo.
