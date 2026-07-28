# Plan: one confirmation style in the console

## Goal

Replace the three remaining bare `confirm()` calls in the dashboard console with
the shared `ConfirmDialog` from `@zero/ui`, so every destructive action in the
console asks the same way: an in-app alert dialog that names what is being
removed, states the consequence, keeps itself open while the request is in
flight, and reports failure instead of dropping it. This closes the deferred
scope recorded in `docs/plans/errors-delete.md` (decision 5), which knowingly
left the console with two confirmation styles.

## Repo state this plan was written against

`main` at `2723407` ("docs(plans): record ZeroErrors delete verification"),
after `git fetch` (checkout is level with `origin/main`). Baseline for
`apps/dashboard-web`: **6 test files, 36 tests, green** on this box.

This plan has been through a verification pass
(`docs/plans/confirm-dialog-migration-verify.md`); its blocker, concerns, and
nits are already folded in below, so read this file, not that one.

## Verified by reading the code

- **The three sites exist and call the unqualified global `confirm(...)`:**
  - `apps/dashboard-web/src/products/vault/pages/ProjectsPage.tsx:39` -
    `handleDelete(name)`: `confirm(...)`, then `api.deleteProject`, then
    `reload()`.
  - `apps/dashboard-web/src/products/vault/pages/EnvironmentsPage.tsx:46` -
    `handleDelete(envName)`: guards on `!project`, `confirm(...)`, then
    `api.deleteEnvironment`, then `reload()`.
  - `apps/dashboard-web/src/account/pages/KeysPage.tsx:67` -
    `handleRevoke(id)`: `confirm(...)`, then `api.revokeApiKey`, then
    `reload()`. (KeysPage did move to `src/account/pages/`.)

  All three are invoked as `onClick={() => void handleX(...)}`, so a rejected
  request today is an unhandled rejection: **no site shows the user any failure
  at all**, and none shows success either.
- **`ConfirmDialog`** lives at `packages/ui/src/components/ConfirmDialog.tsx`
  and is exported from `@zero/ui` (with `ConfirmDialogProps`). Interface:
  `open`, `onOpenChange(open)`, `title`, `description: ReactNode`,
  `confirmLabel`, `onConfirm: () => Promise<void>`, `onError?(error)`.
  Contract it already owns, so no call site re-implements it: it
  `preventDefault`s the Radix Action click, holds its own `pending` flag,
  disables **both** Confirm and Cancel while pending, shows `Working...` on the
  Confirm button, ignores close requests (Escape, outside interaction) while
  pending, cannot double submit, calls `onOpenChange(false)` on resolve, and on
  reject stays open, clears pending, and calls `onError` once. Cancel's label is
  the literal `Cancel`; the Confirm button uses `variant="destructive"`.
- **Reference call sites are two different shapes, not one.** Both live in
  `apps/dashboard-web/src/products/errors/pages/`:
  - **`IssuesPage.tsx` (list) - this is the shape all three migrated pages
    copy.** State holds the **entity being deleted**
    (`useState<IssueSummary | null>`, line 29). The dialog is rendered as
    `{deleting && <ConfirmDialog open onOpenChange={(open) => { if (!open) setDeleting(null); }} ... />}`,
    so unmounting resets its internal pending state. `onConfirm` does request ->
    `reload()` -> `toast.success(...)` (lines 55-59). `onError` does
    `toast.error(error instanceof Error ? error.message : "<fallback>")`.
  - **`IssueDetailPage.tsx` (detail) - do not copy this one.** State is a plain
    boolean (`useState(false)`, line 24), `onOpenChange` is `setConfirmingDelete`
    passed directly (lines 124-130), and `onConfirm` deletes, toasts, then
    **navigates** back to the list instead of calling `reload()` (lines 40-43),
    because the deleted entity is the page itself.

  `ProjectsPage`, `EnvironmentsPage`, and `KeysPage` are all list pages that
  stay mounted after the delete and must refresh in place, so all three mirror
  the **`IssuesPage`** shape: entity-in-state, conditional render,
  request -> `reload()` -> success toast. Nothing in this change navigates.
- **`toast` is re-exported from `@zero/ui`** (`export { toast } from "sonner"`),
  and `<Toaster position="bottom-right" />` is mounted in `AppLayout`
  (`packages/ui/src/components/AppLayout.tsx:309`). `routes.tsx` wraps the
  vault, errors, **and** account (`/keys`) route groups in `AppLayout`, so all
  three migrated sites render inside a live Toaster in production.
- **Errors surface through `Error.message`.** `fetchApi` (`packages/ui/src/lib/api.ts`)
  throws `new Error(body.error || \`HTTP ${status}\`)`, so `error.message` is the
  server's message ("Project not found", "Not authenticated", ...).
- **`reload()` is fire-and-forget**: `useAsyncData`'s `reload` only bumps a
  nonce and returns `void`. So `onConfirm` resolves (and the dialog closes) as
  soon as the DELETE succeeded, not once the refreshed list has landed. The row
  disappears a moment later. Tests must assert the row's absence under
  `waitFor`. Do not widen `useAsyncData`'s interface.
- **Accessible names.** `KeysPage`'s row button already has
  `aria-label={\`Revoke key ${k.prefix}${k.suffix}\`}`. `ProjectsPage` and
  `EnvironmentsPage` row buttons are **icon-only with no accessible name at
  all**, so they cannot be targeted by role+name and are unusable with a screen
  reader. This change adds names, following the `IssuesPage` precedent
  (`Delete issue ${issue.title}`).
- **Testing patterns** (`src/test/*.test.tsx`, vitest 4 + jsdom 30 +
  @testing-library/react 16, `src/test/setup.ts` only wires jest-dom and
  `cleanup`):
  - mock `@clerk/clerk-react` with **stable** `getToken`/`organization`
    references (a fresh `getToken` per render churns the hook deps and refetches
    in a loop);
  - mock only the page's own API module (`@/products/vault/lib/api`,
    `@/account/lib/api`);
  - a page rendered without `AppLayout` has no Toaster, so toasts are asserted
    by partially mocking `@zero/ui`:
    ```ts
    vi.mock("@zero/ui", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@zero/ui")>()),
      toast: { success: vi.fn(), error: vi.fn() },
    }));
    ```
    The spread keeps the real `ConfirmDialog`, which is the module under test at
    each site;
  - render in a `MemoryRouter`; use `fireEvent` (not `userEvent`) and `waitFor`;
  - `IssuesPage.test.tsx` has the `deferred()` helper for driving pending state
    (a promise the test resolves or rejects by hand). Copy it per file rather
    than inventing a shared harness;
  - `getByRole(..., { name })` with a string matches the **full** accessible
    name, so a Confirm labelled `Revoke key` does not collide with a row button
    named `Revoke key zv_abcd12`. Same for `Delete project` vs
    `Delete project acme`.
- **Existing tests to update:** `ProjectsPage.test.tsx` covers only load-error
  and retry (no delete test). There is **no** `EnvironmentsPage.test.tsx`.
  `KeysPage.test.tsx:161-180` has "revokes a key after confirmation and reloads
  the list", which stubs `vi.spyOn(window, "confirm")`; that stub must go.
- **`packages/ui` is not touched by this change** and has no test runner.

## Non-goals

- No change to `ConfirmDialog` itself, to `@zero/ui`, or to any API, route, or
  Worker. This is console-only, `apps/dashboard-web` plus one changelog line.
- No change to `SecretsPage`. Its trash button edits local state and the change
  only lands on Save, so it is not an immediate destructive action and needs no
  confirmation dialog. Leave it alone.
- No confirmation added anywhere that lacks one today (creating a project,
  creating a key, saving secrets).
- No bulk delete, no undo, no optimistic removal, no `useConfirm()` hook, no
  shared test harness or shared page-object helper across the three test files.
- No refactor of `useAsyncData` / `AsyncState`, and no change to the
  mutate-then-`reload()` pattern.
- No visual redesign of the rows or pages beyond adding accessible names to the
  two unnamed icon buttons.

## Decisions

### 1. Per-site copy (fixed here, do not improvise)

Tone matches the existing errors dialog: a question as the title, a body that
names the thing in quotes, says what is removed, says `This cannot be undone
here.`, and then states the one non-obvious consequence. Keep the narrow
retention wording: **"removed from ZeroVault"**, never "erased", "forever", or
"gone from our systems".

**ProjectsPage** (state: `useState<Project | null>`)

- Row button: `aria-label={\`Delete project ${p.name}\`}` (new)
- Title: `Delete this project?`
- Description: `"<name>" and all its environments and secrets will be removed from ZeroVault. This cannot be undone here. Anything still loading these secrets, such as an app or a CI job, stops getting them.`
- Confirm label: `Delete project`
- Success toast: `Project deleted`
- Failure fallback: `Could not delete the project`

**EnvironmentsPage** (state: `useState<Environment | null>`)

- Row button: `aria-label={\`Delete environment ${env.name}\`}` (new)
- Title: `Delete this environment?`
- Description: `"<envName>" and all its secrets in "<project>" will be removed from ZeroVault. This cannot be undone here. Anything still loading these secrets, such as an app or a CI job, stops getting them.`
- Confirm label: `Delete environment`
- Success toast: `Environment deleted`
- Failure fallback: `Could not delete the environment`

**KeysPage** (state: `useState<ApiKeyInfo | null>`, so the dialog can name the
key; `handleRevoke(id: number)` becomes `confirmRevoke()` reading that state)

- Row button: `aria-label={\`Revoke key ${k.prefix}${k.suffix}\`}` (unchanged)
- Title: `Revoke this API key?`
- Description: `Key <prefix><suffix> stops working immediately. This cannot be undone here. Anything using it, including the zv CLI, your apps, and error reporting, needs a new key.`
- Confirm label: `Revoke key`
- Success toast: `API key revoked`
- Failure fallback: `Could not revoke the key`

Rationale for naming the key rather than saying "this key": the revoke button
sits in a table row, and the dialog is a portal that covers the table. Naming
the target is what makes an alert dialog safer than `confirm()`, and every other
`ConfirmDialog` site in the console already does it.

### 2. Failure handling

Same as the errors pages, no inline error region and no new state: pass
`onError` and call `toast.error(error instanceof Error ? error.message : "<per-site fallback>")`.
`ConfirmDialog` keeps the dialog open and clears pending, so the user can retry
or cancel. This is a real behavior change at all three sites: today a failed
delete silently does nothing.

### 3. Success feedback

All three get a success toast (wording in decision 1), matching
the errors pages. Fire it inside `onConfirm` after `reload()`, in that order,
so the toast only appears on a resolved request (this is `IssuesPage`'s order;
`IssueDetailPage` has no `reload()` because it navigates away).

### 4. Shape at each call site

Mirror `IssuesPage`, the list page, not `IssueDetailPage`:

```tsx
const [deleting, setDeleting] = useState<Project | null>(null);

const confirmDelete = async () => {
  if (!deleting) return;
  await api.deleteProject(tokenFn, deleting.name);
  reload();
  toast.success("Project deleted");
};
```

and, at the end of the page body:

```tsx
{deleting && (
  <ConfirmDialog
    open
    onOpenChange={(open) => { if (!open) setDeleting(null); }}
    title="Delete this project?"
    description={`"${deleting.name}" and all its environments and secrets ...`}
    confirmLabel="Delete project"
    onConfirm={confirmDelete}
    onError={(error) =>
      toast.error(error instanceof Error ? error.message : "Could not delete the project")
    }
  />
)}
```

The row button becomes `onClick={() => setDeleting(p)}` (no `void`, no async).
`EnvironmentsPage` keeps its `!project` guard inside `confirmDelete`.
`KeysPage` stores the whole `ApiKeyInfo` and calls `api.revokeApiKey(tokenFn, revoking.id)`.

Do not extract a shared wrapper for the three sites. Each is five lines of
props over one deep module; a wrapper would only re-expose the same props with
worse locality.

## Tests

All in `apps/dashboard-web/src/test/`, plain vitest + jsdom, following the
patterns listed above. Mock the page's API module, `@clerk/clerk-react`, and
`toast`; the real `ConfirmDialog` runs.

**Per site, four site-specific tests:**

1. **opens and names the target** - clicking the row button shows a
   `role="alertdialog"` containing the title and the quoted entity name, and the
   API was not called;
2. **cancel** - Cancel closes the dialog, calls no API, and the row is still
   there;
3. **success** - Confirm calls the API with the right arguments, the dialog
   closes, `toast.success` fired with the exact wording, and the row disappears
   once the second list call resolves (give the list mock a second, shorter
   return value and assert under `waitFor`);
4. **failure** - a rejected API promise leaves the dialog open and the row
   present, fires `toast.error` with the server message, and fires no
   `toast.success`.

These four are site-specific: they verify which entity went into state, the
arguments passed to that page's API, that page's copy, its refresh, and its
toast wiring.

**Plus one pending-lock test, at `KeysPage` only:** with a deferred API promise,
Confirm shows `Working...` and is disabled, Cancel is disabled, a second Confirm
click does not call the API twice, and Escape leaves the dialog open; resolving
it closes the dialog.

Reasoning for testing pending once rather than three times: the pending flag,
the disabled actions, the Escape lock, the double-submit guard, and
close-on-resolve all live inside `ConfirmDialog`
(`packages/ui/src/components/ConfirmDialog.tsx:54-93`), and
`IssuesPage.test.tsx:139-160` already exercises that contract end to end through
the real shared component. Repeating it at every migrated page re-tests the
shared module, not the migration. Keep one copy at `KeysPage` because that is
the most complex of the three sites (its `handleRevoke(id)` is being reshaped
into `confirmRevoke()` reading entity state, and its row already carries a
similar accessible name), so it is where a wiring mistake in the async path is
most likely.

File-by-file:

- **`ProjectsPage.test.tsx`** (extend, +4): keep the two existing load-error and
  retry tests, add a `describe("ProjectsPage delete")` block with the four
  site-specific tests. Fixture: two projects, delete the first, assert
  `deleteProject` called with `(expect.any(Function), "acme")`.
- **`EnvironmentsPage.test.tsx`** (new file, +4): the page reads `useParams`, so
  the `Route` must sit inside a `<Routes>` inside the `MemoryRouter` (a `Route`
  rendered directly under `MemoryRouter` does not work). Copy the harness from
  `apps/dashboard-web/src/test/IssueDetailPage.test.tsx:56-65`:

  ```tsx
  render(
    <MemoryRouter initialEntries={["/vault/projects/acme"]}>
      <Routes>
        <Route path="/vault/projects/:project" element={<EnvironmentsPage />} />
      </Routes>
    </MemoryRouter>,
  );
  ```

  Fixture: two environments, delete the first, assert `deleteEnvironment` called
  with `(expect.any(Function), "acme", "production")`. Assert the description
  names both the environment and the project.
- **`KeysPage.test.tsx`** (edit, +4 net): delete the
  `vi.spyOn(window, "confirm")` line and rewrite "revokes a key after
  confirmation and reloads the list" (one test) as the four site-specific tests
  plus the pending-lock test (five). Add the `@zero/ui` partial mock to this
  file (it has none today). All other tests in the file stay as they are.

**Expected counts.** Baseline is 6 files / 36 tests. This adds 4 + 4 + 5 = 13
tests and removes 1 (the rewritten `window.confirm` test), a net of +12:
**7 files, 48 tests**, all green. Every section of this plan uses those numbers.

Guard against regression: after the change, `rg -n "confirm\(" apps/dashboard-web/src`
returns nothing outside `ConfirmDialog` usage, and no test stubs
`window.confirm`.

## Verification

This box cannot run `workerd` (see `AGENTS.md`), so `bin/ci`, `bin/e2e-test`,
and anything that boots a Worker are out. Nothing in this change touches a
Worker's code. Verify per package:

```bash
pnpm --filter @zero/dashboard-web run test
pnpm --filter @zero/dashboard-web run lint
pnpm --filter @zero/dashboard-web run typecheck
VITE_CLERK_PUBLISHABLE_KEY=pk_test pnpm --filter @zero/dashboard-web run build
```

The build needs `VITE_CLERK_PUBLISHABLE_KEY`: `apps/dashboard-web/vite.config.ts:7-10`
throws `VITE_CLERK_PUBLISHABLE_KEY is required to build the dashboard` when it is
absent. This is a **missing build variable, not the `workerd` limitation** - the
build itself runs fine on this box. Any non-empty placeholder satisfies it,
since the key is only inlined into the bundle and nothing is executed against
Clerk; `pk_test` is enough for a local build check. (In production, the value is
supplied as a Workers Builds build variable on the `zerovault-api` connector.)
The other three commands need no environment at all. `lint` passes with the
pre-existing `SecretsPage.tsx:44` warning; that warning is not introduced by
this change and must not grow.

`packages/ui` is not modified, so its `lint`/`typecheck` are only needed if the
implementation ends up touching it (it should not). GitHub Actions CI runs the
cross-worker checks and the deploy dry-run.

jsdom cannot prove focus trapping, portal stacking above the table, or styling.
Those are already established by the errors dialog shipping on the same
component; a quick manual pass on `dash.zeroapps.dev` after deploy (open each of
the three dialogs, cancel one, confirm one) is enough, and no production data
needs to be destroyed to do it: use a scratch project, a scratch environment,
and a scratch key.

## Changelog

User-visible (the confirmation UI changes, failures are now reported, successes
are now confirmed), so it gets an entry. Console product, so root
`CHANGELOG.md`, not `apps/agent-api/CHANGELOG.md`. One bullet at the top,
matching the file's existing dated style:

```
- 2026-07-28: Deleting a project or an environment in ZeroVault, and revoking an API key, now ask for confirmation in the same in-app dialog the rest of the console uses instead of a plain browser popup. The dialog names what is about to be removed and spells out what is lost, tells you when it worked, and if the request fails it stays open and says why instead of failing silently.
```

## Skills to use

- `code` - implementing the three sites and the tests.
- `testing` - the four-test destructive-flow set per site, plus the single
  pending-lock test at `KeysPage`.
- `changelog` - before editing root `CHANGELOG.md`.
- `impeccable` - the dialog copy and the row button accessible names.
- `git-commit` - one commit, code plus tests plus changelog.

## Acceptance criteria

- `rg -n "confirm\(" apps/dashboard-web/src` finds no call to the global
  `confirm`, and no test stubs `window.confirm`.
- `ProjectsPage`, `EnvironmentsPage`, and `KeysPage` each render a
  `ConfirmDialog` with exactly the title, description, confirm label, success
  toast, and failure fallback given in decision 1.
- Each of the three sites has all four site-specific tests (opens and names the
  target, cancel, success, failure), `KeysPage.test.tsx` additionally has the
  pending-lock test, and `EnvironmentsPage.test.tsx` exists.
- A failed delete or revoke at each site leaves the dialog open and shows the
  server's message in an error toast; a successful one closes the dialog,
  refreshes the list, and shows the site's success toast.
- The `ProjectsPage` and `EnvironmentsPage` row delete buttons have accessible
  names (`Delete project <name>`, `Delete environment <name>`); `KeysPage` keeps
  `Revoke key <prefix><suffix>`.
- All four of these pass, run as four separate commands:

  ```bash
  pnpm --filter @zero/dashboard-web run test
  pnpm --filter @zero/dashboard-web run lint
  pnpm --filter @zero/dashboard-web run typecheck
  VITE_CLERK_PUBLISHABLE_KEY=pk_test pnpm --filter @zero/dashboard-web run build
  ```

- The test run reports **7 files and 48 tests, all green** (baseline 6 files /
  36 tests, plus 13 new, minus the 1 rewritten `window.confirm` test). A lower
  count means a planned test is missing.
- No file outside `apps/dashboard-web/src`, root `CHANGELOG.md`, and this plan
  is modified.
- Root `CHANGELOG.md` carries the bullet above, dated, at the top of the list.
