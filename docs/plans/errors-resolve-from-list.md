# Plan: Resolve issues from the ZeroErrors issues list

## Goal

Let a user resolve (and reopen) an issue directly from the Issues **list** in
the ZeroErrors dashboard (`apps/errors-web`), without opening the issue detail
page. Add a per-row resolve/reopen action to each list row.

## Key finding: the resolve backend already exists in full

Research of the real code shows the resolved-state model and the resolve API are
already built and shipped. **No API, DO, core, schema, or migration change is
needed.** This task is a web-only affordance plus a changelog entry.

Evidence:

- **Resolved state model.** `issues.status TEXT NOT NULL` exists in the schema
  (`apps/errors-api/src/ErrorsDO/db/migrations/0000_initial.sql` and
  `apps/errors-api/src/ErrorsDO/db/schema.ts`). The domain type is
  `type IssueStatus = "open" | "resolved"` in
  `packages/errors-core/src/index.ts`, and `IssueSummary.status` carries it in
  every list/detail response.
- **Resolve API.** `PATCH /api/issues/:id` in
  `apps/errors-api/src/routes/issues.ts` validates `{ status: "open" |
  "resolved" }` with `patchSchema` and calls
  `getErrorsDO(c).setStatus(id, status)`, returning `{ issue }` (200) or 404.
- **DO mutation.** `ErrorsDO.setStatus(id, status)` in
  `apps/errors-api/src/ErrorsDO/index.ts` updates the row and returns the
  updated `IssueSummary` (or `null` if missing).
- **Org scoping.** `getErrorsDO(c)` in `apps/errors-api/src/vaults.ts` keys the
  DO by `c.get("orgId")`. The `/api/*` middleware in
  `apps/errors-api/src/app.ts` sets `orgId` from the Clerk session (403 when no
  active org), so the PATCH is already org-guarded exactly like the list and
  detail routes. There is one `ErrorsDO` per org, so cross-org access is
  impossible by construction.
- **Queryable resolved state (needed by the paired follow-up task).**
  `ErrorsDO.listIssues({ project, status })` already filters by status, and the
  list routes (`GET /api/issues`, `GET /v1/issues`) already read
  `?status=` via `parseStatus`. The default-hide-resolved task can build on this
  without further backend work.
- **Web client already wired.** `apps/errors-web/src/lib/api.ts` already exports
  `setIssueStatus(getToken, id, status)` hitting `PATCH /api/issues/:id`. The
  issue detail page (`apps/errors-web/src/pages/IssueDetailPage.tsx`) already
  uses it via a `toggleStatus` handler that PATCHes then refetches with
  `load()`.

So the only missing piece is the **list-row affordance**. The detail page's
resolve button is the pattern to reuse.

## What to change and why

### (a) Per-row resolve/reopen action in the list — the whole task

File: `apps/errors-web/src/pages/IssuesPage.tsx`

Current state: rows render Project, Title (link), Level, Count, Last seen,
Status columns inside a `Table` from `@zero/ui`. There is no row action, no row
selection, and refresh is a `load()` callback that refetches
`api.listIssues(tokenFn, project)` and calls `setIssues`.

Changes:

1. Add an actions column. Add a trailing `<TableHead className="text-right"></TableHead>`
   to the header row, and a trailing `<TableCell className="text-right">` per row
   holding a `Button`.
2. Add a resolve/reopen handler mirroring `IssueDetailPage.toggleStatus`. It
   takes the issue, computes `next = issue.status === "open" ? "resolved" :
   "open"`, calls `await api.setIssueStatus(tokenFn, issue.id, next)`, then
   refreshes the list.
3. Render the button per row using the same iconography and semantics as the
   detail page for visual consistency:
   - open issue → `Resolve` button, `Check` icon (from `lucide-react`).
   - resolved issue → `Reopen` button, `RotateCcw` icon.
   Use `Button` from `@zero/ui` with `size="sm"` and
   `variant={issue.status === "open" ? "default" : "outline"}` (matches
   `IssueDetailPage`). Stop the click from navigating: the button lives in its
   own cell, not inside the Title `Link`, so no `stopPropagation` is needed, but
   guard against double-clicks while a request is in flight (see state below).
4. Track a per-row pending state so the button disables during its PATCH. Add
   `const [pendingId, setPendingId] = useState<string | null>(null);` set it
   around the `await`, and pass `disabled={pendingId === issue.id}` to the
   button.

Reuse the existing imports; add `Button` to the `@zero/ui` import and `Check`,
`RotateCcw` to a new `lucide-react` import (the page already imports `Search`
from `lucide-react`).

### List refresh after the action: refetch, not optimistic

Use the existing **refetch** pattern (`await load()` after the PATCH), matching
`IssueDetailPage.toggleStatus`. Rationale:

- It is the established convention in this codebase (one code path, no
  divergence).
- The list is small (one org's issues, sorted by last seen) so a refetch is
  cheap.
- It keeps this change trivially correct next to the paired follow-up task
  (hide resolved by default): once the list is filtered to open issues, a
  refetch after resolving will naturally drop the row, whereas an optimistic
  in-place status flip would leave a resolved row visible until the next load.

`api.setIssueStatus` returns the updated `{ issue }`, but prefer `load()` over
splicing that into state, for the reason above.

### (b) Bulk multi-select resolve — recommend NOT now

Keep scope to single-row. Reasons:

- `@zero/ui` ships no checkbox/selection primitive
  (`packages/ui/src/components/ui` has only button, card, input, label, sonner,
  table). Bulk select would require a new shared component.
- There is no bulk DO method or bulk API route; `setStatus` is single-id. Bulk
  would add a new endpoint + DO method + tests.
- The list is per-org and typically short; per-row resolve covers the need.

If bulk is wanted later, it is a separate task: add a `Checkbox` to `@zero/ui`,
row selection state in `IssuesPage`, a `PATCH /api/issues` (or
`POST /api/issues/bulk-status`) route, and an `ErrorsDO.setStatusMany(ids,
status)` method with its own unit test.

## Files touched

- `apps/errors-web/src/pages/IssuesPage.tsx` — add actions column, resolve/reopen
  handler, per-row pending state. (Only production-code file changed.)
- `CHANGELOG.md` — one user-facing entry (below).

No changes to `apps/errors-api`, `packages/errors-core`, or `packages/ui`.

## CHANGELOG entry

Load the `changelog` skill before editing. This repo uses a flat, dated list
(most recent first) at the top of `CHANGELOG.md`, e.g.
`- 2026-07-21: ...`. Add one bullet with the current date on top:

```
- 2026-07-22: Resolve or reopen an error issue directly from the issues list, without opening it.
```

Written from the user's perspective; no module or endpoint names.

## Test / verification plan

### errors-api tests: no change needed, and can't run on this box

No backend code changes, so no new errors-api tests. The existing suite already
covers the resolve pipeline: `apps/errors-api/src/tests/errors.test.ts` has
`"resolves and reopens an issue via PATCH"` and
`"rejects an invalid PATCH status (400)"`, plus per-org isolation tests.

Note for the implementer: `apps/errors-api` tests run on the Cloudflare Workers
vitest pool (`vitest.config.ts` uses `@cloudflare/vitest-pool-workers` with
`wrangler.test.jsonc`), which boots `workerd`. On this dev box `workerd` can't
start — running `pnpm --filter @zero/errors-api run test` fails immediately with
`EPIPE` / "no tests" before any test executes (matches the AGENTS.md NixOS
workerd limitation). Rely on GitHub Actions CI for the errors-api suite. Since
this task changes no backend code, that is not a blocker.

### errors-web: typecheck + lint + build (runnable locally)

The change is confined to `apps/errors-web`, which has no `workerd` dependency,
so verify it directly per-package:

```bash
pnpm --filter @zero/errors-web run typecheck
pnpm --filter @zero/errors-web run lint
pnpm --filter @zero/errors-web run build
```

(Confirm the exact script names in `apps/errors-web/package.json`; the API
package exposes `lint`, `typecheck`, and `test`, and the web package follows the
suite convention.)

### Manual / visual check

Run the dev servers (`pnpm turbo dev`, errors-web on 5177 / errors-api on 8791),
sign in with an org, open the Issues list, and confirm:

- Each row shows a `Resolve` button for open issues and a `Reopen` button for
  resolved ones.
- Clicking `Resolve` flips the row's Status badge to `resolved` (via refetch)
  and the button to `Reopen`; clicking again reopens it.
- The button disables during the in-flight request.
- Filtering by project still works and the action still targets the right issue.

Whole-repo `gob run bin/ci` and `bin/e2e-test` can't run here (they boot
`workerd` for the untouched errors/vault workers and e2e); the per-package
web checks above plus CI cover this change.

## Pairing with the next task (do NOT implement here)

The follow-up task is "hide resolved issues by default" in the list. This task
must only guarantee a queryable resolved state exists — it already does
(`ErrorsDO.listIssues({ status })` and `GET /api/issues?status=`). Do **not**
add any default filtering, hide toggle, or `status` query wiring in
`IssuesPage`/`api.listIssues` here. Keep this change to the per-row action only.

## Skills to use

- `changelog` — load before adding the `CHANGELOG.md` bullet; keep it
  user-facing and in the repo's flat dated format.
- `code` — when implementing the `IssuesPage.tsx` change.
- `git-commit` — commit the code and the changelog together in one change.

## Acceptance criteria

- The Issues list shows a per-row resolve/reopen button that PATCHes
  `/api/issues/:id` via the existing `api.setIssueStatus` and refreshes the list.
- Open issues offer `Resolve`; resolved issues offer `Reopen`; the button
  disables while its request is in flight.
- No backend/core/UI-package changes; the resolve endpoint and DO method are
  reused as-is.
- `CHANGELOG.md` has a dated user-facing entry.
- `apps/errors-web` typecheck, lint, and build pass locally; errors-api tests
  are unchanged and left to CI.
- No default-hide-resolved behavior is introduced (reserved for the paired task).
```