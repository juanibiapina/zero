# Verification: confirm dialog migration plan

## Overall verdict

**Revise before implementation.** The migration target, shared dialog contract, failure analysis, changelog route, and dashboard test baseline are sound. One blocker prevents the verification section from passing on this box. The reference-call-site description also conflates two different delete flows.

## Blocker

### 1. The dashboard build command fails without a Clerk build variable

The plan lists `pnpm --filter @zero/dashboard-web run build` as a direct verification command (`docs/plans/confirm-dialog-migration.md:264-274`) and requires it to pass (`docs/plans/confirm-dialog-migration.md:323`). The Vite config throws during any build that lacks `VITE_CLERK_PUBLISHABLE_KEY` (`apps/dashboard-web/vite.config.ts:7-10`).

Direct execution failed with:

```text
Error: VITE_CLERK_PUBLISHABLE_KEY is required to build the dashboard
```

The same command passed when run as:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_test pnpm --filter @zero/dashboard-web run build
```

This build does not start `workerd`. The missing variable, not the NixOS runtime limitation, is the problem. The verification command must supply a non-secret placeholder or load the configured value.

## Concerns

### 1. The two reference pages do not have the single shape claimed by the plan

The plan says both reference sites hold the entity being deleted and run request, `reload()`, then `toast.success(...)` (`docs/plans/confirm-dialog-migration.md:46-53`). That describes `IssuesPage`: it holds `IssueSummary | null` (`apps/dashboard-web/src/products/errors/pages/IssuesPage.tsx:29`) and deletes, reloads, then toasts (`apps/dashboard-web/src/products/errors/pages/IssuesPage.tsx:55-59`).

`IssueDetailPage` differs:

- It holds a boolean, not the entity (`apps/dashboard-web/src/products/errors/pages/IssueDetailPage.tsx:24`).
- After deletion it toasts and navigates to the list; it does not call `reload()` (`apps/dashboard-web/src/products/errors/pages/IssueDetailPage.tsx:40-43`).
- Its dialog passes `setConfirmingDelete` directly as `onOpenChange` (`apps/dashboard-web/src/products/errors/pages/IssueDetailPage.tsx:124-130`).

The planned list-page shape is still grounded in `IssuesPage`, but the reference section must distinguish list refresh from detail-page navigation. "Mirror these exactly" is false as written.

### 2. The EnvironmentsPage test recipe omits the required `Routes` wrapper

The plan says to put a `<Route path="/vault/projects/:project">` inside a `MemoryRouter` (`docs/plans/confirm-dialog-migration.md:249-252`). A `Route` cannot be rendered directly under `MemoryRouter`; it must be inside `<Routes>`. The existing route-backed page test shows the working harness (`apps/dashboard-web/src/test/IssueDetailPage.test.tsx:58-63`).

The tests are writable with that wrapper, but not if the recipe is followed literally.

## Nits

### 1. The expected post-change test count is 50, not merely 48

The verified baseline is 36 tests. Five Projects tests, five new Environments tests, and replacing one Keys test with five Keys tests add 14 net tests: 50 total. The plan records the same inputs but sets the acceptance floor to "at least 48" (`docs/plans/confirm-dialog-migration.md:323-325`). That floor would allow two planned tests to be absent even though the preceding acceptance criterion requires all five tests at all three sites (`docs/plans/confirm-dialog-migration.md:314-316`).

### 2. Repeating the pending lifecycle test at all three pages tests shared behavior three more times

The pending flag, disabled actions, Escape lock, double-submit guard, and close-on-resolution behavior belong to `ConfirmDialog` (`packages/ui/src/components/ConfirmDialog.tsx:54-93`). The existing IssuesPage test already exercises that contract through the real shared module (`apps/dashboard-web/src/test/IssuesPage.test.tsx:139-160`). Requiring the same pending test for every migrated page (`docs/plans/confirm-dialog-migration.md:225-242`) adds duplicate coverage rather than site-specific coverage.

The open/name, success, and failure tests are site-specific because they verify target state, arguments, copy, refresh, and toast wiring. Cancel is also a reasonable integration check. The repeated pending test is defensible as a safety check, but it is the least justified part of the 15-test expansion.

### 3. The acceptance shorthand is not an executable command

`pnpm --filter @zero/dashboard-web run test|lint|typecheck|build` (`docs/plans/confirm-dialog-migration.md:323`) is shell pipeline syntax, not shorthand a shell can execute as four package scripts. The verification section correctly lists separate commands (`docs/plans/confirm-dialog-migration.md:269-274`), subject to the build-variable blocker above.

## Verified claims

### Call sites and repository search

The three production call sites and stated line numbers are exact:

- `apps/dashboard-web/src/products/vault/pages/ProjectsPage.tsx:39`
- `apps/dashboard-web/src/products/vault/pages/EnvironmentsPage.tsx:46`
- `apps/dashboard-web/src/account/pages/KeysPage.tsx:67`

A source search across `apps` and `packages`, including `apps/agent-web` and `packages/ui`, found no fourth `confirm(` or `window.confirm(` production call. The only test stub is the known `vi.spyOn(window, "confirm")` in `apps/dashboard-web/src/test/KeysPage.test.tsx:173`. `apps/agent-web/src/pages/SettingsPage.tsx:259` contains the word "confirm" only in a comment.

### ConfirmDialog interface and async behavior

The actual interface matches the planned props: `open`, `onOpenChange`, string `title`, `ReactNode` `description`, `confirmLabel`, promise-returning `onConfirm`, and optional `onError` (`packages/ui/src/components/ConfirmDialog.tsx:34-43`). It is exported with its props from `@zero/ui` (`packages/ui/src/index.ts:14-18`).

The implementation:

- prevents Radix Action's default close and guards pending submission (`packages/ui/src/components/ConfirmDialog.tsx:61-65`);
- closes through `onOpenChange(false)` on resolution (`packages/ui/src/components/ConfirmDialog.tsx:66-70`);
- clears pending and calls `onError` on rejection without closing (`packages/ui/src/components/ConfirmDialog.tsx:70-74`);
- ignores close requests while pending (`packages/ui/src/components/ConfirmDialog.tsx:56-59`);
- disables Cancel and Confirm, shows `Working...`, and uses the destructive variant (`packages/ui/src/components/ConfirmDialog.tsx:86-93`).

The existing test proves normal Escape closes (`apps/dashboard-web/src/test/IssuesPage.test.tsx:116-126`) and pending Escape does not (`apps/dashboard-web/src/test/IssuesPage.test.tsx:139-160`).

### Refresh and toast behavior

The plan accurately describes `IssuesPage`: delete, call `reload()`, then toast success (`apps/dashboard-web/src/products/errors/pages/IssuesPage.tsx:55-59`). `useAsyncData.reload` returns `void` and only increments a nonce (`packages/ui/src/hooks/useAsyncData.ts:23,35`), so row removal must be awaited separately in tests. The existing success test uses two list responses and `waitFor` for row removal (`apps/dashboard-web/src/test/IssuesPage.test.tsx:164-185`).

`toast` is exported by `@zero/ui` (`packages/ui/src/index.ts:40`), the shell mounts its Toaster (`packages/ui/src/components/AppLayout.tsx:309`), and all three target route groups use `AppLayout` (`apps/dashboard-web/src/routes.tsx:36-58`). API failures become `Error` objects with server text or an HTTP fallback (`packages/ui/src/lib/api.ts:20,36`).

### Test harness and baseline

The test plan matches the real harness:

- Vitest uses jsdom, globals, the shared setup file, and `src/**/*.test.{ts,tsx}` (`apps/dashboard-web/vitest.config.ts:8-12`).
- Setup installs jest-dom and cleanup only (`apps/dashboard-web/src/test/setup.ts:1-6`).
- Existing page tests use stable Clerk references, mock the page's own API module, render in `MemoryRouter`, and use `fireEvent` plus `waitFor` (`apps/dashboard-web/src/test/IssuesPage.test.tsx:1-27,58-73`).
- The partial `@zero/ui` toast mock and local `deferred()` helper already work with the real `ConfirmDialog` (`apps/dashboard-web/src/test/IssuesPage.test.tsx:16-22,85-94`).
- Existing dashboard tests mock typed page API modules rather than global `fetch`, which matches the plan (`apps/dashboard-web/src/test/ProjectsPage.test.tsx:16-20`; `apps/dashboard-web/src/test/KeysPage.test.tsx:16-20`).
- `packages/ui` has lint and typecheck scripts but no test script (`packages/ui/package.json:10-13`).

The requested baseline run passed:

```text
Test Files  6 passed (6)
Tests       36 passed (36)
```

The proposed tests are writable after adding the missing `Routes` wrapper noted above.

### Current rejection handling

The failure-path claim is true. Each async delete/revoke function awaits an API promise without `try`/`catch` (`ProjectsPage.tsx:38-42`, `EnvironmentsPage.tsx:44-49`, `KeysPage.tsx:66-70`), and each click wrapper discards the returned promise with `void` (`ProjectsPage.tsx:94`, `EnvironmentsPage.tsx:102`, `KeysPage.tsx:181`). A rejection therefore has no page error state or toast and becomes an unhandled promise rejection. The user sees no failure feedback.

### Changelog and local verification

Root changelog routing is correct. `AGENTS.md:27-28` sends ZeroVault, ZeroErrors, and console changes to root `CHANGELOG.md`, whose heading identifies it as the console changelog (`CHANGELOG.md:1-3`).

Package-local test, lint, and typecheck commands all ran without `workerd`. Lint passed with the existing `SecretsPage.tsx:44` warning. Build also runs without `workerd`, but needs the variable described in blocker 1. This package-local approach follows the NixOS fallback in `AGENTS.md:9`.

### Scope assessment

Adding accessible names to the two icon-only triggers is adjacent to the migration and justified. The buttons currently have no text or `aria-label` (`ProjectsPage.tsx:90-96`, `EnvironmentsPage.tsx:98-104`), while Keys and Issues already name their destructive controls (`KeysPage.tsx:176-181`, `IssuesPage.tsx:154-161`). This is a small accessibility fix, not an unrelated redesign.

Creating `EnvironmentsPage.test.tsx` is also justified because that page has no test file and the migration changes a destructive path. The only questionable expansion is repeating the shared pending-lifecycle test at every page, noted above.

## Blocker list

1. The build verification command omits required `VITE_CLERK_PUBLISHABLE_KEY` configuration.

## Round 2 targeted re-verification

### Verdict

**Approved.** The updated plan closes the round 1 blocker, both concerns, and all three nits. The edits introduce no new contradiction in the checked sections.

### Blocker 1: closed

Both executable build commands now include `VITE_CLERK_PUBLISHABLE_KEY=pk_test`: the verification command at `docs/plans/confirm-dialog-migration.md:325` and the acceptance command at `docs/plans/confirm-dialog-migration.md:392`. The surrounding verification text correctly distinguishes the required Vite variable from the `workerd` limitation (`docs/plans/confirm-dialog-migration.md:328-336`). Running the exact command succeeded:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_test pnpm --filter @zero/dashboard-web run build
```

No unconfigured dashboard build command remains in the plan.

### Concern 1: closed

The reference section now describes the real split:

- `IssuesPage` holds `IssueSummary | null`, conditionally renders the dialog, and deletes, reloads, then toasts (`apps/dashboard-web/src/products/errors/pages/IssuesPage.tsx:29,56-59,174-193`).
- `IssueDetailPage` holds a boolean, passes its setter directly to `onOpenChange`, and deletes, toasts, then navigates without a delete-path reload (`apps/dashboard-web/src/products/errors/pages/IssueDetailPage.tsx:24,40-43,123-139`).

The plan consistently tells the three list pages to copy the `IssuesPage` shape and not the detail-page shape (`docs/plans/confirm-dialog-migration.md:52-68,190-196`).

### Concern 2: closed

The Environments test recipe nests `<Route>` inside `<Routes>` and then inside `<MemoryRouter>` (`docs/plans/confirm-dialog-migration.md:284-296`). This matches the working `IssueDetailPage.test.tsx` harness (`apps/dashboard-web/src/test/IssueDetailPage.test.tsx:58-63`).

### Nits 1, 2, and 3: closed

- Counts are consistent: baseline 36, 13 new tests, 1 removed test, net 12, total 48 across 7 files (`docs/plans/confirm-dialog-migration.md:17,241-260,277-309,377-396`).
- The four site-specific tests apply to each migrated page. The pending-lock test is planned only for `KeysPage` (`docs/plans/confirm-dialog-migration.md:241-270,303-304,377-379`).
- Verification and acceptance list four separate executable commands. No shell-pipeline shorthand remains (`docs/plans/confirm-dialog-migration.md:320-325,386-392`).

### New contradictions

None found in the targeted edits. The reference shape, test recipes, expected counts, verification commands, and acceptance criteria agree with each other.

### Round 2 blocker list

No blockers.
