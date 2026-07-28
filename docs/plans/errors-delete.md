# Plan: Delete an issue in ZeroErrors

## Goal

Give ZeroErrors a way to remove data. Today nothing can be deleted: there is no
delete route on the API and no delete affordance in the console. Writing the
getting-started docs required POSTing real reports to production, and the result
is permanent: the org's ErrorsDO holds a project `docs-demo` with one issue
"Hello from getting-started" (3 events).

Ship a hard delete of a single issue (with its stored events), on both the
public API and the console, with a real confirmation dialog. Then use it to
remove the `docs-demo` leftovers as the proof the feature works.

## Repo state this plan was written against

`main` at `dc16345` ("ci: publish zerovault-cli from a v* tag via npm OIDC"),
after `git fetch` and fast-forward. Everything in "Verified" below was read from
that tree. The verification pass in `docs/plans/errors-delete-verify.md` checked
the same commit and fetched `juanibiapina/zero-skills` at `dbfc255`. Both of its
rounds are folded into this revision: Round 1's BLOCKER, SHOULD-FIX, and NIT
findings, and Round 2's five SHOULD-FIX items and NIT (Round 2 reported no
blockers). See "Verification findings and how they are resolved" at the end.

## Verified vs assumed

### Verified by reading the code

- **Errors lives in `apps/vault-api`** (`@zero/dashboard-api`, Worker
  `zerovault-api`), under `src/errors/`. `packages/errors-core` holds only
  shared types plus the pure `fingerprint` function; it has no storage logic.
- **There is no project entity.**
  `apps/vault-api/src/errors/ErrorsDO/db/schema.ts` declares **two domain
  tables**: `issues` (id, fingerprint UNIQUE, project, title, level, status,
  count, first_seen_at, last_seen_at) and `events` (id, issue_id, message,
  stack, context_json, user_id, created_at). At runtime `do-orm` also creates
  its own `__migrations` bookkeeping table, so "two tables" means two domain
  tables, not two tables in the database. `project` is a plain TEXT column on
  `issues`. The DO header comment says it outright: "There is no project
  registry - `project` is a freeform label on each issue." A project exists
  exactly as long as some issue row carries its name, and it disappears from the
  console the moment the last such issue is gone. The only project surface is
  the free-text filter in `IssuesPage`, backed by `listIssues({ project })`;
  there is no distinct-project query or dropdown.
- **Events are already a lossy capped tail.** `EVENT_CAP = 50` in
  `ErrorsDO/index.ts`; `pruneEvents` deletes the oldest rows past the cap on
  every ingest. `issues.count` is the all-time occurrence count and is not tied
  to the number of stored events.
- **No application state outside the DO references an issue id.** `rg` for
  `issueId|issue_id` hits only `ErrorsDO`, its schema/migration,
  `ErrorsService`, `LogNotifier`, `packages/errors-core` types, the API tests,
  and the docs. There is no cache, no secondary index, no cross-DO reference, no
  KV entry keyed by issue. A delete therefore leaves nothing stale: the only
  derived values are `issues.count` (on the deleted row) and the two SQLite
  indexes, which SQLite maintains.
- **Deleted data is not instantly unrecoverable everywhere, and the plan must
  not claim it is.** Two retention surfaces exist outside the active tables:
  - `LogNotifier` (`apps/vault-api/src/errors/notify/LogNotifier.ts`)
    `console.log`s `issueId`, `project`, `title`, `level`, and `count` on every
    new or regressed issue, and Worker observability is enabled
    (`apps/vault-api/wrangler.jsonc`), so that record lands in Cloudflare
    Workers Logs. Cloudflare documents a maximum Workers Logs retention of
    **7 days**.
  - SQLite-backed Durable Objects have **point-in-time recovery for the past 30
    days** through the PITR API.

  So the honest promise is "removed from ZeroErrors": the active issue row and
  its stored event rows are gone from every read path and every product surface.
  It is not cryptographic erasure, and no wording in the product, docs, or
  changelog may imply it is.
- **Org scoping is by DO identity.** `getErrorsDO(c)` in
  `apps/vault-api/src/errors/vaults.ts` returns
  `ERRORSDO.get(ERRORSDO.idFromName(orgId))`. The `orgId` comes from the API key
  record (`validateApiKey` against the shared `APIKEYS` KV, v2 keys only) for
  `/errors/v1/*`, or from the Clerk session for `/api/*` (401 without a user,
  403 without an active org, in `dashboard-app.ts`). One ErrorsDO per org, so a
  request can only ever address its own org's store. An id supplied under
  another org reaches a different DO and cannot touch the source row. Cross-org
  delete is impossible by construction, exactly like list and detail today.
- **Existing errors routes** (`src/errors/routes/issues.ts`): `GET
  /errors/v1/issues` and `GET /api/errors/issues` share one `list` handler;
  `GET /api/errors/issues/:id` and `PATCH /api/errors/issues/:id` are
  console-only. 404 body is `{ error: "Issue not found" }`, invalid PATCH is
  400 `{ error: "Invalid status" }`. `/errors/v1/*` is behind
  `ERRORS_RATE_LIMITER` and permissive CORS; `/api/*` is same-origin Clerk.
- **Vault's destructive precedent.** `DELETE /vault/v1/projects/:project` and
  `/api/vault/projects/:project` (`src/routes/projects.ts`) return `new
  Response(null, { status: 204 })` on success and `404 { error: "Project not
  found" }` when the registry row is missing; the same handler is mounted on
  both the API-key and Clerk paths. `DELETE .../keys/:id` returns 204
  unconditionally. `OrgDO.deleteProject` returns a boolean so the route knows
  whether to shred the vault.
- **The console has three bare `confirm()` sites, not two**, and they are thinly
  tested:
  - `apps/dashboard-web/src/products/vault/pages/ProjectsPage.tsx:39` (delete
    project)
  - `apps/dashboard-web/src/products/vault/pages/EnvironmentsPage.tsx:46`
    (delete environment)
  - `apps/dashboard-web/src/account/pages/KeysPage.tsx:67` (revoke key)

  `ProjectsPage.test.tsx` covers only the load-error and retry paths; it has no
  delete test. There is no `EnvironmentsPage.test.tsx`. All three call the
  unqualified global `confirm(...)`, not `window.confirm(...)`.
- **The CLI has nothing for Errors.** `packages/zerovault-cli/src` contains no
  errors command at all (only vault client/config/transfer). Nothing to change
  there.
- **`do-orm` supports what this needs.** `Database` exposes `delete(table, {
  where })` (bulk by condition), `get`, `count`, `raw`, and `transaction(fn)`,
  which is implemented with `DurableObjectStorage.transactionSync(fn)` and rolls
  back when the synchronous callback throws. The migration declares
  `events.issue_id REFERENCES issues(id) ON DELETE CASCADE`, but this plan does
  not rely on cascade firing (see below).
- **Console async seam.** `useAsyncData(fetcher, deps)` +
  `<AsyncState state onRetry>` (`packages/ui`) own the load/error/retry
  lifecycle; pages mutate through an API function then call `reload()`.
  `fetchApi` already handles a 204 by returning `undefined`.
- **`reload()` is fire-and-forget.** `packages/ui/src/hooks/useAsyncData.ts`
  defines `reload` as `useCallback(() => setNonce((n) => n + 1), [])`; the
  refetch runs in the `useEffect` keyed on `[...deps, nonce]`. It returns
  `void`, so no caller can await the refreshed data. Any claim that an awaited
  mutation "closes only once the list is consistent" is false (decision 5 says
  what actually happens).
- **`@zero/ui` primitives available:** button (has a `destructive` variant),
  card, input, label, table, sonner. `<Toaster position="bottom-right" />` is
  already mounted in `AppLayout`, but **no code anywhere calls `toast()`** and
  `@zero/ui` does not re-export it. There is no dialog, alert-dialog, or
  checkbox primitive. `packages/ui` has no test script, so any test of a shared
  primitive has to live in `apps/dashboard-web`.
- **jsdom 30 does not implement `HTMLDialogElement.showModal`.** A direct probe
  gives `typeof el.showModal === "undefined"` and a `TypeError` on call. A
  native `<dialog>`-based confirm would need a shim in
  `apps/dashboard-web/src/test/setup.ts` to be testable. This rules out the
  otherwise attractive native-dialog route.
- **Radix Alert Dialog works under jsdom 30.** `@radix-ui/react-alert-dialog`
  1.1.23 was probed in an isolated jsdom 30 + React 19 setup: it rendered with
  `role="alertdialog"`, put initial focus on Cancel, and closed on Escape. It
  needs no `ResizeObserver` or pointer capture, unlike Radix Select.
- **`AlertDialog.Action` is a close control.** Radix documents that clicking
  Action closes the dialog. A stock shadcn composition therefore closes on the
  first click, which would make any pending state invisible and would tear the
  dialog down before a failed request could be retried. `ConfirmDialog` has to
  take that behavior over deliberately (decision 5).
- **`apps/vault-api` tests need workerd** (`@cloudflare/vitest-pool-workers`
  with `wrangler.test.jsonc`), which cannot start on this box. They do run in
  CI: the package defines `test: "vitest run"`, `turbo.json` includes
  `@zero/dashboard-api#test`, and `.github/workflows/ci.yml` runs the root
  `pnpm run test`. `apps/dashboard-web` tests are plain vitest + jsdom and do
  run here; the current baseline is 4 files, 25 tests, green.
- **`runInDurableObject` is available to the vault-api tests.** It is exported
  by `cloudflare:test` from `@cloudflare/vitest-pool-workers` 0.18.5, and
  `apps/vault-api/tsconfig.json` already lists
  `@cloudflare/vitest-pool-workers/types` in `compilerOptions.types`, so
  importing it typechecks with no config change.
- **Test seams that already exist in vault-api tests:** `errors.test.ts` has
  `errorsDO(orgId)` (a typed DO stub) and a `MockNotifier` implementing
  `Notifier`, injected via `createDashboardApp(typedEnv, { notifier: mock })`
  with a fake `ExecutionContext` that collects `waitUntil` promises.
  `errors-clerk-auth.test.ts` mocks `@clerk/hono` and drives the `/api/*`
  surface with `X-Test-Clerk-User-Id` and `X-Test-Clerk-Org-Id` headers, so the
  Clerk-path delete case belongs in that file.
- **Docs that make claims this change invalidates:**
  `apps/docs/src/content/docs/errors/overview.md` says "Resolving sets the
  status; it does not delete the issue." and "An error project is created
  implicitly by the first report that carries its name."
  `apps/docs/src/content/docs/errors/getting-started.mdx` is the page that
  created `docs-demo`; it documents the ingest endpoint, the report fields, and
  the error responses, and it is the natural home for a cleanup step.
  `docs/zeroerrors/design.md` lists the route inventory.
- **`juanibiapina/zero-skills` is cloned at `~/workspace/juanibiapina/zero-skills`**
  (`zeroerrors/SKILL.md`, `zerovault/SKILL.md`). The errors skill documents the
  ingest contract and tells agents to send a test report to project
  `docs-demo`; it documents no read or write endpoint beyond ingest. That
  repo's own `AGENTS.md` requires every documented endpoint to be verified
  against production before the skill claims it, which drives the rollout order
  in decision 6.
- **Production state, read-only check on 2026-07-28:** `docs-demo` holds one
  open issue titled `Hello from getting-started` with count 3. No id was printed
  and nothing was deleted.

### Assumed, not verified

- Durable Object SQLite foreign-key enforcement (whether the declared `ON DELETE
  CASCADE` fires) was not tested. The plan deletes events explicitly, so it is
  correct either way.
- `docs-demo` still holds exactly that one issue at cleanup time. The cleanup
  lists before deleting, so a different count changes nothing.

## Decisions

### 1. Scope: one issue, nothing else

**First cut: delete a single issue, with its events.** Console affordance on the
issues list row and on the issue detail page; API on `/errors/v1/issues/:id`
and `/api/errors/issues/:id`.

This is enough to solve the motivating problem in full. Because `project` is
only a column value, deleting the one `docs-demo` issue also removes the
project from every surface: the list filter finds nothing, and no other read
path enumerates projects.

Deliberately left out, with what each would take:

- **Delete a project.** Meaningless as an entity operation here; it can only
  mean "delete every issue whose `project` column equals this string". It buys
  one click instead of N, and N is 1 for the case at hand. When it is wanted,
  the honest surface is not `/projects/:name` (which would imply a registry that
  does not exist) but a filter-scoped bulk delete driven from the console's
  existing project filter box: "Delete all 12 issues in docs-demo". Cost at
  scale, since the question deserves a number: one row per issue plus up to 50
  event rows per issue, so up to 51N row deletes. SQLite can do it in two
  statements (`DELETE FROM events WHERE issue_id IN (SELECT id FROM issues WHERE
  project = ?)` then `DELETE FROM issues WHERE project = ?`), and there is no
  index on `project`, so both scan the issues table. That is fine for the
  thousands-of-rows range and is not fine as an unbounded promise: past roughly
  a few thousand issues it needs a bounded loop (delete K issues per call,
  return `{ deleted, remaining }`, repeat) so one request cannot blow the DO's
  CPU budget. Deferring it avoids designing that pagination contract before
  anyone needs it.
- **Delete a single event.** No value. Events are already an auto-pruned tail
  capped at 50; the store makes no durability promise about an individual
  occurrence, so removing one is neither a privacy tool nor a cleanup tool.
- **Bulk delete resolved issues.** Needs either multi-select (no checkbox
  primitive in `@zero/ui`) or a filter-scoped bulk endpoint, plus a
  confirmation that states a count it computed server-side. Same family as
  project delete; ship after single delete proves the shape.
- **Mute / ignore a fingerprint.** Different feature (a `mutes` table consulted
  at ingest). Delete is explicitly not mute, see below.
- **Migrating the three existing `confirm()` sites to the new dialog.** Split
  out; see decision 5.

### 2. Semantics: hard delete, issue plus its events

**Hard delete.** The issue row and every `events` row with that `issue_id` are
removed. No `deleted_at`, no tombstone.

Why not soft delete:

- The user need is to get data out of the product's active surfaces. A soft
  delete does not satisfy it: the issue would still exist, just hidden.
- The store already discards data by design (event cap), so there is no
  durability promise to protect.
- A tombstoned issue keeps its row in the `issues_fingerprint_unique` index,
  which forces ingest to grow an undelete-or-resurrect branch on the hot path.
  Hard delete leaves the fingerprint free and `record()` untouched.

**What delete does and does not promise.** It removes the active issue row and
its stored event rows, so the issue is gone from every read path, every console
surface, and every API response. It is not an erasure guarantee across the
platform: Workers Logs may still hold the id, project, title, level, and count
that `LogNotifier` printed when the issue was created or regressed (up to 7 days
of retention), and DO point-in-time recovery can restore the whole store to a
moment in the past 30 days. Say it this narrowly in the product copy, the docs,
and the changelog. Do not write "for good", "permanently erased", or "gone from
our systems".

**Order and atomicity.** Inside one `db.transaction`: look up the issue by id,
return `false` if absent, `delete(eventsTable, { where: eq("issue_id", id) })`,
then `delete(issuesTable, { where: eq("id", id) })`. Deleting children first is
correct whether or not DO SQLite enforces the declared cascade. The explicit
transaction matters for more than style: if the two deletes could commit
separately, a failure between them would leave an issue whose count stands and
whose event tail is empty. Cost is bounded: at most 50 event rows plus 1 issue
row per delete, two statements, no batching needed.

**Project consequence, stated plainly.** Deleting the last issue carrying a
project label removes the project from the console, because the label is not
stored anywhere else.

### 3. Idempotency and races

- **Repeat delete.** The effect is idempotent (the state after two calls equals
  the state after one), but the second call reports `404 { error: "Issue not
  found" }`, matching `DELETE /vault/v1/projects/:project` and the existing
  issue-detail 404. The console cannot easily hit this: the confirm dialog
  closes on success and the row disappears on reload.
- **Concurrent ingest.** A Durable Object handles one request at a time, and
  both `record()` and the new `deleteIssue()` are synchronous SQLite blocks with
  no `await` inside, so they cannot interleave. The only real race is a report
  landing between the user reading the page and confirming the dialog; the
  delete then removes an occurrence the user never saw. Acceptable, and the
  dialog names the issue being deleted.
- **Next ingest after a delete.** The fingerprint no longer exists, so
  `record()` takes the insert branch: a brand new issue id, `count` back to 1,
  `firstSeenAt` = now, `isNew: true`, and a "new issue" notification fires
  (`ErrorsService` notifies on `isNew || isRegression`). Delete is not mute;
  a live bug comes back. This must be said in the confirm copy and in the docs,
  because it is the one surprising behavior of the feature.

### 4. API surface

One handler, mounted on both auth surfaces, in
`apps/vault-api/src/errors/routes/issues.ts` next to `list`:

| Method | Path | Auth | Success | Errors |
|---|---|---|---|---|
| `DELETE` | `/errors/v1/issues/:id` | `zv_` API key (org-scoped) | `204`, empty body | `401 {"error":"Invalid API key"}`, `404 {"error":"Issue not found"}`, `429` + `Retry-After` |
| `DELETE` | `/api/errors/issues/:id` | Clerk session | `204`, empty body | `401 {"error":"Unauthorized"}`, `403 {"error":"No active organization"}`, `404 {"error":"Issue not found"}` |

Both surfaces get it, unlike detail/PATCH which are console-only. Reason: the
motivating incident is an agent or a person POSTing test reports from a script,
and the fix should be reachable from the same place the mess was made. The
public docs and the `zero-skills` update below depend on it.

Security tradeoff, stated rather than hidden: an ingest key is often deployed
inside an app, and this gives it destructive power over the org's issues. That
key can already read every issue in the org (`GET /errors/v1/issues`) and can
already delete an entire ZeroVault project with its secrets
(`DELETE /vault/v1/projects/:project`), so the established key model is "one
org key, full org control". Adding scoped or read-only keys is a separate,
larger piece of work and is out of scope here.

No new types in `packages/errors-core`: a 204 carries no body.

### 5. Console UX

**Where.** Two places, both mirroring where Resolve already lives:

- **Issues list row** (`IssuesPage.tsx`): a ghost icon button with `Trash2` in
  `text-destructive`, in the existing right-aligned actions cell, after the
  Resolve/Reopen button. `aria-label={`Delete issue ${issue.title}`}` (the
  `KeysPage` precedent for icon-only buttons).
- **Issue detail** (`IssueDetailPage.tsx`): a `Delete` button beside the
  Resolve/Reopen button in the header row.

**Confirmation: a real dialog, not `confirm()`.** The repo's current destructive
pattern is a bare `confirm()`. That is what exists, not what is good: it is
unstyled, unbrandable, cannot state a consequence in more than one line, and is
blocked or suppressed by some browsers. This change ships a permanent data-loss
action whose one non-obvious consequence (the issue can come back as a new
issue) does not fit in a `confirm()` string, so it gets a real dialog.

`ConfirmDialog` in `packages/ui/src/components/ConfirmDialog.tsx`, built on
shadcn's `alert-dialog` (new dependency `@radix-ui/react-alert-dialog` in
`packages/ui`, alongside the existing `@radix-ui/react-label` and
`react-slot`). Radix gives focus trapping, Escape to dismiss, a portal that
escapes any `overflow` container, correct `role="alertdialog"` semantics, and
initial focus on **Cancel** (the least destructive action), all of which a
hand-rolled modal gets wrong on the first try.

**Scope limit: only the new Errors action uses it in this task.** The three
existing `confirm()` sites (`ProjectsPage`, `EnvironmentsPage`, `KeysPage`) stay
as they are. Migrating them is a separate change: it touches two products and
the account area, only one of the three has a test file at all, and none of them
has a delete-path test today, so doing it here would mean writing three
destructive-flow test suites for code this feature does not touch.

**The deferred work is recorded here, and no tracker step is part of this
task.** This plan is the record: migrating `ProjectsPage.tsx:39`,
`EnvironmentsPage.tsx:46`, and `KeysPage.tsx:67` to `ConfirmDialog` needs cancel,
confirm, pending, success, and failure tests for each of the three flows, and is
its own change. No phase below opens an issue, no acceptance criterion requires
one, and an implementer who does nothing about it has still finished this task.
Until that change lands the console knowingly has two confirmation styles, which
is the accepted cost of keeping this one reviewable.

**Interface** (the only thing exported from `@zero/ui`; the raw alert-dialog
parts stay private so call sites cannot re-assemble them ad hoc):

```tsx
<ConfirmDialog
  open={boolean}
  onOpenChange={(open: boolean) => void}
  title={string}
  description={ReactNode}
  confirmLabel={string}                 // e.g. "Delete issue"
  onConfirm={() => Promise<void>}       // dialog awaits this
  onError={(error: unknown) => void}    // optional; called when onConfirm rejects
/>
```

**Async behavior, defined rather than implied.** Radix's `AlertDialog.Action`
closes the dialog on click, so a `void onConfirm` could never show pending state
or survive a failed request. `ConfirmDialog` takes that over:

- The implementation calls `event.preventDefault()` on the `AlertDialogAction`
  click, so Radix does not close the dialog. The dialog decides when to close.
- Pending state is internal, not a prop. While the `onConfirm` promise is
  pending: Confirm is disabled and shows pending text, Cancel is disabled, and
  the dialog ignores close requests from Escape and the overlay (it does not
  forward `onOpenChange(false)` while pending). A second Confirm click cannot
  fire a second request.
- On resolve, the dialog calls `onOpenChange(false)`.
- On reject, the dialog stays open, clears pending, and calls `onError(error)`
  once. The user can retry or cancel. The caller surfaces the message.

The caller therefore puts the whole success path inside `onConfirm` (request,
then `reload()` or `navigate()`, then the success toast) and the failure copy in
`onError`. Rejected alternative: keep `onConfirm` synchronous and have every
call site `preventDefault` the Radix event and drive `open` itself. That leaks
Radix's event model into every call site and re-creates the pending and
double-submit logic at each one, which is exactly the complexity this module
exists to absorb.

The Confirm button uses `variant="destructive"`. Deletion test: without this
module every destructive site re-assembles seven Radix parts plus the
preventDefault, plus pending, plus double-submit guarding, plus the destructive
variant. The complexity reappears at each call site, so the module earns its
keep even with a single caller today.

**Copy** (list row and detail use the same wording):

> Title: `Delete this issue?`
> Body: `"<issue title>" and its stored events will be removed from ZeroErrors.
> This cannot be undone here. If the same error is reported again it comes back
> as a new issue.`
> Buttons: `Cancel` / `Delete issue`

The last sentence is the whole reason a custom dialog earns its place; it is the
non-obvious semantic from decision 3 and does not fit in a `confirm()` string.

**After.** From the list, inside `onConfirm`: `deleteIssue`, then `reload()`,
then `toast.success("Issue deleted")`. What that guarantees, stated exactly:
`reload()` returns `void` and only increments `useAsyncData`'s nonce, and the
refetch starts afterwards in an effect. So `onConfirm` resolves and the dialog
closes as soon as the DELETE succeeded, not once the list has come back; the row
disappears a moment later and `AsyncState` owns that loading state. This is the
established mutate-then-`reload()` behavior (`ProjectsPage.handleDelete`,
`IssuesPage.toggleStatus`), and it stays. Do not widen the shared
`useAsyncData.reload` interface to return a promise just to make this one dialog
awaitable: it is used by every data page, and the cost of the change lands there
rather than here. From the detail page: `deleteIssue`, then
`toast.success("Issue deleted")`, then `navigate("/errors/issues")`; the
navigation unmounts the page, and the dialog's post-resolve `onOpenChange(false)`
on an unmounted tree is a no-op. On failure, `onError` fires `toast.error(...)`
with the message and the dialog stays open.

Export `toast` from `@zero/ui` (`export { toast } from "sonner"`) so
`apps/dashboard-web` does not import a package it does not declare; `<Toaster />`
is already mounted in `AppLayout`, so nothing else is needed in the app.

**AsyncState seam.** Unchanged, and deliberately so. Delete is a mutation, not a
data region: it follows the established mutate-then-`reload()` pattern
(`ProjectsPage.handleDelete`, `IssuesPage.toggleStatus`). No optimistic removal,
no new hook. `IssuesPage`'s existing `pendingId` keeps serving the
Resolve/Reopen button; the delete's in-flight state lives in the dialog.
`AsyncState` keeps owning load/error/retry for the list itself.

### 6. CLI, skills, docs

- **CLI: no change.** `zerovault-cli` has no errors commands to extend.
- **`apps/docs` (public, user-facing, the primary place the new route is
  promised):**
  - `errors/overview.md`: the line "Resolving sets the status; it does not
    delete the issue" points at delete instead. A new **Deleting an issue**
    section states, on the public site:
    - the console click path (list row and issue detail, both behind a
      confirmation);
    - the API contract, `DELETE https://api.zeroapps.dev/errors/v1/issues/{id}`
      with `authorization: Bearer $ZEROVAULT_API_KEY`, returning `204` with an
      empty body, `404 {"error":"Issue not found"}` for an unknown or
      already-deleted id, `401` for a bad key, and `429` with `Retry-After` when
      rate-limited;
    - where an id comes from: the `issueId` in the `202` ingest response, or
      `GET /errors/v1/issues?project=<name>`;
    - that a deleted issue comes back as a **new** issue (new id, count from 1)
      if the same error is reported again, so delete is not mute;
    - that removing the last issue of a project removes the project from the
      console, since a project is created implicitly by reports;
    - the narrow retention wording from decision 2: it removes the issue and its
      stored events from ZeroErrors, and it cannot be undone from the product.
  - `errors/getting-started.mdx`: step 3 gains a closing beat, "clean up the
    demo issue when you are done", with the console click path and the two-curl
    version (list `?project=docs-demo`, then `DELETE` the id). This closes the
    exact loop that produced the leftovers.
    The two public pages above ship in the second commit (phase 9), after the
    route is verified in production.
  - `docs/zeroerrors/design.md` (internal, ships with the code in phase 6): add
    the delete route to the route inventory, a line on hard-delete semantics and
    the explicit transaction, and the Workers Logs / PITR retention caveat.
- **`juanibiapina/zero-skills`: yes, required, and after production
  verification.** `zeroerrors/SKILL.md` tells agents to POST a test report to
  project `docs-demo`, which is precisely how the undeletable demo data was
  created. Add a short "Clean up test reports" section documenting `GET
  /errors/v1/issues?project=<name>` (already live, currently undocumented in the
  skill) and the new `DELETE /errors/v1/issues/:id` (204, 404), plus the
  sentence that a deleted issue reappears as a new issue if the error recurs.

  **Order matters, and it splits the `zero` work into two commits.** That repo's
  `AGENTS.md` requires every endpoint the skill documents to be verified against
  production first, and the skill is installed by users the moment it is pushed.
  The same argument applies to `apps/docs`: `zero-docs` and `zerovault-api` are
  independent Workers Builds connectors, and the docs build is package-scoped
  while the dashboard Worker builds the whole monorepo, so a single commit can
  publish "here is how to delete an issue" on the public site before DELETE
  exists in production. So: commit code, tests, the internal design note, and
  the changelog in `zero` and push (this is the only code deployment); verify in
  production; then push the public `apps/docs` change and the `zero-skills`
  update against the same verified route. Both `zero` commits, the `zero-skills`
  commit, and the production check go in the verification note. This is still
  one task, not a follow-up.

### 7. Test strategy

**Local on this box (no workerd):**

`apps/dashboard-web` vitest (jsdom). Tests go through the page, mocking only
`@/products/errors/lib/api`, `@clerk/clerk-react`, and the `toast` export,
following the existing `ProjectsPage`/`KeysPage` test shape.

Toast handling: a page rendered without `AppLayout` has no `<Toaster />`, so
`toast.error(...)` renders nothing and cannot be found in the DOM. Mock the
`@zero/ui` export instead and assert the calls:

```ts
vi.mock("@zero/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zero/ui")>()),
  toast: { success: vi.fn(), error: vi.fn() },
}));
```

(The alternative, rendering a real `<Toaster />` in the harness, is left aside:
Sonner's mount and animation timing makes the assertion flakier than a spy.)

- **New `src/test/IssuesPage.test.tsx`:**
  - clicking the row delete button opens a `role="alertdialog"` that names the
    issue and calls no API;
  - initial focus is on Cancel; Escape closes the dialog; Cancel closes it,
    calls no API, and keeps the row;
  - Confirm against a **deferred** `deleteIssue` promise, covering the whole
    pending contract from decision 5: while it is pending, Confirm is disabled,
    Cancel is disabled, a second Confirm click does not call `deleteIssue`
    twice, and pressing Escape leaves the alert dialog open. (No overlay-click
    assertion: Radix Alert Dialog already blocks ordinary outside interaction,
    and `ConfirmDialog` adds no overlay close path.);
  - resolving the deferred promise: the dialog closes and `toast.success` fired;
    then, once the second `listIssues` call queued by `reload()` resolves with
    the shorter list, the row is gone. Give the `listIssues` mock a second
    return value and assert the row's absence under `waitFor`, since the refetch
    lands after `onConfirm` has already resolved;
  - rejecting it: the dialog stays open, the row is still there, and
    `toast.error` fired with the message.
- **New `src/test/IssueDetailPage.test.tsx`** (there is no detail-page test
  today), rendered in a `MemoryRouter` with `initialEntries=["/errors/issues/i1"]`
  and routes for `/errors/issues/:id` and `/errors/issues`, plus a location probe
  element on the list route so navigation is assertable:
  - Delete opens the dialog naming the issue; Cancel closes it and stays on the
    page with no API call;
  - Confirm on success calls `deleteIssue` with the route id, fires
    `toast.success`, and lands on `/errors/issues`;
  - Confirm on failure stays on the detail page with the dialog still open and
    fires `toast.error`.
- What jsdom cannot establish here, stated so nobody over-reads a green run:
  visual styling and real-browser focus trapping. Those are covered by the
  console pass in the production sequence.
- No separate `ConfirmDialog` test: `packages/ui` has no test runner, and the
  two pages together cover every clause of the dialog contract. The Issues page
  carries open, Cancel, Escape before confirming, the pending clauses (Confirm
  disabled, Cancel disabled, Escape ignored, no double submit), resolve, and
  reject; the detail page carries resolve-then-navigate and reject-stays-open.
- `KeysPage.test.tsx` and its `window.confirm` stub stay untouched, since the
  retrofit is out of scope.

Commands (each a complete command; run them individually or joined with `&&`):

```bash
pnpm --filter @zero/dashboard-web run test
pnpm --filter @zero/dashboard-web run lint
pnpm --filter @zero/dashboard-web run typecheck
pnpm --filter @zero/dashboard-web run build
pnpm --filter @zero/ui run lint
pnpm --filter @zero/ui run typecheck
pnpm --filter @zero/dashboard-api run lint
pnpm --filter @zero/dashboard-api run typecheck
```

`@zero/dashboard-api`'s `test` needs workerd and cannot run here; `lint` and
`typecheck` do not.

**CI only (workerd):** extend `apps/vault-api/src/tests/errors.test.ts`:

- deleting an issue returns 204; afterwards `getIssue` returns null and
  `listIssues` no longer contains it;
- **no orphaned events.** `getIssue` returns `null` as soon as the issue row is
  gone, before it ever queries events, so it cannot see orphans. Assert the
  storage invariant directly with `runInDurableObject` from `cloudflare:test`
  against the same stub `errorsDO(orgId)` returns, running `SELECT COUNT(*) AS c
  FROM events WHERE issue_id = ?` on `state.storage.sql` and requiring 0. Seed
  more than one event first so the assertion can fail;
- deleting an unknown id returns 404, and deleting twice returns 204 then 404;
- **org isolation:** org B deleting org A's issue id gets 404 and A's issue
  survives (the test that actually proves the tenancy claim);
- re-ingesting the same report after a delete yields `isNew: true` and a
  different issue id, **and notifies again**: inject `MockNotifier` through
  `createDashboardApp(typedEnv, { notifier: mock })` and require two calls, the
  second with `kind: "new"` and the recreated id.

In `apps/vault-api/src/tests/errors-clerk-auth.test.ts` (the file that already
mocks `@clerk/hono`): the same delete over `DELETE /api/errors/issues/:id` with
`X-Test-Clerk-User-Id` and `X-Test-Clerk-Org-Id` returns 204 and removes the
issue. The 401/403 gate needs no new test: the `/api/*` middleware covers every
method and that file already asserts it.

**Only production can verify:** that the deployed Worker routes DELETE, that the
DO in production actually drops the rows, that the console flows work in a real
browser, and the `docs-demo` cleanup itself. Covered by the sequence below.

### 8. Changelog

Root `CHANGELOG.md` (console product), not the agent one, per AGENTS.md. One
dated bullet at the top, matching the file's existing style, written from the
user's perspective with no internal mechanics:

```
- 2026-07-28: You can now delete an error issue in ZeroErrors, from the issues list, the issue page, or the API. Deleting removes the issue and the events shown with it, and there is no undo. If the same error is reported again it comes back as a new issue with a fresh count. Deleting the last issue in a project also clears that project from the console.
```

## Implementation phases

1. **Storage.** `ErrorsDO.deleteIssue(id: string): boolean` in
   `apps/vault-api/src/errors/ErrorsDO/index.ts`, under a new `Delete` banner
   after `setStatus`. Transaction: get by id, `false` if missing, delete events
   by `issue_id`, delete the issue, `true`. No schema change, no migration.
2. **Route.** `DELETE` handler in `src/errors/routes/issues.ts`, registered on
   `/errors/v1/issues/:id` and `/api/errors/issues/:id`; `new Response(null, {
   status: 204 })` or `c.json({ error: "Issue not found" }, 404)`. Update the
   file's header comment, which currently says detail and status changes are
   dashboard-only.
3. **Shared UI.** Add `@radix-ui/react-alert-dialog` to `packages/ui`, add the
   shadcn `components/ui/alert-dialog.tsx`, add `components/ConfirmDialog.tsx`
   with the async contract from decision 5, export `ConfirmDialog` and `toast`
   from `packages/ui/src/index.ts`. Do not export the alert-dialog parts.
4. **Console.** `deleteIssue(getToken, id): Promise<void>` in
   `apps/dashboard-web/src/products/errors/lib/api.ts`; delete affordance +
   dialog + toast in `IssuesPage.tsx` and `IssueDetailPage.tsx`.
5. **Tests.** New `IssuesPage.test.tsx` and `IssueDetailPage.test.tsx`; new
   cases in `apps/vault-api/src/tests/errors.test.ts` and
   `errors-clerk-auth.test.ts`.
6. **Internal docs and changelog.** `docs/zeroerrors/design.md` (route
   inventory, hard-delete semantics, explicit transaction, retention caveat) and
   the root `CHANGELOG.md` entry. These ship with the code, per AGENTS.md. The
   public `apps/docs` pages are deliberately not in this commit; they are phase
   9.
7. **Ship the code.** One commit with phases 1 to 6, pushed to `main`. This is
   the only code deployment in the task. Adding `@radix-ui/react-alert-dialog`
   changes `pnpm-lock.yaml`, which is in the build watch paths of **all four**
   Workers, so this push rebuilds `zero-api`, `zerovault-api`, `zero-landing`,
   and `zero-docs`, not only the two the change touches. Consequences to plan
   for: the `zero-api` rebuild reassigns `UserDO` instances and resets any
   in-flight agent turn, so do not stack another push on top of it, and wait for
   all four builds to finish before verifying.
8. **Verify in production** with the sequence below, including the `docs-demo`
   cleanup.
9. **Public docs.** Second commit in `zero`: the `apps/docs` errors pages
   (`errors/overview.md` with the full DELETE contract, `getting-started.mdx`
   with the cleanup step). It touches only `apps/docs`, so it triggers
   `zero-docs` alone and cannot reset agent Durable Objects. Push only after
   step 8 has confirmed the deployed route.
10. **Update `zero-skills`** at `~/workspace/juanibiapina/zero-skills` against
    the same verified route, and push it. Record both `zero` commits, the
    `zero-skills` commit, and the production check in the verification note.

### Verification note

- Code commit: `ecb6948`.
- Plan-docs commit: `04f7bc7`.
- Public docs commit: `05e8964`.
- `zero-skills` commit: `3c73a01`.
- Production verification ran against org `org_3G8Bj2obf5XlZEdUv7jxCsyuRy1`
  with scratch project `delete-verify-1785241025`. All 12 steps passed. The
  `docs-demo` issue `f0dc012e-0b66-4dd2-a4af-2eee08198f1f` was deleted, and the
  project now lists empty.
- One open gap remains: GitHub Actions CI run `30358116643` failed before any
  step ran because of an account billing/spending-limit block. The six new
  vault-api tests, five in `errors.test.ts` and one in
  `errors-clerk-auth.test.ts`, have NEVER executed anywhere.

`zerovault-api`'s Workers Builds watch paths already include `apps/vault-api/*`,
`apps/dashboard-web/*`, and `packages/ui/*`, so the code push redeploys it with
no connector change. `apps/docs` changes redeploy `zero-docs` separately. The
lockfile entry in every Worker's watch paths is why phase 7 fans out to four
builds and phase 9 does not.

## Production verification, without risking real data

Deleting is irreversible from the product, so verify on data created for the
verification, in our own org, and only then touch the leftovers.

Three safety rules govern the whole sequence:

- **Every successful DELETE targets an id that the listing immediately before it
  printed**, scoped to the scratch project (or, at the end, to `docs-demo`). No
  successful delete ever uses an id taken from an ingest response or from an
  older listing. **There is exactly one exception, named here so the rule stays
  literal:** the repeat-delete in step 5, which deliberately re-sends DELETE for
  the scratch id that the preceding delete and listing already proved absent. It
  exists to observe the 404 and cannot remove anything.
- **One delete per listing when a listing has more than one row.** If a cleanup
  listing shows several rows, re-list before each delete and pick a single id
  whose `project` and `title` still match the expectation. Never fan a batch of
  ids out from one listing.
- **Each of the three flows gets its own scratch issue.** The API flow, the
  console list-row flow, and the console detail-page flow each consume one, so
  no flow is left without data to act on and none of them ever reaches for a
  real issue.

Nothing in the sequence deletes by project or by filter (no such endpoint
exists). The `zv_` key is org-scoped and the DO is `idFromName(orgId)`, so every
request below can only reach the key's own org's ErrorsDO. That is exactly why
step 1 and step 2 establish **which** org that is before any DELETE: the scratch
project is fresh, so a wrong-org key would only litter, but the final
`docs-demo` cleanup touches persistent production data.

Setup (`jq` is used to keep the ids visible and the output a real array, so
"empty" prints as `[]` and counts are exact):

```bash
export ZEROVAULT_API_KEY=...      # org key from the dashboard
P="delete-verify-$(date +%s)"
API=https://api.zeroapps.dev

who() {
  curl -sS "$API/errors/v1/whoami" \
    -H "authorization: Bearer $ZEROVAULT_API_KEY" | jq
}

post() {  # post <message>
  curl -sS -X POST "$API/errors/v1/errors" \
    -H "authorization: Bearer $ZEROVAULT_API_KEY" \
    -H "content-type: application/json" \
    -d "{\"project\":\"$P\",\"message\":\"$1\",\"stack\":\"Error\\n    at $1 (/x.ts:1:1)\",\"level\":\"info\"}"
  echo
}

list() {  # list [project]
  curl -sS "$API/errors/v1/issues?project=${1:-$P}" \
    -H "authorization: Bearer $ZEROVAULT_API_KEY" | jq '[.issues[] | {id, project, title, count}]'
}

del() {   # del <id>
  curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE "$API/errors/v1/issues/$1" \
    -H "authorization: Bearer $ZEROVAULT_API_KEY"
}
```

1. **Preflight: name the org the key resolves to.** `who` prints
   `{ "userId": ..., "orgId": ... }` from the already-live
   `GET /errors/v1/whoami` (`apps/vault-api/src/dashboard-app.ts`). Record that
   `orgId` in the verification note. It is the org whose ErrorsDO every request
   below reaches.
2. **Create three scratch issues, then prove the console session is the same
   org.** `post api-flow`, `post list-flow`, `post detail-flow` (distinct
   messages and stacks, so they fingerprint apart). Sign in to
   `dash.zeroapps.dev/errors` and filter by `$P`: all three rows must be there.
   This is the org check that matters, and it is done by observation rather than
   by comparing ids, because the console never displays a Clerk org id (the
   layout renders Clerk's `OrganizationSwitcher`, which shows the org **name**).
   If the console shows the wrong organization in the switcher, or the scratch
   rows are missing, stop: the key and the session are not the same org, and no
   DELETE may be issued.
3. **List and capture.** `list` returns an array of exactly three issues, all
   with `project = $P`. Record the three ids as `ID_API`, `ID_LIST`, `ID_DETAIL`.
4. **API flow, on `ID_API`.** `del "$ID_API"` prints `204`. `list` now returns
   two issues and no `ID_API`. In the signed-in console, opening
   `dash.zeroapps.dev/errors/issues/$ID_API` shows the not-found state.
5. **Repeat delete (the one exception to the listing rule).** `del "$ID_API"`
   prints `404`: idempotent effect, honest status, and the id was just proved
   absent by step 4's listing.
6. **Recreate on next ingest.** `post api-flow` again returns `202` with
   `isNew: true` and an `issueId` different from `ID_API`. Then `list` again:
   three issues, one of them the recreated `api-flow`. Take its id **from that
   listing** (not from the ingest response) as `ID_API2`, then `del "$ID_API2"`
   prints `204`. `list` is back to `ID_LIST` and `ID_DETAIL`.
7. **Console list-row flow, on `ID_LIST`.** In the console filtered by `$P`,
   confirm both scratch rows are there. On the `list-flow` row: click delete,
   check that the dialog states the issue title and the come-back-as-a-new-issue
   sentence, that focus starts on Cancel, and that Escape and Cancel both close
   it with the row still present. Then confirm: the row disappears, a success
   toast shows. `list` from the shell now returns only `ID_DETAIL`.
8. **Console detail-page flow, on `ID_DETAIL`.** From the same filtered list,
   open the `detail-flow` issue (the id comes from that listing), click Delete
   in the header, confirm, and check that the console lands back on the issues
   list with a success toast. Filtering by `$P` now shows nothing.
9. **Scratch project gone.** `list` returns `[]`, proving that removing every
   issue removes the project. If anything remains, re-list, delete one id whose
   `project` is `$P`, and repeat until `list` returns `[]`.

**Then remove the docs-demo leftovers, as the proof:**

10. `list docs-demo`, print the ids and titles, and check the result is exactly
    the demo data (one issue, `Hello from getting-started`) before deleting
    anything. If it shows anything else, stop and re-read.
11. Delete one id from **that** listing, then `list docs-demo` again. Repeat
    (re-list, check title, delete one) until `list docs-demo` returns `[]`.
12. Reload `dash.zeroapps.dev/errors`, filter by `docs-demo`, and confirm the
    empty state.

Record the `orgId` from step 1, the ids, the responses, both `zero` commits, the
`zero-skills` commit, and the console observations in the verification note.

## Risks

- **Irreversibility.** No undo in the product, by design. Mitigated by the
  dialog wording, the Cancel-focused alert dialog, and the listing-first
  verification sequence above.
- **A leaked ingest key can now destroy issues.** Accepted, with the reasoning
  in decision 4; revisit if scoped keys ever ship.
- **Retention wording drifting back to over-promising.** Delete does not purge
  Workers Logs or DO point-in-time recovery. Any copy that says "forever",
  "erased", or "gone from our systems" is wrong; see decision 2.
- **New Radix dependency.** Small, in line with the existing shadcn setup, and
  probed under jsdom 30. If it still misbehaves in the real test suite, fall
  back to a plain `role="alertdialog"` div modal with manual initial focus,
  Escape handling, and focus restore, keeping the same `ConfirmDialog` interface
  so no call site changes. Do not fall back to the native `<dialog>` element:
  jsdom 30 has no `showModal` (verified), so it would be untestable without a
  shim.
- **Two confirmation styles in the console** until the deferred migration lands.
  Accepted in decision 5, which records the deferred scope and its test
  requirements; this plan is the record, and no tracker step is part of the task.
- **A push that rebuilds all four Workers.** The lockfile change makes phase 7
  redeploy `zero-api` too, which resets agent Durable Objects mid-turn. Turns
  self-heal, but do not stack pushes: phase 9's docs commit goes out only after
  phase 7's builds have finished and production is verified.
- **Public docs leading the route.** Mitigated by the two-commit split: the
  `apps/docs` pages ship in phase 9, after step 4 of the production sequence has
  seen a real `204`.
- **A production console pass is required**, since jsdom cannot prove focus
  trapping or styling. It is steps 7 and 8 of the sequence, on dedicated scratch
  issues.

## Alternatives considered

- **Soft delete with `deleted_at`.** Rejected: does not satisfy the user need,
  and forces resurrect logic into the ingest hot path because the fingerprint
  index stays occupied.
- **`DELETE /errors/v1/projects/:name`.** Rejected for the first cut: it implies
  a registry that does not exist, and a filter-scoped bulk delete is the better
  shape when the need appears.
- **204 on a missing issue (fully idempotent status).** Rejected: the repo's
  closest precedent (vault project delete) 404s, and a 404 tells a script that
  it targeted a stale id.
- **Synchronous `onConfirm` plus a `pending` prop.** Rejected: Radix's Action
  closes the dialog on click, so pending would never be visible and a failure
  could not keep the dialog open. See decision 5.
- **Promise-returning `useConfirm()` hook** instead of a controlled component.
  Rejected: reads neatly at the call site but hides a resolve/reject lifecycle
  in a ref, and controlled state is more legible in a React tree that already
  tracks `pendingId`.
- **Retrofitting the three existing `confirm()` sites now.** Rejected as scope
  creep: three sites across two products and the account area, with almost no
  existing destructive-path test coverage to protect the change. Deferred, with
  the scope and required tests recorded in decision 5.
- **Shipping phases 1 to 6 plus the public docs as one commit.** Rejected:
  `zero-docs` and `zerovault-api` are independent connectors with independent
  builds, so one push can publish the delete instructions before the route
  answers. Two commits in `zero` instead (phases 7 and 9), which also keeps the
  changelog with the code.
- **Keep `confirm()` for the new action too.** Rejected: the one non-obvious
  consequence (the issue can come back as new) does not fit in a `confirm()`
  string.

## Skills to use

- `code` - implementing the phases.
- `changelog` - before editing root `CHANGELOG.md`.
- `impeccable` - for the `ConfirmDialog` and the two page affordances.
- `testing` - for the page-level and DO-level tests.
- `deep-modules` - when shaping `ConfirmDialog`'s interface and `deleteIssue`.
- `reproducible-locally` - for the production verification sequence.
- `git-commit` - twice: code, tests, internal design note, and changelog in the
  phase 7 commit; the public `apps/docs` pages in the phase 9 commit.
- `workspace` - the `zero-skills` repo edit lives at
  `~/workspace/juanibiapina/zero-skills`.

## Acceptance criteria

- `DELETE /errors/v1/issues/:id` and `DELETE /api/errors/issues/:id` return 204
  and remove the issue and all its events; unknown ids return
  `404 {"error":"Issue not found"}`.
- After a delete, a direct SQL count of `events` for that `issue_id` inside the
  DO is 0 (asserted with `runInDurableObject`).
- An org cannot delete another org's issue (covered by a test).
- After deleting an issue, re-ingesting the same report creates a new issue with
  a new id and `isNew: true`, and fires a second "new issue" notification
  (asserted through `MockNotifier`).
- The console offers delete on both the issues list row and the issue detail
  page, behind a `ConfirmDialog` that names the issue and states that the error
  can come back as a new issue; the list reloads, the detail page navigates back
  to the list, and a toast confirms.
- `ConfirmDialog` keeps the dialog open while the confirm promise is pending,
  disables both Confirm and Cancel during it, ignores Escape while pending,
  blocks a double submit, closes on success, and stays open and reports the
  error on failure. The Issues page test covers every one of those pending
  clauses; the detail page test covers success navigation and failure.
- `@zero/ui` exports `ConfirmDialog` and `toast`; the raw alert-dialog parts
  stay internal. The three existing `confirm()` call sites are untouched, and
  their migration stays deferred with its scope recorded in decision 5. Nothing
  in this task requires a tracker entry.
- `apps/dashboard-web` test, lint, typecheck, and build pass locally, including
  the new `IssuesPage.test.tsx` and `IssueDetailPage.test.tsx`; the new
  vault-api tests pass in CI.
- The code commit carries `docs/zeroerrors/design.md` (route and retention
  caveat) and the root `CHANGELOG.md` dated entry, written from the user's
  perspective, with no "for good" or equivalent over-promise.
- Public docs ship in a second `zero` commit, after production verification:
  `errors/overview.md` documents the DELETE contract (path, auth, 204, 404, how
  to get an id, recreate behavior, project consequence) and
  `errors/getting-started.mdx` documents cleaning up the demo issue. No public
  docs are live before the route answers `204` in production.
- The production verification sequence is run and recorded: the `orgId` from
  `/errors/v1/whoami` plus the console org check before any DELETE, three
  dedicated scratch issues, and every successful delete targeting an id from the
  immediately preceding listing (the step 5 repeat-404 being the one named
  exception).
- `zero-skills` `zeroerrors/SKILL.md` documents the cleanup flow and is pushed
  **after** the deployed route is verified in production, with both `zero`
  commits and the `zero-skills` commit recorded.
- `GET /errors/v1/issues?project=docs-demo` returns an empty list.

## Verification findings and how they are resolved

From `docs/plans/errors-delete-verify.md`. Every finding is fixed; none is
rebutted.

### Round 1

| Finding | Resolution |
|---|---|
| BLOCKER: console check ran after all scratch issues were deleted, and the id rule broke around the recreated issue | Production sequence rewritten: three scratch issues, one per flow (API, list row, detail page); every delete takes its id from the listing immediately before it, including the recreated issue in step 5; scratch project emptied and re-listed before `docs-demo` is touched |
| SF1: "for good" and "nothing outside the DO stores an issue id" are false (Workers Logs up to 7 days, DO PITR 30 days) | New "What delete does and does not promise" in decision 2, retention facts in Verified, a risk entry against over-promising, and a rewritten changelog bullet with no erasure claim and no internal mechanics |
| SF2: the `confirm()` retrofit is scope creep and there are three sites, not two | Retrofit dropped from this task; the three sites are named in Verified with their thin test coverage; `ConfirmDialog` is used only by the new Errors action; the migration is deferred with its scope recorded in decision 5; the `window.confirm` acceptance criterion is gone |
| SF3: the dialog interface never defined how async confirm survives Radix's immediate close | Decision 5 now specifies `onConfirm: () => Promise<void>` plus `onError`, internal pending, `preventDefault` on the Action, close on resolve, stay open on reject, and no double submit, with tests for each |
| SF4: `getIssue` cannot detect orphaned events, and the second notification was unasserted | Server tests now count `events` rows directly via `runInDurableObject` and `state.storage.sql`, and assert two `MockNotifier` calls with the recreated id |
| SF5: no detail-page test, and toast assertions could not work without a Toaster | `IssueDetailPage.test.tsx` added (cancel, success navigation with a location probe, failure), and the `toast` export is mocked via `importOriginal` in both page tests |
| SF6: skill update preceded production verification, and the public route had no public docs | Phases reordered so the skill ships after the deployed route is verified; `errors/overview.md` gains the full public DELETE contract and `getting-started.mdx` a cleanup step |
| NIT1: "exactly two tables" | Now "two domain tables", noting `do-orm`'s runtime `__migrations` table |
| NIT2: invalid shell pipes in the local commands | Each command listed separately, and the production sequence uses real shell functions with `jq` |

### Round 2

No blockers were reported. All five SHOULD-FIX items and the NIT are fixed here;
none is rebutted.

| Finding | Resolution |
|---|---|
| SF1: `reload()` cannot hold the dialog open until the list is consistent, because it returns `void` and only bumps a nonce | Decision 5's "After" now states the real behavior (delete, `reload()`, toast, dialog closes; `AsyncState` owns the refetch) and refuses to widen the shared `useAsyncData.reload` interface; the evidence is in Verified; the success test now resolves the second `listIssues` call and asserts the row is gone under `waitFor` |
| SF2: the absolute id rule contradicted the repeat-404 and multi-id cleanups, and nothing proved the key and console share an org | Rule restated as "every **successful** DELETE" with the step 5 repeat-404 named as the sole exception; a third rule requires re-listing before each delete when a listing has several rows; new step 1 calls `/errors/v1/whoami` and records `orgId`, and new step 2 requires the console filtered by `$P` to show all three scratch rows before any DELETE (the console shows the org **name** via Clerk's `OrganizationSwitcher`, so observation beats id comparison) |
| SF3: public docs could deploy before the route, and the lockfile rebuilds all four Workers | Phases split: phase 7 ships code, tests, internal design note, and changelog (one code deployment, four builds because `pnpm-lock.yaml` is in every Worker's watch paths, `zero-api` DO resets expected); phase 9 ships `apps/docs` after production verification and triggers only `zero-docs`; decision 6, the risks, the skills list, and the acceptance criteria all follow |
| SF4: tests did not cover the full pending contract | The Issues page deferred test now asserts Confirm **and** Cancel disabled, Escape ignored while pending, and no double submit; the "no separate `ConfirmDialog` test" note says which page covers which clause; the acceptance criterion matches. No overlay-click assertion, since Radix already blocks outside interaction and no overlay close path is added |
| SF5: acceptance criteria required a filed follow-up that no phase filed | The deferred `confirm()` migration is recorded in decision 5 (the three sites and the tests each needs) with an explicit statement that no tracker step is part of this task; "filed" removed from the risks, alternatives, and acceptance criteria |
| NIT1: `list` printed no rows instead of `[]` | The `jq` filter is wrapped in brackets so it emits one array, so empty prints `[]` and counts are exact (see the `list` helper in the sequence) |
