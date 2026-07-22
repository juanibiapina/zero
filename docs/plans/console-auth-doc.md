# Plan: repo doc for the Clerk multi-app session-domain constraint

Pure documentation change. Add one repo doc that captures the Clerk multi-app
auth constraint learned during the console rename, and reference it from
`AGENTS.md`. No code, no tests, no changelog (internal doc; see "No changelog").

## Goal (verbatim)

Add a repo doc (e.g. `docs/console-auth.md`, referenced from AGENTS.md) capturing
the Clerk multi-app auth constraint learned during the console rename, so future
work doesn't rediscover it painfully:

- The SaaS console (ZeroVault + ZeroErrors) shares ONE Clerk instance whose
  primary/frontend-API domain is `apps.juanibiapina.dev`.
- Clerk scopes the session cookie to the frontend-API domain + its SUBDOMAINS
  only.
- Each console app must be served on a subdomain of that primary (`vault.apps.`,
  `errors.apps.`) to hold a session; sibling hosts (like the old
  `vault.`/`errors.`) cannot and get stranded on the hosted Account Portal.
- The agent is a SEPARATE Clerk instance on `zero.juanibiapina.dev`.
- `ClerkProvider` needs `signInUrl`/`signUpUrl` (in
  `packages/ui/src/auth/AuthProvider.tsx`) so `RedirectToSignIn` stays in-app.
- Changing the Clerk frontend domain re-issues the publishable key (destructive
  cutover) and also requires updating the Google OAuth redirect URI and the
  instance `allowed_origins` / "Allowed subdomains" (Backend API, no dashboard UI
  for some of it).

## Research findings (what is already documented, and where)

The constraint is currently spread across four plan files under `docs/plans/`.
Nothing in `docs/` (top level) captures it; there is no existing top-level auth
doc for the console. `docs/clerk-webhook.md` covers only the agent's Clerk
webhook, and `docs/telegram-login.md` covers the agent login widget — neither
touches the console session-domain constraint. So the new doc **consolidates**;
it does not duplicate an existing top-level doc.

Sources (read these before writing, cite them in the doc):

- **`docs/plans/console-signin-redirect.md`** — the authoritative live recon
  (read-only, 2026-07-22). Establishes:
  - Primary Clerk domain = `apps.juanibiapina.dev` (Verified, SSL Issued), so the
    Frontend API host is `clerk.apps.juanibiapina.dev` and the Account Portal is
    `accounts.apps.juanibiapina.dev`. Instance `ins_3EGKil7J2EWNSe96p54lMOqt25X`,
    app `app_3EGJu5MjQcEhWYQgYeHUwhwJDTr`. Hobby/Free plan (multi-domain /
    satellites unavailable).
  - The session cookie is scoped to the Frontend API domain
    (`apps.juanibiapina.dev`) and its **subdomains** only; a **sibling** host
    (`vault.`/`errors.juanibiapina.dev`) cannot read it, so it cannot hold a
    session and every sign-in finalizes on the Account Portal, stranding the user.
  - The missing repo piece was `signInUrl`/`signUpUrl` on `ClerkProvider` in
    `packages/ui/src/auth/AuthProvider.tsx`; without it `RedirectToSignIn` points
    at the Account Portal instead of the in-app `/sign-in`.
  - "Allowed subdomains" accepts only subdomains **of the primary**.
  - **Option 1B** was the chosen fallback: serve the apps at
    `vault.apps.juanibiapina.dev` / `errors.apps.juanibiapina.dev` (subdomains of
    the primary), free, no key reissue.
- **`docs/plans/subdomain-rename.md`** (Task 3) — the earlier state: apps briefly
  served on the bare `vault.`/`errors.juanibiapina.dev` sibling hosts (the ones
  that could not hold a session). Also records that the session cookie is scoped
  to the parent domain and that Clerk allowed-origins work is a separate task.
- **`docs/plans/clerk-repoint.md`** (Task 4) — a plan whose **specific target was
  superseded**. Be precise here (verify finding C3): a frontend-domain rename
  **did ship** — the Frontend API moved off `clerk.zerovault.juanibiapina.dev` to
  `clerk.apps.juanibiapina.dev`, exercising exactly the destructive-cutover
  mechanics this plan's Part A/C describe. What was **not** implemented is only
  this plan's *proposed target* `clerk.juanibiapina.dev` (primary = the
  registrable parent); the live primary is `apps.juanibiapina.dev`
  (`console-signin-redirect.md:3,50-56`: "The implementation instead used
  `clerk.apps.juanibiapina.dev`"). Cite it as the source for the
  destructive-cutover mechanics: changing the Clerk frontend domain **re-issues
  the `pk_live` publishable key** (it embeds the Frontend API domain) and forces
  updating every location that carries the key (its Part C 12-row table), the DNS
  CNAMEs, and login downtime. Flag clearly in the doc that `clerk.juanibiapina.dev`
  is a stale/superseded **target** and never went live — but do **not** say "no
  rename happened," because the live Frontend API is `clerk.apps.juanibiapina.dev`
  (not the old `clerk.zerovault...`).
- **`docs/plans/drop-old-console-hosts.md`** — records the sibling-host
  consequence being resolved by **dropping** the bare `vault.`/`errors.` web
  hosts (no users yet). Confirms `packages/ui/src/products.ts` now points at the
  `*.apps` hosts, and the canonical web hosts are `vault.apps.juanibiapina.dev` /
  `errors.apps.juanibiapina.dev`. The `zerovault.`/`zeroerrors.` **API** hosts
  stay attached (live consumers: `zerovault-cli` `DEFAULT_BASE_URL`, agent-api
  `zero-errors.ts` ENDPOINT).

Verified against the repo (not assumed):

- **`packages/ui/src/auth/AuthProvider.tsx`** — read live. The shared
  `AuthProvider` renders
  `<ClerkProvider publishableKey={…} signInUrl="/sign-in" signUpUrl="/sign-up" afterSignOutUrl="/sign-in">`.
  So the `signInUrl`/`signUpUrl` fix from `console-signin-redirect.md` **has
  landed**. The mechanism to state accurately: these are **relative** paths, so
  each origin's `ClerkProvider` resolves `/sign-in` against its own host (vault →
  vault's sign-in, errors → errors'), and a `signInUrl` set in code takes
  precedence over the dashboard Component path — which is why `RedirectToSignIn`
  (in `packages/ui/src/components/AppLayout.tsx`) stays in-app instead of bouncing
  to the Account Portal.
- **Agent is a separate Clerk instance** — confirmed by
  `docs/plans/unified-console-design.md` (prod `clerk.zero.juanibiapina.dev`, dev
  `talented-prawn-97.clerk.accounts.dev`, domain `zero.juanibiapina.dev`, "SEPARATE,
  no change") and `docs/telegram-login.md` (agent bot domain
  `zero.juanibiapina.dev`). The console instance is a different instance whose
  prod keys historically decoded to `clerk.zerovault.juanibiapina.dev` and now
  sit on the `apps.juanibiapina.dev` primary.

**Precision note for the writer:** the goal text says the primary "frontend-API
domain is `apps.juanibiapina.dev`". State it exactly: the **primary domain** is
`apps.juanibiapina.dev`; the **Frontend API host** is `clerk.apps.juanibiapina.dev`
and the **Account Portal** is `accounts.apps.juanibiapina.dev`. The cookie is
scoped to `apps.juanibiapina.dev` + subdomains. Do not blur "primary domain" and
"Frontend API host" — they differ by the `clerk.` label.

**Live-state caveat to carry into the doc:** the instance IDs, plan tier, "Allowed
subdomains" contents, allowed-origins, and Account Portal Paths are **live Clerk
dashboard state** recorded in `console-signin-redirect.md` on 2026-07-22. The doc
must mark these as "as recorded in `docs/plans/console-signin-redirect.md` (recon
2026-07-22); verify against the live instance before acting on it." Do not assert
them as permanently-true in-repo facts. **The Google OAuth redirect URI is NOT in
this set** — it is not recorded in `console-signin-redirect.md` or any cited plan
(verify C1). Treat it as general Clerk behavior and do not attribute it to a plan;
see §6.

## New doc

Path: **`docs/console-auth.md`** (top-level `docs/`, matching the goal's
suggested `docs/console-auth.md` and the existing convention that stable
reference docs live in `docs/` while `docs/plans/` holds task plans).

Keep it tight (roughly one screen). Every technical claim sourced to a plan or to
the repo file it came from. Suggested sections and the key facts each must state:

1. **Scope / TL;DR** — One paragraph: the SaaS console (ZeroVault + ZeroErrors)
   shares ONE Clerk instance; the agent is a SEPARATE instance; each console app
   must be served on a **subdomain of the console instance's primary domain** to
   hold a session. One-line rule: "console web apps live under
   `*.apps.juanibiapina.dev` because Clerk scopes the session cookie to the
   primary domain and its subdomains only."

2. **The two Clerk instances** — table or list:
   - Console (ZeroVault + ZeroErrors): one instance, primary domain
     `apps.juanibiapina.dev`, Frontend API `clerk.apps.juanibiapina.dev`, Account
     Portal `accounts.apps.juanibiapina.dev`. (Instance/app IDs and plan tier: "as
     recorded in `console-signin-redirect.md`, verify live.")
   - Agent (Zero assistant): a **separate** instance, domain
     `zero.juanibiapina.dev` / Frontend API `clerk.zero.juanibiapina.dev` (dev
     `talented-prawn-97.clerk.accounts.dev`). Untouched by console work; never
     merge the two. Cite precisely (N1): the **separate Clerk instance** fact
     comes from `unified-console-design.md`; `telegram-login.md` only proves the
     agent *domain* `zero.juanibiapina.dev`.

3. **The session-cookie constraint (the core lesson)** — Clerk scopes the session
   cookie to the Frontend API's primary domain **plus its subdomains only**.
   Subdomains of the primary share the session automatically (the mechanism the
   dashboard "Allowed subdomains" screen governs, and which only accepts
   subdomains **of the primary**). Sibling hosts (a different subdomain of the
   registrable parent, e.g. the old `vault.`/`errors.juanibiapina.dev` vs primary
   `apps.juanibiapina.dev`) **cannot** read the cookie, cannot hold a session, and
   every sign-in finalizes on the hosted Account Portal, stranding the user there.
   Cross-sibling / cross-registrable-domain sharing is what Clerk **satellite
   domains** are for, and those need the Pro plan. Source:
   `console-signin-redirect.md` (root cause + Options 1B/2).

4. **Why the console apps live on `*.apps.` subdomains** — Because of §3, each app
   is served on a subdomain of the primary: `vault.apps.juanibiapina.dev` and
   `errors.apps.juanibiapina.dev` (canonical web hosts). This is the **shipped**
   path — Option 1B in `console-signin-redirect.md`. State it clearly (N3):
   `console-signin-redirect.md` *recommends* Option 1A (re-home the primary to
   `juanibiapina.dev`), but that was **not** taken; 1B (`*.apps` subdomains)
   shipped. Do not imply a re-home to `juanibiapina.dev` is pending or planned —
   1A remains an un-taken recommendation only. The bare
   `vault.`/`errors.juanibiapina.dev` sibling hosts were dropped
   (`drop-old-console-hosts.md`). Note the still-attached `zerovault.` /
   `zeroerrors.` **API** hosts are unrelated to the session constraint (they serve
   the API for CLI / error-ingest consumers), so do not confuse them with the web
   hosts.

5. **The in-app `signInUrl`/`signUpUrl` requirement** — The shared `AuthProvider`
   (`packages/ui/src/auth/AuthProvider.tsx`) must set `signInUrl="/sign-in"` and
   `signUpUrl="/sign-up"` (relative) on `<ClerkProvider>` so `RedirectToSignIn`
   (in `packages/ui/src/components/AppLayout.tsx`) resolves per-origin and stays
   **in-app** instead of bouncing to the Account Portal. Relative paths resolve
   against each app's own host; a `signInUrl` set in code overrides the
   single-value dashboard Component path, so vault and errors each self-host their
   own sign-in. This is currently in place. Source: `console-signin-redirect.md`
   + the live file.

6. **Changing the Clerk frontend domain is a destructive cutover** — If anyone
   ever re-homes the console instance's primary/frontend domain (e.g. to
   `juanibiapina.dev`, the target `clerk-repoint.md` once proposed but which was
   **not** the host used — see §7 and C3): the change **re-issues the `pk_live`
   publishable key** (the key embeds the Frontend API domain), forcing an update
   of every location carrying the key (see the 12-row propagation table in
   `clerk-repoint.md` Part C), new DNS CNAMEs, and brief login downtime. It also
   requires updating the instance **`allowed_origins` / "Allowed subdomains"** —
   Clerk instance config managed in the **Dashboard** (`clerk-repoint.md:183`
   tags allowed origins **[Clerk Dashboard]**; `console-signin-redirect.md:22-24`
   describes "Allowed subdomains" as a Dashboard screen). Do **not** assert any of
   it is Backend-API-only or that it has no dashboard UI — the sources say the
   opposite.
   - **Google OAuth redirect URI (C1 — state as general Clerk behavior, do NOT
     cite a plan):** a custom Clerk Frontend API domain also changes the OAuth
     callback host registered with Google, so the Google OAuth redirect URI must
     be updated too. This is **general Clerk behavior, not recorded in any cited
     plan** (`console-signin-redirect.md` mentions Google only as a sign-in
     method; `clerk-repoint.md`'s propagation table has no Google-redirect-URI
     row). State it **unattributed** as general knowledge (or drop it if not
     confidently general); do **not** cite `console-signin-redirect.md` for it —
     that would be a false citation and break the doc's no-unsourced-claims rule.
     Add "verify against Clerk docs and the live Google/Clerk config before
     acting."
   - Mark the Dashboard-state items (allowed origins, "Allowed subdomains") as "as
     recorded; verify against the live instance before acting."

7. **Pointers** — link the four plans as the detailed sources:
   `console-signin-redirect.md` (live recon + options),
   `subdomain-rename.md` (the sibling-host era), `clerk-repoint.md` (destructive
   cutover mechanics; its proposed target `clerk.juanibiapina.dev` was superseded
   by the shipped `clerk.apps.juanibiapina.dev` — do not treat it as live),
   `drop-old-console-hosts.md` (dropping the sibling hosts).

## AGENTS.md edit

Add one reference so future work finds the doc. Per verify N2, the packages-list
bullet is an awkward host (it mixes an auth/architecture note into a package
list). Place it instead as a **standalone one-line note in the Architecture
prose**, immediately after the product/packages bullet list ends and before the
`All three products … auto-deploy on push to \`main\`` paragraph (`AGENTS.md:73`).
This keeps it near the ZeroVault/ZeroErrors description but reads as an
architecture note rather than a package description.

- Insert after the **Shared vault/errors packages** bullet (`AGENTS.md:71`) and
  before the `All three products … auto-deploy` paragraph, as its own paragraph:
  `The console (ZeroVault + ZeroErrors) shares one Clerk instance whose primary domain is \`apps.juanibiapina.dev\`; both web apps must be served on subdomains of it (\`vault.apps.\`, \`errors.apps.\`) to hold a session. The agent is a separate Clerk instance. See \`docs/console-auth.md\`.`

(If, at implementation time, the surrounding text has drifted, keep the same
placement — a standalone note in the Architecture prose near the
ZeroVault/ZeroErrors description — and the same pointer. The single hard
requirement is that `docs/console-auth.md` is referenced once from the
Architecture area, near the ZeroVault/ZeroErrors description.)

## docs/plans back-references

**Recommended (verify N4):** add a single one-line note at the top of
`docs/plans/clerk-repoint.md`. It is the single most misleading source — its body
still names the stale target host `clerk.juanibiapina.dev`, which never went live.
The line should read, precisely:

> Superseded target: the frontend-domain rename shipped to
> `clerk.apps.juanibiapina.dev`, **not** the `clerk.juanibiapina.dev` proposed
> below. See `docs/console-auth.md`.

Note the wording (C3): the rename **did ship** (to `clerk.apps.juanibiapina.dev`);
only this plan's specific target host was superseded. Do not write "never
implemented" or "the rename never happened." Do **not** otherwise rewrite the four
source plans — they are historical task records. The other three need no
back-reference.

## No changelog

Internal doc only. Per `AGENTS.md`, purely internal changes (docs for agents) get
no changelog entry, and this doc has **no user-visible product surface** — it is
not bundled into the agent's in-product Changelog (only `apps/agent-api/CHANGELOG.md`
is). Confirmed: the new file lives in `docs/` and changes no runtime behavior.

## Skills to use

- `changelog` — only to confirm the no-entry decision (internal doc). No edit
  expected.
- `git-commit` — committing the doc + the one-line AGENTS.md reference together.

## Acceptance criteria

- `docs/console-auth.md` exists and states, each sourced to a plan or repo file:
  the single shared console Clerk instance with primary domain
  `apps.juanibiapina.dev` (Frontend API `clerk.apps.juanibiapina.dev`); the
  cookie-scoped-to-primary-domain-plus-subdomains rule; why apps live on
  `vault.apps.`/`errors.apps.` and sibling hosts strand on the Account Portal; the
  separate agent instance on `zero.juanibiapina.dev`; the
  `signInUrl`/`signUpUrl`-in-`AuthProvider` requirement; and the destructive
  frontend-domain-change cutover (key reissue + allowed_origins/Allowed
  subdomains, plus Google OAuth redirect URI stated as general Clerk behavior per
  C1).
- Every live-Clerk-dashboard claim (instance IDs, plan tier, allowed origins,
  Paths) is marked "as recorded in `docs/plans/console-signin-redirect.md` (recon
  2026-07-22); verify against the live instance before acting," not asserted as a
  static in-repo fact. The `allowed_origins` / "Allowed subdomains" items are
  described as Clerk **Dashboard** config, **not** as Backend-API-only or "no
  dashboard UI" (C2).
- The Google OAuth redirect URI claim is stated as **general Clerk behavior,
  unattributed** (or dropped), and is **not** cited to
  `console-signin-redirect.md` or any other plan (C1) — no false citation.
- `clerk-repoint.md`'s **target** `clerk.juanibiapina.dev` is described as
  **superseded** (not the host used); the doc makes clear the frontend-domain
  rename **did ship**, and the live Frontend API is `clerk.apps.juanibiapina.dev`
  (not the old `clerk.zerovault…`). The doc does **not** say "no rename happened"
  (C3).
- `*.apps` (Option 1B) is described as the **shipped** path and Option 1A
  (re-home to `juanibiapina.dev`) as an **un-taken recommendation**, not pending
  work (N3).
- `AGENTS.md` references `docs/console-auth.md` once, as a standalone note in the
  Architecture prose near the ZeroVault/ZeroErrors description (N2).
- No code, no tests, no changelog entry. Repo diff is limited to the new doc, the
  AGENTS.md reference, and the recommended one-line superseded-target note atop
  `clerk-repoint.md` (N4).
- The doc contains no technical claim that could not be traced to
  `docs/plans/*` or a repo file; anything only knowable from the live Clerk
  dashboard is flagged as such.
