# Verify report: `docs/plans/console-auth-doc.md`

Adversarial review of the plan to add `docs/console-auth.md` (Clerk multi-app
session-domain constraint) plus an AGENTS.md reference. Pure doc change.

**Verdict: GO, with fixes.** 0 blockers, 3 concerns, 4 nits. The plan's core is
sound and unusually well-sourced: the domain-vs-Frontend-API distinction is
handled correctly, the `AuthProvider` claim matches live code, the separate-agent
claim is supported, the live-state caveat and no-changelog calls are right. The
concerns are all about a few claims the doc is told to state (and even to *cite*)
that its own cited sources do not support. Fix the wording before writing and the
doc is safe to ship.

Evidence base: read the plan and all cited sources
(`console-signin-redirect.md`, `subdomain-rename.md`, `clerk-repoint.md`,
`drop-old-console-hosts.md`, `unified-console-design.md`, `telegram-login.md`,
`packages/ui/src/auth/AuthProvider.tsx`, `packages/ui/src/products.ts`,
`packages/ui/src/components/AppLayout.tsx`, `AGENTS.md`, both `wrangler.jsonc`,
`docs/clerk-webhook.md`), plus `git log` and grep sweeps.

---

## Per-question findings

### 1. Are all technical claims accurate and verifiable? — mostly yes, three exceptions

Verified accurate:

- **Primary domain vs Frontend API host.** Plan's precision note is correct and
  well-guarded: primary domain `apps.juanibiapina.dev`, Frontend API
  `clerk.apps.juanibiapina.dev`, Account Portal `accounts.apps.juanibiapina.dev`,
  cookie scoped to `apps.juanibiapina.dev` + subdomains. Matches
  `console-signin-redirect.md:16-24,40-49`. This is the exact conflation the task
  worried about, and the plan defuses it explicitly. Good.
- **Canonical web hosts `vault.apps.` / `errors.apps.`.** Confirmed in
  `packages/ui/src/products.ts:14-15` (`PROD_VAULT_URL`, `PROD_ERRORS_URL`) and
  both wrangler `routes[]` (`apps/vault-api/wrangler.jsonc:74`,
  `apps/errors-api/wrangler.jsonc:61`).
- **`zerovault.` / `zeroerrors.` API hosts stay attached.** Confirmed still in
  `routes[]` (`apps/vault-api/wrangler.jsonc:70`, `apps/errors-api/wrangler.jsonc:57`),
  matching `drop-old-console-hosts.md`.
- **`pk_live` re-issue + 12-location propagation.** `clerk-repoint.md` "Goal"
  ("changing the frontend API domain re-issues `pk_live`") and its Part C 12-row
  table back this. Accurate.

The three exceptions are C1–C3 below.

### 2. Does the `AuthProvider.tsx` signInUrl/signUpUrl claim match current code? — YES

`packages/ui/src/auth/AuthProvider.tsx` renders
`<ClerkProvider publishableKey={…} signInUrl="/sign-in" signUpUrl="/sign-up" afterSignOutUrl="/sign-in">`.
The plan states exactly this and correctly notes it has landed. `RedirectToSignIn`
is in `packages/ui/src/components/AppLayout.tsx:199-201` as claimed. The "relative
paths resolve per-origin; code `signInUrl` overrides the dashboard Component path"
mechanism matches `console-signin-redirect.md:120-131`. Accurate.

### 3. Separate agent instance on `zero.juanibiapina.dev`? — supported

`unified-console-design.md:44-46` explicitly: agent is a "Separate Clerk instance
(`clerk.zero.juanibiapina.dev`), separate domain (`zero.juanibiapina.dev`)", dev
`talented-prawn-97.clerk.accounts.dev`. `telegram-login.md` confirms the agent
domain `zero.juanibiapina.dev`. `docs/clerk-webhook.md` uses
`zero.juanibiapina.dev` for the agent webhook. Well supported. (See N1 on citing
precisely: `telegram-login.md` proves the *domain*, only
`unified-console-design.md` proves the *separate Clerk instance*.)

### 4. Are live-dashboard-only facts flagged "verify against live"? — YES, strongly

The plan has an explicit "Live-state caveat" paragraph and an acceptance criterion
requiring every live-Clerk-dashboard claim (instance IDs, plan tier, allowed
origins, OAuth redirect URI, Paths) be marked "as recorded in
`console-signin-redirect.md` (recon 2026-07-22); verify against the live instance
before acting." This is exactly right. Caveat: two of those items are not actually
*in* `console-signin-redirect.md` — see C1.

### 5. AGENTS.md edit location correct and non-duplicative? — YES

- The target bullet exists verbatim at `AGENTS.md:71` ("Shared vault/errors
  packages: …`zerovault-cli`…"). The append is valid.
- No existing top-level auth doc to duplicate. `docs/` has `clerk-webhook.md`
  (agent Discord signup webhook — unrelated) and `telegram-login.md` (agent login
  widget). Neither touches the console session-domain constraint. The plan's
  "consolidates, does not duplicate" claim is correct.

### 6. Is "no changelog" correct? — YES

Root `CHANGELOG.md` is the console's user-facing log; `apps/agent-api/CHANGELOG.md`
is the only in-product surface. This doc is internal (docs-for-agents), changes no
runtime behavior, lives in `docs/`. Per `AGENTS.md`, purely internal changes get
no entry. Correct call.

### 7. Contradiction risk / pointer to superseded plan? — see C3 + N3 + N4

The doc reflects the *shipped* state (Option 1B, `*.apps` hosts). It does not
contradict `drop-old-console-hosts.md` or `products.ts`. But it risks propagating
`clerk-repoint.md`'s stale target and `console-signin-redirect.md`'s un-taken
recommendation if worded loosely (C3, N3), and a back-pointer on
`clerk-repoint.md` is worth more than the plan's "optional/low-value" framing (N4).

---

## Concerns

### C1 — The "Google OAuth redirect URI" claim is unsourced, and the plan tells the writer to cite it falsely

The plan states in the goal, §6, the live-state caveat, and the acceptance
criteria that changing the Clerk frontend domain "requires updating the Google
OAuth redirect URI," and instructs marking it "as recorded in
`console-signin-redirect.md` (recon 2026-07-22)."

Grep of all cited plans: `console-signin-redirect.md` mentions Google only as a
sign-in method and a round-trip acceptance test (lines 289-311); it does **not**
record any "Google OAuth redirect URI" that must change on a domain rename.
`clerk-repoint.md` mentions the "Google connection" (line 13) but its 12-row Part C
propagation table has no Google OAuth redirect URI row. So this fact is **not
traceable to any cited plan or repo file**, yet the plan's own acceptance
criterion says: "The doc contains no technical claim that could not be traced to
`docs/plans/*` or a repo file." Instructing the writer to attribute it to
`console-signin-redirect.md` would put a **false citation** in the doc.

The claim may well be true (a custom Clerk Frontend API domain changes the OAuth
callback host registered with Google), but it is *general Clerk behavior*, not
recorded repo state.

**Fix:** either drop the Google-OAuth-redirect-URI specific, or state it as
"general Clerk behavior (a custom Frontend API domain changes the OAuth callback
host); not recorded in the cited plans — verify against Clerk docs and the live
Google/Clerk config before acting." Do **not** cite `console-signin-redirect.md`
for it.

### C2 — "`allowed_origins` … Backend-API-only, no dashboard UI for some of it" contradicts the sources

The goal text (carried into §6) says the instance
"`allowed_origins` / 'Allowed subdomains' (Backend API, no dashboard UI for some
of it)." But every cited source treats allowed origins as **Dashboard** config:
`clerk-repoint.md:183` tags "Allowed redirect origins / allowed origins" as
**[Clerk Dashboard]**, and `console-signin-redirect.md:22-24` describes "Allowed
subdomains" as a Dashboard **screen** with a placeholder field. Nothing in the
sources says any of it is Backend-API-only with no UI.

**Fix:** drop the "Backend API, no dashboard UI" qualifier, or mark it as
unverified. As written it is unsourced and points the opposite way from the cited
recon.

### C3 — "clerk-repoint.md was never implemented / a rename that never happened" is imprecise; a frontend-domain rename DID ship

The plan repeatedly frames `clerk-repoint.md` as "superseded / never-implemented"
and, in the back-references section, as a plan that "describes a rename that never
happened." That overstates. What actually happened
(`console-signin-redirect.md:3`, "After the Clerk frontend-domain rename to
`clerk.apps.juanibiapina.dev`…", and :50-56): a frontend-domain rename **did
ship** — the Frontend API moved off `clerk.zerovault.juanibiapina.dev` to
`clerk.apps.juanibiapina.dev`, exercising exactly the destructive-cutover
mechanics `clerk-repoint.md` Part A describes. What was *not* implemented is only
`clerk-repoint.md`'s **specific target** (`clerk.juanibiapina.dev`, primary =
registrable parent). `console-signin-redirect.md:50-56` says this plainly: "The
implementation instead used `clerk.apps.juanibiapina.dev`."

Risk: a future reader who takes "the rename never happened" literally could
conclude the Frontend API is still `clerk.zerovault.juanibiapina.dev`. It is not.

**Fix:** in the doc, say precisely: "a frontend-domain rename shipped (Frontend API
is now `clerk.apps.juanibiapina.dev`); `clerk-repoint.md`'s target
`clerk.juanibiapina.dev` (primary = the registrable parent) was **not** the host
used — treat it as a stale/superseded target, not as live. The destructive-cutover
mechanics in `clerk-repoint.md` Part A/C are accurate and reusable." This preserves
the intended warning (don't treat `clerk.juanibiapina.dev` as live) without the
false "no rename happened" implication.

---

## Nits

### N1 — Cite the separate-instance claim precisely

`telegram-login.md` proves only the agent *domain* `zero.juanibiapina.dev`; the
*separate Clerk instance* fact comes from `unified-console-design.md:44-46` (and
implicitly `clerk-webhook.md`). When the doc says "separate Clerk instance," cite
`unified-console-design.md`, not `telegram-login.md`, for the instance part.

### N2 — AGENTS.md placement is acceptable but a slightly awkward host

Appending Clerk instance/session-domain architecture to the "Shared vault/errors
**packages**" bullet mixes an auth/architecture note into a package list. It is
near the vault/errors description and fine, but a reader scanning packages may not
expect it. Acceptable as planned; consider whether a short standalone note in the
Architecture prose reads better. Not blocking.

### N3 — Make clear `*.apps` is the *shipped* state, not `console-signin-redirect.md`'s recommendation

`console-signin-redirect.md` **recommends Option 1A** (re-home the primary to
`juanibiapina.dev`); the shipped path was **Option 1B** (`*.apps` subdomains). The
plan knows this ("Option 1B was the chosen fallback"), but when the doc cites
`console-signin-redirect.md` as the source for "why apps live on `*.apps`," it
should note 1B shipped and 1A remains an un-taken recommendation — otherwise a
reader may think a re-home to `juanibiapina.dev` is still pending/planned.

### N4 — A one-line back-pointer on `clerk-repoint.md` is worth more than "optional"

The plan calls the `clerk-repoint.md` superseded-note "optional, low-value." Given
C3, `clerk-repoint.md` is the single most misleading source (stale target host,
"(shipped)" commit subject on the doc-add commit `2791507` that adds to the
confusion). A one-line header — "Superseded target: the rename shipped to
`clerk.apps.juanibiapina.dev`, not the `clerk.juanibiapina.dev` below; see
`docs/console-auth.md`" — cheaply stops a future reader from trusting the wrong
host. Recommend doing it rather than skipping.

---

## What is already right (no action)

- Domain vs Frontend API host distinction — handled correctly and explicitly.
- `AuthProvider` `signInUrl`/`signUpUrl` claim — matches live code exactly.
- Separate agent instance — supported.
- Live-state caveat and acceptance criteria — strong (modulo C1's mis-attribution).
- No-changelog decision — correct.
- AGENTS.md target bullet — exists verbatim; non-duplicative; no existing
  top-level auth doc.
- Scope (one new doc + one AGENTS.md line, optional clerk-repoint note) — minimal
  and appropriate.
