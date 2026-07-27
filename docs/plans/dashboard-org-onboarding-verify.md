# Verify: dashboard-org-onboarding plan

Adversarial review of `docs/plans/dashboard-org-onboarding.md`. Date: 2026-07-27.
Method: read the cited source, confirmed Clerk config live in the dashboard
instance, and **proved the new-user path end to end** with a throwaway sign-up on
production `dash.zeroapps.dev`.

---

## Headline answer: does a brand-new user hit the hang?

**No.** A genuinely brand-new user who signs up through `dash.zeroapps.dev` does
**not** hit the infinite spinner. Clerk's "Create first organization
automatically" mints an org *during sign-up* and it is active in the very first
session token, so the dashboard's first API call returns `200` and the page
renders its normal empty state. Proven, not reasoned (evidence below).

The hang described in the plan is **real but narrow**: it only occurs for an
account whose `auth.orgId` is null *and stays null* — a genuinely org-less
account. On this instance that state is nearly unreachable for new users, and no
current production user is in it.

### Decisive evidence (end-to-end, production)

Created a throwaway user through the real sign-up flow (not the Dashboard "Create
user" shortcut, which bypasses the auto-org behavior):

- Signed up `juanibiapina+zeroorgtest@gmail.com` at `https://dash.zeroapps.dev/sign-up`,
  verified the emailed code.
- Result: landed directly on `/vault/projects` with an auto-created org
  **"OrgTest's Organization"** active in the top-right switcher, showing the
  working empty state **"No projects yet. Create one to get started."** — not
  `Loading...`. Screenshot: `/tmp/newuser-firstload.png`.
- Network capture on that first load: `GET /api/vault/projects` → **`200`** (no
  `403`, no throw). A subsequent hard reload was also `200`. No transient
  `Loading...` that stuck.
- Cleanup done: deleted the test org (`org_3H57rzU3jDzCrzGZVdOhb1GtDdG`) and the
  test user (`user_3H57rztaHmKyZCtg6P69Ld8bI3g`). Verified both gone from the
  Clerk Users/Organizations lists. **No residue, Juan's account untouched.**

### Clerk config, confirmed on the DASHBOARD instance (not agent)

Instance: app **"Zero" / Production**, primary domain **`zeroapps.dev`** (Configure
→ Domains: "Primary domain … zeroapps.dev Verified"). This is the dashboard
instance, confirmed before reading any toggle.

Organization settings, read as live switch states (`aria-checked`):

- **Create first organization automatically = ON** (`aria-checked: true`).
- Allow user-created organizations = ON.
- Detect org name/logo from email domain = ON; personalize from member name = ON
  (fallback naming, e.g. "Juan's Organization" / "OrgTest's Organization").
- Membership required (Standard) — users must belong to an org; there is **no
  personal-account fallback** (the switcher offered only *Manage* / *Create
  organization*, no "personal account").

Notes on the two sub-questions the task raised:

- **When was it enabled?** Clerk's settings UI does not surface a timestamp for
  this toggle, so it cannot be dated precisely. Circumstantial only: existing orgs
  were created 2026-07-06 (Juan, "Cragstronauts") and 2026-07-24 (Ömer, Kao). Not
  load-bearing for the verdict.
- **Applies at sign-up only?** Yes. Clerk's own description is "Creates an
  organization *during sign-up* … Members will not see the naming form." It does
  **not** backfill pre-existing accounts and does not re-mint one if a user later
  leaves their only org — exactly as the plan states.

### Transient-window hypothesis: disproven

The plan worried the first render could fire with `orgId` null before the session
resolves an active org, hanging permanently even though an org exists. Both lines
of evidence refute a *permanent* hang for new users:

1. Empirically, the first token already carried the org (`/api/vault/projects` was
   `200` on the very first call).
2. In code, `ProjectsPage`'s `load` depends on `organization?.id`
   (`ProjectsPage.tsx:29`); if the active org resolved late, `organization?.id`
   changes → `load` re-runs → `setProjects` + `setLoading(false)`. A late-arriving
   org self-heals. A *permanent* hang needs `org_id` to never arrive at all — i.e.
   a genuinely org-less account, not a timing race.

### Who can actually still hang?

Only an account with `orgId` null forever:

- Pre-existing accounts created before the setting, with no org — **none observed
  today**. Current production population is 4 real users
  (omrglen, kcfelix, daniel@amireh.org, juanibiapina) and 4 single-member orgs;
  every user appears to have exactly one org.
- A user who leaves their only org — hard here: membership required + no personal
  account; Clerk generally blocks leaving the last org.
- (The transient window is not a permanent-hang source; see above.)

**Corrected severity:** not "every new user hangs / a new user cannot self-serve."
It is a **defensive edge case** affecting only genuinely org-less accounts, a state
new users don't reach and no current user occupies. Downgrade from blocker to
low/medium hardening.

---

## Findings

### Blockers

**B1 — The plan's (and docs') severity framing is factually wrong; correct it
before building.** The plan's goal and state table imply the org-less hang is the
default new-user experience ("I thought signing in worked!"). Evidence shows new
sign-ups get an active org and a working page. Leaving the framing as-is would
justify the work at the wrong priority and ship a changelog claim that is untrue
(see C3). Fix: restate the problem as "harden the rare org-less state," and mark
state-table rows (c)/(d) as edge states Clerk's auto-create normally prevents.

### Concerns

**C1 — Test tooling is disproportionate; make it its own decision.** `dashboard-web`,
`agent-web`, and `packages/ui` have **zero** React component-test infrastructure
today (confirmed: no `test` script, no vitest/testing-library/jsdom in either
`package.json`). Standing up the repo's first component-test harness — runner
choice, jsdom vs happy-dom, where setup lives (app vs `ui`), CI wiring — to cover a
~20-line defensive change is scope creep and an infra decision in its own right.
The decisive verification already exists (the production e2e above). Recommendation:
**split the harness bootstrap into its own task**, or ship the fix verified by the
existing manual/production path; do not couple this fix's acceptance to a new
framework. If a test is wanted now, prefer one already-supported seam (e.g. a
plain unit test of the branch logic) over a new jsdom stack.

**C2 — Fix (A) is the right shape but the wrong priority, and it only half-covers
the blast radius.** The `AppLayout` org gate is cheap, reversible, pure-client
defense-in-depth for the org-less edge — reasonable to keep, but **not a blocker**.
The genuinely valuable, independent part is the `try/catch/finally` on
`ProjectsPage` (any `500`/network/`429` currently hangs it, unrelated to org
state). But the plan fixes only 1 of the 6 pages with that shape; after the gate,
the other five still hang on any non-org rejected fetch. That is defensible if
consciously deferred, but the plan should say plainly that five pages remain
hang-prone on generic errors, not imply the hang class is closed.

**C3 — Changelog wording would ship a false claim.** Routing is **correct** (root
`CHANGELOG.md` for shared console UI, per AGENTS.md — the change touches
`apps/dashboard-web` + `packages/ui`, no agent surface). But the proposed entry
("New dashboard users are now guided to create an organization on first sign-in
instead of seeing an endless loading screen") describes a problem new users don't
have. Reword to the real benefit, e.g. "Fixed a rare case where the dashboard
could get stuck loading if your account had no active organization, and the
Projects page now shows an error with retry instead of spinning." Only add a
changelog entry if the fix actually ships (edge-case hardening is user-observable,
so an entry is fine — just make it true).

### Nits

**N1 — State table is accurate but under-qualified.** All cited lines verified:
`dashboard-app.ts:95` (401) and `:96` (403); `api.ts:32` / `:36` (throw);
`ProjectsPage.tsx:21` (`useState(true)`), `:25-29` (`load` no catch/finally), `:66`
("Loading..."); `AppLayout.tsx:200-202` (`SignedOut`/`RedirectToSignIn`), `:152`
(`OrganizationSwitcher`). Add a note to rows (c)/(d) that "Create first
organization automatically = ON" makes these states unreachable for normal new
sign-ups.

**N2 — Blast-radius list is accurate; one wording clarification.** All six `load`
functions lack catch/finally on the load call. Verified line ranges match. Note
that `IssuesPage.tsx:51`'s `finally` is in `toggleStatus`, not `load`, so the
claim holds — worth a half-sentence so a reader doesn't think IssuesPage already
handles it.

**N3 — Acceptance criteria are mostly objectively checkable** (renders
`CreateOrganization` vs outlet by org state; `loading` clears on failure; changelog
present; lint/typecheck pass). The one coupling issue: the "`dashboard-web` has a
`test` script and the two tests pass" criterion bakes in the C1 infra decision.
Drop or relocate it if the harness is split out.

---

## Is the docs task actually blocked?

**No — it is unblocked, and one of its instructions is now wrong.**
`docs/plans/docs-content-getting-started.md` "BLOCKER 1" asserts "a brand-new
signup lands on `/vault/projects` with **no org** … every `/api/*` call 403s." That
premise is **false** on the live instance: new sign-ups get an active org and the
dashboard works (proven above). The docs plan itself already hedged this as "Not
required to ship docs." So:

- The docs work is **not** blocked by any product hang.
- `vault/getting-started.mdx` Step 2 ("**Create your organization** via the org
  switcher, before create-a-project") is **incorrect** for new users — an org
  already exists, auto-named "<Name>'s Organization". The step should instead tell
  users their workspace/org already exists and how to rename or switch it (top-right
  switcher), not that they must create one first.
- Recommendation: downgrade docs "BLOCKER 1" to a minor note, correct the Step-2
  wording to match reality, and unblock the docs task.

---

## Verdicts (summary)

- **Brand-new user hits the hang?** No. Proven end to end (200 on first load,
  auto-created active org, working empty state; screenshot + network capture).
- **Corrected severity:** edge-case hardening for genuinely org-less accounts, not
  a new-user blocker. No current user is in the broken state.
- **Fix (A):** right shape, wrong priority. Keep the `AppLayout` gate as
  low-priority defense-in-depth; the `try/catch/finally` on the data pages is the
  independently useful bit (and should not stop at one of six pages).
- **Test tooling:** disproportionate — split the first-ever component-test harness
  into its own task; don't gate this fix on it. Production e2e already proves it.
- **Changelog:** root file is the correct route; reword so the claim is true and
  only ship it with the fix.
- **Docs task:** not blocked. Unblock it and fix the now-incorrect "create your
  organization first" step.
