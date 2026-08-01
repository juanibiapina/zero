# Plan: dashboard error states (fix infinite-spinner defect) + org gate

## Goal

No dashboard page should hang on `Loading...` forever when a data fetch rejects.
Today six pages in `apps/dashboard-web` share one shape: `loading` starts `true`,
an async `load` awaits the API then calls `setLoading(false)` with **no
catch/finally**, so any rejection skips `setLoading(false)` and the page spins
forever with no error text and no retry. This hits every failure mode: a `500`,
an expired session, offline network, or the `403` a rare org-less user gets.

Two changes:

1. **Fix the hang for all six pages via one seam**, not six copy-pasted
   try/catch blocks: a shared `useAsyncData` hook plus a shared `<AsyncState>`
   presentational wrapper in `packages/ui`. A rejected fetch now shows the error
   with a Retry button; a slow fetch shows the spinner; success renders the data.
2. **Fold in the org gate** from `docs/plans/dashboard-org-onboarding.md`:
   `AppLayout` renders Clerk's `<CreateOrganization>` when `isLoaded &&
   !organization`, closing the org-less `403` case for all six pages before they
   mount.

**Severity (corrected, do not water down or inflate).** Per
`docs/plans/dashboard-org-onboarding-verify.md`, the org-less state is **edge-case
hardening**, not a new-user onboarding fix: Clerk's "Create first organization
automatically" is ON, so brand-new sign-ups get an active org and a working page
(proven end to end in production). No current user is in the org-less state. The
org gate is low-priority defense-in-depth. The independently valuable, higher-value
work is the generic error handling: any `500`/network/`429`/expired-session
rejection currently hangs any of the six pages regardless of org state, and this
plan closes that class across **all six** (the earlier plan fixed only one).

Scope: `apps/dashboard-web` + `packages/ui`. No `apps/vault-api` server change.
Keep the Clerk auto-org and user-created-org settings ON.

## Per-page findings (how each loads data, where the error is dropped)

Every page uses the same anti-pattern: `useState(true)` for `loading`, a
`useCallback` `load` that `await`s `api.*` then `setLoading(false)`, and a
`useEffect(() => void load(), [load])`. None wrap the load call in
`try/catch/finally`, so a throw from `fetchApi` (`packages/ui/src/lib/api.ts:32-36`,
which turns any non-OK response into `throw new Error(...)`) never reaches
`setLoading(false)` and never surfaces a message. The differences that matter for
the seam are the last three columns.

| Page | File | `loading=true` | `load` (drops error here) | `Loading...` render | Reload triggers | Depends on | Extra state / quirks |
|---|---|---|---|---|---|---|---|
| ProjectsPage | `apps/dashboard-web/src/products/vault/pages/ProjectsPage.tsx` | `:21` | `:25-28` (`await api.listProjects`, no catch/finally) | `:66` inline | create `:36`, delete `:43` call `void load()` | mount + `organization?.id` (`:30`) | always-visible create form |
| KeysPage | `apps/dashboard-web/src/products/vault/pages/KeysPage.tsx` | `:24` | `:28-31` (`await api.listApiKeys`) | `:98` inline | create `:38`, revoke `:53` | mount + `organization?.id` (`:32`) | always-visible create form + one-time new-key banner |
| EnvironmentsPage | `apps/dashboard-web/src/products/vault/pages/EnvironmentsPage.tsx` | `:24` | `:28-32` (`await api.listEnvironments`), `if (!project) return` guard `:29` | `:76` inline | create `:40`, delete `:48` | route param `project` (`:19`) + `organization?.id` (`:32`) | no empty-state text (renders empty table) |
| SecretsPage | `apps/dashboard-web/src/products/vault/pages/SecretsPage.tsx` | `:26` | `:31-35` (`await api.getSecrets`), `if (!project||!env) return` guard `:32` | `:118` inline | none: Save (`:67`) does **not** reload, sets `dirty=false` | route params `project`,`env` (`:19`) + `organization?.id` (`:36`) | fetched secrets are **copied into editable local state** and sorted; `dirty` flag; reveal set |
| IssuesPage | `apps/dashboard-web/src/products/errors/pages/IssuesPage.tsx` | `:25` | `:30-38` (`setLoading(true)` `:31`, `await api.listIssues`) | `:82` inline | filter change re-runs load; `toggleStatus` (`:45-53`) reloads with its **own** `try/finally` for `pendingId` (not the load) | mount + filter state `project`,`showResolved` + `organization?.id` (`:39`) | re-fetches on filter change (sets loading true each time) |
| IssueDetailPage | `apps/dashboard-web/src/products/errors/pages/IssueDetailPage.tsx` | `:21` | `:25-29` (`setLoading(true)` `:26`, `await api.getIssue`) | `:43` **full-page early return** | `toggleStatus` (`:37-40`) reloads | route param `id` (`:17`) + `organization?.id` (`:30`) | separate `!data` "Issue not found" branch `:44` |

Shared fetch helper (single source of the throw):
`packages/ui/src/lib/api.ts` `fetchApi<T>` (exported from `@zero/ui`) throws on
`!res.ok` (`:32-36`) and on missing token (`:20-22`). Product endpoint modules
(`apps/dashboard-web/src/products/vault/lib/api.ts`,
`.../errors/lib/api.ts`) are thin typed wrappers over `fetchApi`; they add no
error handling and are not where the drop happens.

Server origin of the org-less `403`: `apps/vault-api/src/dashboard-app.ts:95-96`
(`401` no user, `403` no active org). Shared by both vault and errors APIs.

Existing UI inventory (checked, so we do not reinvent): `packages/ui` exports only
`Button, Card*, Input, Label, Toaster (sonner), Table*` plus `fetchApi`, `cn`,
`AppLayout`, auth pages. There is **no** error-state, empty-state, spinner,
retry, or boundary component today (`rg` for
`retry|ErrorState|EmptyState|AsyncData|AsyncBoundary|ErrorBoundary|Spinner`
returns nothing). Empty states are ad-hoc `<p className="text-muted-foreground">`.
Loading is the literal string `Loading...`.

## Chosen seam: `useAsyncData` hook + `<AsyncState>` wrapper (both in `packages/ui`)

One conceptual seam, "an async data region", implemented as two cooperating deep
modules:

- **`useAsyncData<T>(fetcher, deps)` → `{ data, loading, error, reload }`** owns
  the entire async lifecycle: run the fetcher on mount and whenever `deps` change,
  set `loading` true before each run, `try/catch/finally` so `loading` always
  clears, store the thrown `Error`, ignore stale/out-of-order responses (a
  `cancelled` guard in the effect so fast filter changes or unmount cannot land an
  old result), and expose a stable `reload` that re-runs the current fetcher.
- **`<AsyncState state={...} onRetry={...}>{(data) => ...}</AsyncState>`** owns the
  loading/error/retry chrome: renders `Loading...` while `loading`, an error block
  (message + Retry button that calls `onRetry`) when `error` is set, and otherwise
  calls the render-prop child with non-null `data`. The child renders only the
  happy path and its own page-specific empty state.

### Why the hook (not a pure boundary, not React error boundaries)

- **React error boundaries: rejected.** Error boundaries catch throws during
  render/lifecycle, not rejections inside an async `useEffect`. Every one of these
  loads rejects inside an effect, so a boundary would catch nothing without
  re-throwing stored errors during render (a Suspense-style rewrite). Boundaries
  also give no natural `retry` and cannot express param-driven or
  mutation-triggered reload. Wrong tool for async effects.
- **Pure `<AsyncBoundary>` component that owns the fetch: rejected as the primary
  seam.** It would have to own `load` and expose data + reload via render prop.
  Two page shapes break this: (1) **SecretsPage** copies fetched data into
  *editable* local state (`dirty`, per-key reveal, sorted edits) and its Save does
  not reload; a boundary that only hands data through a render prop cannot seed a
  child `useState` without an extra prop-to-state sync effect, so it adds
  complexity. (2) Every page keeps an **always-visible create form / filter strip**
  outside the loaded region and calls `reload()` after mutations; a boundary owning
  the fetch forces those into the render-prop closure and hides the reload handle.
  The data flow gets less explicit, not more.
- **`useAsyncData` hook: chosen.** It hands back `data` + a stable `reload`, so the
  page keeps explicit control of its own layout, local state, and mutation reloads,
  while the error-prone lifecycle (effect + try/catch/finally + stale-guard) lives
  in **one** place. This is category-1 (in-process) depth per the deep-modules
  skill: the fetcher is injected, the hook does no I/O of its own, and one correct
  implementation pays back across six pages and their tests (leverage + locality).
  The `<AsyncState>` wrapper dedupes only the loading/error/retry chrome, which is
  identical everywhere; page-specific empty states stay in the child.

### Deletion test

Delete `useAsyncData` and the try/catch/finally/stale-guard reappears six times
(and was simply absent today, which is the bug). Delete `<AsyncState>` and the
`loading ? ... : error ? ... : data` ladder plus the retry button reappear six
times. Both concentrate real complexity, so both earn their keep.

### How each page gets simpler (net-negative page bodies)

Each page deletes: the list `useState`, the `loading` `useState`, the `load`
`useCallback`, and the `useEffect`. Each page adds: one `useAsyncData` call and one
`<AsyncState>` wrapper around its list region. Mutations change `void load()` to
`reload()` (from the hook). Concretely:

- **ProjectsPage / KeysPage:** `useAsyncData(() => api.listProjects(tokenFn),
  [tokenFn, organization?.id])`; render form (unchanged) + `<AsyncState>` whose
  child does the `length === 0 ? <empty> : <list>`. Mutations call `reload`.
- **EnvironmentsPage:** deps `[tokenFn, project, organization?.id]`; the missing-
  `project` guard moves into the fetcher (return an empty result). Gains a real
  error state where it had none.
- **SecretsPage:** `useAsyncData(() => api.getSecrets(tokenFn, project, env),
  [tokenFn, project, env, organization?.id])`; keep the editable `secrets` local
  state but seed it from the hook via `useEffect(() => { if (data)
  setSecrets(sortCopy(data.secrets)); setDirty(false); }, [data])`. Save stays
  local (no reload). The hook still removes its loading/error boilerplate.
- **IssuesPage:** deps `[tokenFn, project, showResolved, organization?.id]`; the
  hook’s per-run `setLoading(true)` reproduces today’s "spinner on every filter
  change". `toggleStatus` keeps its own `pendingId` try/finally and calls `reload`.
- **IssueDetailPage:** wrap the whole render in `<AsyncState>` (it already
  full-page early-returns). A 404 for a bad id now becomes the error state instead
  of the perpetual spinner; the old `!data` "Issue not found" collapses into the
  error message from `fetchApi`.

### Placement and exports

`useAsyncData` and `AsyncState` live in `packages/ui/src` (both product trees use
them) and are exported from `packages/ui/src/index.ts` alongside `fetchApi`.
`AsyncState` uses the existing `Button` for Retry and the existing muted-text style
for loading, so it stays inside the design system.

## Org gate in `AppLayout`

In `packages/ui/src/components/AppLayout.tsx`, inside the existing `<SignedIn>`
branch (which today unconditionally renders the shell + `<Outlet>`), read
`useOrganization()` (`isLoaded`, `organization`) and import `CreateOrganization`
from `@clerk/clerk-react`. Branch:

- `!isLoaded` → centered minimal `Loading…` placeholder (do **not** mount the
  `<Outlet>` yet, to avoid the org-less `403` race).
- `isLoaded && !organization` → centered first-run panel with a short heading
  ("Create your organization to get started") and `<CreateOrganization
  afterCreateOrganizationUrl={afterOrgUrl} />`. The `<Outlet>` and its data pages
  do not mount, so none of the six pages can fire the `403`.
- `isLoaded && organization` → the current shell + `<Outlet>`, unchanged.

`afterOrgUrl` is already an `AppLayout` prop (`main.tsx` passes `/vault/projects`
and `/errors/issues`); reuse it so the user returns to the product landing page
after creating the org. Keep the existing top-bar `<OrganizationSwitcher>` for the
has-orgs-but-none-active case. `AppLayout` is shared by both route trees, so this
single gate covers all six pages at once. ~20 lines. This is the low-priority
defense-in-depth layer; the `useAsyncData`/`AsyncState` seam is the layer that
matters for the general failure class.

## Error presentation (what the user sees)

Today: perpetual `Loading...`, no message, no recovery. After the fix, a failed
load renders (via `<AsyncState>`):

- a short line stating the load failed, showing the thrown `Error.message` (which
  `fetchApi` sets to the server `error` string, e.g. "No active organization", or
  `HTTP <status>`, or "Not authenticated"), and
- a **Retry** button (existing `Button`) that calls the hook’s `reload`.

Loading keeps the current muted `Loading...` text so the visual language is
unchanged. This is the one shared error state; it lives in `packages/ui` where the
design system lives, and it is new (nothing existing to reuse, verified above).
Page-specific **empty** states ("No projects yet", "No API keys yet", "No issues
yet", etc.) stay in each page’s render-prop child, unchanged.

## Test-tooling decision: YES, stand up a minimal harness in `dashboard-web`

`apps/dashboard-web`, `apps/agent-web`, and `packages/ui` have **zero** React
component-test infrastructure today (no `test` script, no vitest, no
testing-library, no jsdom in any `package.json`; confirmed). The org-onboarding
verify doc argued (C1/N3) not to gate a ~20-line defensive change on standing up
the repo’s first component-test harness, and to keep the manual/production e2e as
proof.

That reasoning held when the change was a 20-line gate. **It does not hold now**:
this plan introduces `useAsyncData`, a reusable in-process module wired into all
six pages, whose entire job is the branch logic the bug was missing
(loading→data, loading→error, reload, stale-response cancellation). If the hook is
wrong, all six pages regress at once. That is exactly the high-leverage,
one-place-to-test shape (deep-modules category 1) that earns a real test. So the
harness now pays for itself and I stand it up, kept deliberately small so it is not
a framework detour with one trivial test.

Setup (reuse what exists; add nothing to `packages/ui`):

- Add devDeps to `apps/dashboard-web` only: `vitest`, `@testing-library/react`,
  `@testing-library/jest-dom`, `jsdom`. `dashboard-web` already has
  `@vitejs/plugin-react`, so vitest reuses the Vite/React setup.
- Add `vitest.config.ts` (`environment: "jsdom"`, react plugin, a setup file
  importing `@testing-library/jest-dom`) and `"test": "vitest run"` to
  `apps/dashboard-web/package.json` so Turbo’s existing `test` task picks it up.
- Tests import `useAsyncData` and `AsyncState` from `@zero/ui` (its interface),
  and pages from `dashboard-web`.

Tests to write (two focused files, at the interfaces, not one trivial test):

1. **`useAsyncData` (the seam, highest leverage):**
   - rejecting fetcher → after settle, `loading` is `false` and `error` is set
     (the core bug: loading must clear on failure).
   - resolving fetcher → `loading` false, `data` set, `error` null.
   - `reload()` re-runs the fetcher (spy call count increases; a fetcher that
     rejects then resolves yields data after `reload`).
   - stale guard: when `deps` change before the first fetcher settles, the late
     result is ignored (the newer result wins).
2. **One page end-to-end (`ProjectsPage`):** mock `api.listProjects` to reject →
   assert the error message renders, a Retry control is present, and `Loading...`
   is gone (proves the seam is wired). Then point the mock at a resolving value and
   click Retry → assert the list/empty state renders. Mock `@clerk/clerk-react`
   (`useAuth`, `useOrganization`) so the page renders outside Clerk.

Production e2e (below) remains the ultimate proof against the deployed app; the
unit/component tests protect the shared hook from regressing on future edits.

## Ordered steps

1. **`packages/ui`: add the seam.** Create `useAsyncData` and `AsyncState`, export
   both from `src/index.ts`. Include the try/catch/finally, the loading reset, and
   the stale/unmount cancellation guard in the hook.
2. **`packages/ui`: org gate in `AppLayout`.** Add the `useOrganization` +
   `CreateOrganization` branch inside `<SignedIn>` as described.
3. **`dashboard-web`: convert the six pages** to `useAsyncData` + `<AsyncState>`,
   deleting each page’s `loading`/list `useState`, `load` `useCallback`, and
   `useEffect`; swap mutation `void load()` for `reload`; keep SecretsPage’s
   editable local state seeded from the hook’s `data`; keep IssuesPage’s
   `pendingId` try/finally; keep each page’s empty-state text in the child.
4. **`dashboard-web`: stand up the test harness** (vitest + jsdom +
   testing-library devDeps, `vitest.config.ts`, setup file, `test` script) and
   write the two test files above.
5. **Changelog** (`CHANGELOG.md`, root — this is a console change, per AGENTS.md).
   Add at the top, dated, user-facing and **true** (per verify C3):
   `- YYYY-MM-DD: Dashboard pages that fail to load now show an error with a Retry button instead of spinning forever, and a rare account with no active organization is prompted to create one instead of getting stuck.`
6. **Verify:** `pnpm --filter @zero/dashboard-web run test`, `run lint`, `run
   typecheck`; `pnpm --filter @zero/ui run lint` and `run typecheck`. Then the
   production check below.

## Production verification (no manual step, against the deployed app)

Signed in as an existing user with an active org (avoids the gate), force a **safe,
read-only** failure and confirm error+retry instead of a spinner. Two methods,
either proves it; run via the `browse` skill so it is scripted, not manual:

- **Primary (generic failure, deterministic): block the API in the browser.** Open
  `https://dash.zeroapps.dev/vault/projects`, use the browse skill’s network
  controls to make every `**/api/**` request fail (abort or force `500`), reload,
  and assert the DOM shows the error message + a **Retry** button and no stuck
  `Loading...`. This proves the fix for the whole failure class (`500`, offline,
  expired session), not just `403`. Un-block, click Retry, assert the list renders.
- **Fallback (no tooling, real 404): a nonexistent issue id.** Navigate to
  `https://dash.zeroapps.dev/errors/issues/does-not-exist-xyz`. `GET
  /api/errors/issues/does-not-exist-xyz` returns non-`200`, so `fetchApi` throws.
  Assert IssueDetailPage renders the error state + Retry, not the perpetual
  `Loading...`. Read-only GET, no mutation, does not touch real data.

Org-gate check (optional, disposable account, from the earlier plan): create a
throwaway Clerk user, remove its org membership so `orgId` is null, sign in, and
confirm the `<CreateOrganization>` gate shows (not a spinner); creating an org
lands on `/vault/projects`. Delete the test user after. Do **not** strip Juan’s
org.

## Acceptance criteria (objectively checkable)

- [ ] `packages/ui` exports `useAsyncData` and `AsyncState`; every one of the six
      pages imports them and no longer contains its own `loading` `useState` +
      `load` `useCallback` + load `useEffect`.
- [ ] On a rejected fetch, each of the six pages clears loading and shows an error
      message plus a working Retry; none can stay on `Loading...` after a rejection
      (proven for `useAsyncData` by unit test and for a page by the component test).
- [ ] `AppLayout` renders `<CreateOrganization>` (not the `<Outlet>`) when signed in
      with `isLoaded && !organization`, renders a `Loading…` placeholder while
      `!isLoaded`, and renders the outlet when an org is active.
- [ ] `apps/dashboard-web` has a `test` script; `pnpm --filter @zero/dashboard-web
      run test` passes and includes the `useAsyncData` tests and the ProjectsPage
      error+retry test.
- [ ] `pnpm --filter @zero/dashboard-web run lint`, `run typecheck`, and the same
      for `@zero/ui`, all pass.
- [ ] Root `CHANGELOG.md` has a new dated, user-facing, truthful entry at the top.
- [ ] No change to `apps/vault-api` server code; no new Clerk webhook; Clerk
      auto-org and user-created-org settings remain ON.
- [ ] Production check: with `**/api/**` forced to fail on `/vault/projects` (or a
      bogus issue id at `/errors/issues/*`), the deployed app shows error + Retry,
      not a stuck spinner.

## Skills to use

- `deep-modules` — designing `useAsyncData`/`AsyncState` as the seam and keeping
  page bodies net-simpler.
- `code` — implementing the hook, wrapper, gate, and page conversions.
- `tdd` — write the `useAsyncData` and ProjectsPage tests red first, then convert.
- `testing` — deciding what to mock (Clerk hooks, the product `api.*` modules) and
  testing at the hook’s interface, not its internals.
- `reproducible-locally` — the production error-state verification with no manual
  step.
- `changelog` — before editing root `CHANGELOG.md`.
- `git-commit` — commit code + tests + changelog together.
