# Console auth: the Clerk multi-app session-domain constraint

Why the console web apps live under `*.apps.juanibiapina.dev`: Clerk scopes the
session cookie to its primary domain and that domain's subdomains only. This doc
records the constraint learned during the console rename so future work does not
rediscover it.

## TL;DR

The SaaS console (ZeroVault + ZeroErrors) shares one Clerk instance whose primary
domain is `apps.juanibiapina.dev`. Clerk scopes the session cookie to that domain
and its subdomains only, so each console app must be served on a subdomain of it
(`vault.apps.juanibiapina.dev`, `errors.apps.juanibiapina.dev`) to hold a session.
Sibling hosts (a different subdomain of the registrable parent) cannot read the
cookie and get stranded on the hosted Account Portal. The agent (Zero assistant)
is a separate Clerk instance on `zero.juanibiapina.dev`; never merge the two.

## The two Clerk instances

**Console (ZeroVault + ZeroErrors)** — one shared instance:

- Primary domain: `apps.juanibiapina.dev`
- Frontend API host: `clerk.apps.juanibiapina.dev` (the primary with the `clerk.`
  label; the two differ by that label, do not conflate them)
- Account Portal: `accounts.apps.juanibiapina.dev`
- Instance `ins_3EGKil7J2EWNSe96p54lMOqt25X`, app
  `app_3EGJu5MjQcEhWYQgYeHUwhwJDTr`, Hobby/Free plan (no satellite domains) — as
  recorded in `docs/plans/console-signin-redirect.md` (recon 2026-07-22); verify
  against the live instance before acting on it.

**Agent (Zero assistant)** — a separate instance:

- Domain `zero.juanibiapina.dev`, Frontend API `clerk.zero.juanibiapina.dev` (dev
  `talented-prawn-97.clerk.accounts.dev`). Source:
  `docs/plans/unified-console-design.md` (the separate-instance fact);
  `docs/telegram-login.md` confirms the agent domain only.
- Untouched by console work. Do not merge it with the console instance.

## The session-cookie constraint (the core lesson)

Clerk scopes the session cookie to the Frontend API's primary domain plus its
subdomains only. Subdomains of the primary share the session automatically; this
is the mechanism the Clerk Dashboard "Allowed subdomains" screen governs, and that
screen accepts only subdomains of the primary domain.

A sibling host (a different subdomain of the registrable parent, e.g. the old
`vault.juanibiapina.dev` / `errors.juanibiapina.dev` against primary
`apps.juanibiapina.dev`) cannot read the cookie, so it cannot hold a session.
Every sign-in then finalizes on the hosted Account Portal
(`accounts.apps.juanibiapina.dev`) and leaves the user stranded there.

Sharing a session across siblings or across registrable domains is what Clerk
satellite domains are for, and those require the Pro plan. Source:
`docs/plans/console-signin-redirect.md` (root cause and options).

## Why the console apps live on `*.apps.` subdomains

Because of the constraint above, each app is served on a subdomain of the primary:

- `vault.apps.juanibiapina.dev`
- `errors.apps.juanibiapina.dev`

These are the canonical web hosts, wired in `packages/ui/src/products.ts`
(`PROD_VAULT_URL`, `PROD_ERRORS_URL`). This is the shipped path — Option 1B in
`docs/plans/console-signin-redirect.md`: serve the apps as subdomains of the
existing primary, free, no key reissue.

`console-signin-redirect.md` recommends Option 1A (re-home the primary to the
registrable parent `juanibiapina.dev` so the bare `vault.` / `errors.` hosts
become subdomains). Option 1A was not taken; it remains an un-taken recommendation,
not pending or planned work. The bare `vault.` / `errors.juanibiapina.dev` sibling
hosts were dropped (`docs/plans/drop-old-console-hosts.md`).

The `zerovault.` / `zeroerrors.` **API** hosts stay attached and are unrelated to
the session constraint: they serve the API for CLI and error-ingest consumers
(`zerovault-cli` default base URL, agent-api errors endpoint), not the web session.
Do not confuse them with the web hosts.

## The in-app `signInUrl` / `signUpUrl` requirement

The shared `AuthProvider` (`packages/ui/src/auth/AuthProvider.tsx`) sets
`signInUrl="/sign-in"` and `signUpUrl="/sign-up"` (plus
`afterSignOutUrl="/sign-in"`) on `<ClerkProvider>`. These are relative paths, so
each origin's provider resolves `/sign-in` against its own host (vault to vault's
sign-in, errors to errors'). A `signInUrl` set in code takes precedence over the
single-value dashboard Component path.

That keeps `RedirectToSignIn` (in `packages/ui/src/components/AppLayout.tsx`)
in-app instead of bouncing to the Account Portal. Without these props,
`RedirectToSignIn` uses the instance Component path, which points at the Account
Portal. This fix is in place. Source: `docs/plans/console-signin-redirect.md` plus
the live `AuthProvider.tsx`.

## Changing the Clerk frontend domain is a destructive cutover

If anyone re-homes the console instance's primary/frontend domain, the change
re-issues the `pk_live` publishable key, because the key embeds the Frontend API
domain. That forces updating every location carrying the key (see the 12-row
propagation table in `docs/plans/clerk-repoint.md` Part C), new DNS CNAMEs, and
brief login downtime.

It also requires updating the instance `allowed_origins` / "Allowed subdomains",
which is Clerk instance config managed in the Dashboard
(`clerk-repoint.md` tags allowed origins `[Clerk Dashboard]`;
`console-signin-redirect.md` describes "Allowed subdomains" as a Dashboard screen).
These are live dashboard state — as recorded in the plans (recon 2026-07-22);
verify against the live instance before acting.

A custom Clerk Frontend API domain also changes the OAuth callback host registered
with Google, so the Google OAuth redirect URI must be updated. This is general
Clerk behavior, not recorded in the cited plans; verify against Clerk docs and the
live Google/Clerk config before acting.

### The `clerk.juanibiapina.dev` target was superseded

A frontend-domain rename did ship: the Frontend API moved off
`clerk.zerovault.juanibiapina.dev` to `clerk.apps.juanibiapina.dev`, exercising the
destructive-cutover mechanics above. `docs/plans/clerk-repoint.md` proposed a
different target, `clerk.juanibiapina.dev` (primary = the registrable parent). That
specific target was not the host used; treat it as a stale/superseded target, not
as live. The live Frontend API is `clerk.apps.juanibiapina.dev`. The rename
happened — only `clerk-repoint.md`'s target host was superseded. Its Part A/C
cutover mechanics stay accurate and reusable.

## Pointers

- `docs/plans/console-signin-redirect.md` — live recon (2026-07-22), root cause,
  and the ranked options (1A/1B/2).
- `docs/plans/subdomain-rename.md` — the earlier state when apps ran on the bare
  `vault.` / `errors.` sibling hosts.
- `docs/plans/clerk-repoint.md` — destructive-cutover mechanics; its proposed
  target `clerk.juanibiapina.dev` was superseded by the shipped
  `clerk.apps.juanibiapina.dev`.
- `docs/plans/drop-old-console-hosts.md` — dropping the bare sibling web hosts.
