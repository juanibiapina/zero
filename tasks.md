# Pending tasks (zero repo) — captured 2026-07-22

Outstanding follow-ups for this repo. Context: the unified "Zero" SaaS console effort is largely shipped — quota-reached message, left product selector, Zero-branded subdomains, resolve/hide errors issues, tab titles, agent/console changelog split, Tavily research page-fetch, and the full Clerk frontend-domain rename to `clerk.apps.juanibiapina.dev` + the console sign-in fix (Option 1B: apps at `vault.apps.juanibiapina.dev` / `errors.apps.juanibiapina.dev`, sharing the `.apps` Clerk session, isolated from the agent on `zero.juanibiapina.dev`). Login is verified working. The items below are follow-ups and cleanups.

## 1. Old console hosts dropped
Done — the old bare web hosts `vault.juanibiapina.dev` / `errors.juanibiapina.dev` were dropped rather than redirected (no users yet). See `docs/plans/drop-old-console-hosts.md`. The two Worker Custom Domains and their DNS records have been deleted in Cloudflare (confirmed via the Cloudflare API); both hosts now fail to resolve (HTTP 530). No manual step remaining. A full-repo sweep confirmed zero live references to the dead hosts (`docs/plans/sweep-old-host-refs.md`, `docs/plans/sweep-old-host-refs-verify.md`).

## 2. Clerk cleanup (cosmetic + hygiene)
- Rename the Clerk application display name "ZeroVault" -> "Zero" (sign-in card reads "Sign in to Zero"). Clerk dashboard, ZeroVault app.
- Prune orphaned DNS for the OLD Clerk domain (Cloudflare zone juanibiapina.dev), no longer used by the instance: `clerk.zerovault`, `accounts.zerovault`, `clkmail.zerovault`, `clk._domainkey.zerovault`, `clk2._domainkey.zerovault`. Confirm unused before deleting.
- In the Google OAuth client `566245288679-...apps.googleusercontent.com` (project zerovault-497513), remove the unused old redirect URI `https://clerk.zerovault.juanibiapina.dev/v1/oauth_callback`. KEEP `https://clerk.apps.juanibiapina.dev/v1/oauth_callback` and the `good-wallaby-70...` dev one.
- All low-risk; verify login still works after each.

## 3. Swap Tavily dev key for a production key — DEFERRED
Deferred by user decision (2026-07-23): keeping the DEV-tier key (`tvly-dev-...`) in prod for now to benefit from the free tier. The research `read_page` tool (Tavily Extract) still runs on the DEV key. A ready runbook for the swap lives at `docs/plans/tavily-prod-key.md` (verify steps in `docs/plans/tavily-prod-key-verify.md`); execute it when moving to a production Tavily key.

## 4. Doc the Clerk multi-app session-domain constraint  (from retro)
Add a repo doc (e.g. `docs/console-auth.md`, referenced from AGENTS.md) capturing: the SaaS console shares ONE Clerk instance whose primary/frontend-API domain is `apps.juanibiapina.dev`; Clerk scopes the session cookie to the frontend-API domain + its SUBDOMAINS only; each console app must be served on a subdomain of that primary (`vault.apps.`, `errors.apps.`) to hold a session; sibling hosts cannot and get stranded on the hosted Account Portal; the agent is a SEPARATE Clerk instance on `zero.juanibiapina.dev`; `ClerkProvider` needs `signInUrl`/`signUpUrl` (in `packages/ui/src/auth/AuthProvider.tsx`) so `RedirectToSignIn` stays in-app; changing the Clerk frontend domain re-issues the publishable key (destructive cutover) and also requires updating the Google OAuth redirect URI and the instance `allowed_origins` (Backend API, no dashboard UI).

## Note
Process self-improvement tasks (verify-plan/plan, root-cause-first, provider-cutover) live in the dotfiles repo, and the per-topic task-queue task lives in the agent bridge repo. They are tracked in the orchestrator task queue, not here.
