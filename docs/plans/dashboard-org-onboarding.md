# Plan: fix new-user org onboarding blocker in the Zero dashboard

## Goal

A signed-in dashboard user who has **no active Clerk organization** must land on a
clear "create your organization" step, not an infinite `Loading...` spinner. Once
they create (or select) an org, the app must recover on its own. The existing
user (Juan), who already has an active org, must be unaffected. No dashboard page
should ever hang forever on a rejected API call; at minimum the pages on the fixed
path must show an error state instead of spinning.

Scope: `apps/dashboard-web` + `packages/ui` (shared `AppLayout`) + `apps/vault-api`
(only to confirm behavior; no server change is required for the chosen fix). The
repo-wide "every page hangs on rejected fetch" audit is a **separate queued task**;
this plan fixes the blocked onboarding path and does not swallow that scope.

## What actually happens (evidence)

Signing **in** works. What breaks is the state *after* sign-in when Clerk reports
no active organization. The dashboard's browser API middleware requires an active
org and returns `403` otherwise:

- `apps/vault-api/src/dashboard-app.ts:95` — `if (!auth?.userId) return c.json({ error: "Unauthorized" }, 401);`
- `apps/vault-api/src/dashboard-app.ts:96` — `if (!auth.orgId) return c.json({ error: "No active organization" }, 403);`

The client turns any non-OK response into a thrown `Error`:

- `packages/ui/src/lib/api.ts:32-36` — `if (!res.ok) { ... throw new Error(...) }`

The landing page loads data on mount with **no catch and no `finally`**, so a
throw skips `setLoading(false)` and the spinner never clears:

- `apps/dashboard-web/src/products/vault/pages/ProjectsPage.tsx:25-31`
  ```ts
  const load = useCallback(async () => {
    const { projects } = await api.listProjects(tokenFn); // throws on 403
    setProjects(projects);
    setLoading(false);                                    // never runs
  }, [tokenFn, organization?.id]);
  useEffect(() => { void load(); }, [load]);
  ```
  `loading` starts `true` (`:21`), so the UI is stuck at `Loading...` (`:64`).

The shared shell renders the authenticated app for any signed-in user regardless
of org state; it only guards signed-out users:

- `packages/ui/src/components/AppLayout.tsx:200-202` — `<SignedOut><RedirectToSignIn /></SignedOut>`.
  There is **no** "signed in but no org" branch. The top bar does render Clerk's
  `<OrganizationSwitcher>` (`AppLayout.tsx:154`), which *can* create/select an org,
  but the main content area is already stuck spinning and nothing directs the user
  there. This is the "I thought signing in worked!" gap: auth succeeded, the screen
  just spins.

### State table

| State | Clerk `auth.orgId` | What the user sees today | Cite |
|---|---|---|---|
| (a) Signed out | n/a | Redirected to `/sign-in` (works) | `AppLayout.tsx:200-202` |
| (b) Signed in, **active org** | set | App works; API returns `200` | `dashboard-app.ts:97-99`, `projects.ts` |
| (c) Signed in, **no org** | `null` | App shell renders; `/vault/projects` calls API → `403` → `fetchApi` throws → `setLoading(false)` skipped → **infinite `Loading...`** | `dashboard-app.ts:96`, `api.ts:32-36`, `ProjectsPage.tsx:25-31` |
| (d) Signed in, has org but **none active/selected** | `null` | Identical to (c): `orgId` is null, so `403`, same hang | `dashboard-app.ts:96`, same as (c) |

Net: (a) and (b) work; (c) and (d) both hang. The active-org requirement is a
single check (`auth.orgId`), so "belongs to an org" vs "org is active" collapse
into the same failure — anything that leaves `orgId` null hangs.

### Blast radius (same hang shape)

Every data page uses the same pattern: `loading` initialized `true`, an async
`load` that `await`s the API then calls `setLoading(false)` with **no catch/finally**.
On any rejected fetch each one hangs on `Loading...`:

1. `apps/dashboard-web/src/products/vault/pages/ProjectsPage.tsx` (`:21,:25-31`) — the fixed path
2. `apps/dashboard-web/src/products/vault/pages/KeysPage.tsx` (`:24,:28-31`)
3. `apps/dashboard-web/src/products/vault/pages/EnvironmentsPage.tsx` (`:24,:28-32`)
4. `apps/dashboard-web/src/products/vault/pages/SecretsPage.tsx` (`:26,:31-35`)
5. `apps/dashboard-web/src/products/errors/pages/IssuesPage.tsx` (`:24,:30-38`)
6. `apps/dashboard-web/src/products/errors/pages/IssueDetailPage.tsx` (`:21,:25-29`)

The org gate (below) prevents the org-less case for **all six** because it blocks
the `<Outlet>` before any page mounts. The generic "fail loudly on any rejected
fetch for reasons other than no-org" hardening across all six pages is the
separate queued audit; this plan only guarantees the ProjectsPage path (and the
shared `fetchApi` it uses) no longer hangs.

## Clerk org-creation permission finding (verified in the live dashboard)

Checked the **dashboard** Clerk instance (primary domain `zeroapps.dev`, confirmed
under Configure → Domains; app "Zero", `production`). Configure → Organization
settings current toggles:

- **Membership required** = ON (Standard: users must belong to at least one org).
- **Allow user-created organizations** = ON → a normal user *is permitted* to
  create an org, so rendering Clerk's `<CreateOrganization>` / the switcher's
  create flow will work for a first-run user (no admin-only restriction).
- **Create first organization automatically** = ON → Clerk creates the user's
  first org during sign-up using default naming rules (name derived from email
  domain, else from member name, e.g. "Juan's Organization"); the member does not
  see a naming form.
- Organization limit = Unlimited.

Implication: Clerk config *already* performs server-side first-org creation for
**new sign-ups** going forward — this is effectively candidate fix (B) done at the
platform layer, needing no webhook and no backend-API code. But it does **not**
backfill accounts that predate the setting, does not cover a user who leaves their
only org, and does not cover the transient window before the session's active org
resolves. In all those cases `orgId` is null and the app still hangs. So config
alone is not a complete fix; a client-side safety net is required.

## Chosen fix and justification

**Chosen: (A) a client-side first-run org gate in the shared `AppLayout`, plus loud
failure on the fixed page. Keep the Clerk "Create first organization automatically"
setting ON as the primary path. Do not add an app-level auto-create webhook.**

Why (A) over app-level (B):

- (B) at the application level (a `user.created` webhook or Clerk Backend API call
  that mints an org) **duplicates what Clerk already does** now that
  "Create first organization automatically" is ON. Running both risks double
  orgs, naming collisions with Clerk's own default naming, and a second source of
  truth for "does this user have an org?". The existing dashboard webhook
  (`apps/vault-api/src/routes/clerk-webhook.ts`) only posts a Discord signup notice
  and should stay that narrow.
- (B) still would not fix the **client hang** for org-less accounts that already
  exist, for a user who leaves their only org, or for the brief pre-active-org
  window. Those need a client branch regardless.
- (A) is the smallest change that closes every null-`orgId` case at once: it gates
  the app before any page mounts, works for pre-existing org-less users, is pure
  client code (fully reversible, no data migration, no new secret), and leverages
  the already-enabled "Allow user-created organizations" permission. Clerk's
  auto-creation means most new users never see the gate; the gate is the safety net.
- Fewest steps for the user: when the gate shows, the user creates/picks an org in
  place and the app recovers automatically (see recovery note), rather than being
  stuck.

ZeroErrors side: nothing extra. `AppLayout` is shared by both the `vault` and
`errors` route trees (`apps/dashboard-web/src/main.tsx`), and the errors API uses
the same `dashboard-app.ts` middleware and the same `403`. Gating in `AppLayout`
covers Errors pages (Issues, IssueDetail) automatically. No `ErrorsDO` or errors
route change is needed.

Recovery note: `ProjectsPage`'s `load` already depends on `organization?.id`
(`ProjectsPage.tsx:30`), so once the gate's create/select flow sets an active org,
the effect re-runs and the page loads without a manual refresh.

## Implementation steps (ordered)

1. **Org gate in `AppLayout`** (`packages/ui/src/components/AppLayout.tsx`):
   - Inside the existing `<SignedIn>` branch, read org state with Clerk's
     `useOrganization()` (`isLoaded`, `organization`). Import `CreateOrganization`
     from `@clerk/clerk-react`.
   - Branch:
     - while `!isLoaded` → render a minimal centered "Loading…" placeholder (do
       not render the data `<Outlet>` yet, to avoid the 403 race).
     - `isLoaded && !organization` → render a centered first-run panel containing
       `<CreateOrganization afterCreateOrganizationUrl={afterOrgUrl} />` with a
       short heading ("Create your organization to get started"). This is the gate;
       the `<Outlet>` and its data pages do not mount.
     - `isLoaded && organization` → render the normal shell + `<Outlet>` as today.
   - Keep the existing `<OrganizationSwitcher>` in the top bar for the org-selection
     (state d) case; the gate covers the no-org (state c) case. If the user has orgs
     but none active, `organization` is null and the gate shows `<CreateOrganization>`,
     which also exposes selecting/creating — acceptable, or optionally show the
     switcher-based picker. Prefer the simplest: `<CreateOrganization>` for null org.
   - `afterOrgUrl` already threads through `AppLayout` props (`main.tsx` passes
     `/vault/projects` and `/errors/issues`); reuse it so the user returns to the
     product landing page after creating the org.

2. **Fail loudly on the fixed path** (`apps/dashboard-web/src/products/vault/pages/ProjectsPage.tsx`):
   - Add an `error` state. Wrap `load` in `try/catch/finally`: on catch, set the
     error message; in `finally`, `setLoading(false)` so the spinner always clears.
   - Render an error block (message + a "Retry" button calling `load`) when `error`
     is set, instead of the perpetual `Loading...`.
   - This is defense in depth: with the gate, ProjectsPage should no longer see a
     403, but any other rejected fetch (network, 500, rate limit) now surfaces
     instead of hanging. Do **not** expand this to the other five pages here — that
     is the separate queued audit.

3. **Changelog** (`CHANGELOG.md`, root — this is a console change): add, most
   recent first:
   `- YYYY-MM-DD: New dashboard users are now guided to create an organization on first sign-in instead of seeing an endless loading screen, and the Projects page shows an error with a retry option if it can't load.`

## Tests

Current state: **`apps/dashboard-web` and `packages/ui` have no test tooling at
all** — no `test` script, no vitest, no `@testing-library/*`, no jsdom/happy-dom in
either `package.json`. `agent-web` has none either. Only worker/node packages
(`vault-api`, `agent-api`, `errors-core`, `agent-mobile`) run vitest. So there is no
existing React component-test convention to follow; the honest minimum is to stand
up a small one.

Smallest honest approach: add a component-test setup to **`apps/dashboard-web`**
only (it is a Vite React app, so a Vite-native vitest + jsdom config is natural, and
it can import `AppLayout` from `@zero/ui`). Avoid adding a second setup to
`packages/ui`.

- Add dev deps to `apps/dashboard-web`: `vitest`, `@testing-library/react`,
  `@testing-library/jest-dom`, `jsdom` (or `happy-dom`).
- Add `"test": "vitest run"` to `apps/dashboard-web/package.json` (turbo's `test`
  task already exists and `@zero/dashboard-api#test` depends on
  `@zero/dashboard-web#build`, so a real `test` script is picked up by CI).
- Add a `vitest.config.ts` with `environment: "jsdom"` and a setup file importing
  `@testing-library/jest-dom`.
- Mock `@clerk/clerk-react` so tests control org state: `SignedIn` renders children,
  `SignedOut` renders nothing, `useOrganization` returns a controllable
  `{ isLoaded, organization }`, and `CreateOrganization` renders an identifiable
  stub (e.g. `<div>create-organization</div>`). `useAuth` returns a stub `getToken`.

Required tests:

1. **No-org user sees the org prompt, not an infinite spinner** (AppLayout gate):
   render `AppLayout` inside a `MemoryRouter` with `useOrganization` →
   `{ isLoaded: true, organization: null }`. Assert the `CreateOrganization` stub is
   present and the data `<Outlet>` content is not. Add a companion assertion that
   with `{ isLoaded: true, organization: { id: "org_1" } }` the outlet renders and
   the create prompt does not.
2. **Rejecting fetch renders an error state** (ProjectsPage): render `ProjectsPage`
   with `api.listProjects` mocked to reject (e.g. `throw new Error("No active organization")`).
   Assert an error message renders and `Loading...` is gone (proves `finally` cleared
   loading and the catch surfaced the error). A second case with `listProjects`
   resolving to `{ projects: [] }` asserts the normal empty state ("No projects yet").

## Acceptance criteria (objectively checkable)

- [ ] `AppLayout` renders `<CreateOrganization>` (not the data outlet) when signed in
      with `isLoaded && !organization`; renders the outlet when an org is active.
- [ ] `ProjectsPage` clears `loading` on failure (via `finally`) and shows an error
      block with a working Retry; it never stays on `Loading...` after a rejected fetch.
- [ ] `apps/dashboard-web` has a `test` script; `pnpm --filter @zero/dashboard-web run test`
      passes and includes the two required tests above.
- [ ] `pnpm --filter @zero/dashboard-web run lint` and `run typecheck` pass; same for
      `@zero/ui`.
- [ ] Root `CHANGELOG.md` has a new dated, user-facing entry at the top.
- [ ] No change to `apps/vault-api` server code and no new Clerk webhook; the Clerk
      "Create first organization automatically" and "Allow user-created organizations"
      settings remain ON.

## Production verification (no second Google account, without disturbing Juan's account)

Juan's real account has an active org and must not be touched. Prove the real
no-org flow with a **throwaway user in the same production dashboard Clerk instance**,
not by stripping Juan's org:

- **Recommended (safest that still proves the real flow):** create a fresh test user
  in the dashboard Clerk instance (Clerk Dashboard → Users → Create user, using an
  email alias you control, e.g. a `+test` Gmail alias — this is a Clerk user, not a
  new Google account). Because "Create first organization automatically" is ON, first
  confirm whether Clerk gives the new user an org on creation. If it does, use the
  Clerk Dashboard to **remove that test user's org membership** so the user is in the
  genuine no-org state, then sign in as that user at `dash.zeroapps.dev` and verify:
  the gate shows `CreateOrganization`, creating an org lands on `/vault/projects`,
  and projects load. Delete the test user afterward. This touches only a disposable
  account.
- **Avoid:** removing Juan's own org membership to simulate the state — risky and
  disturbs the live account; do not do this.
- **Alternative if a Clerk dev instance exists:** run the same flow against a Clerk
  development instance to avoid any production user churn, but the production test
  user above is closer to the real path and is low risk when the account is disposable.

## Skills to use

- `code` — implementing the gate, the error state, and the test setup.
- `tdd` — write the two required tests first (red), then make them pass.
- `testing` — deciding what to mock (Clerk hooks/components) and keeping the seam clean.
- `reproducible-locally` — prove the no-org gate and error state before deploy.
- `changelog` — before editing `CHANGELOG.md`.
- `git-commit` — commit code + test + changelog together.
