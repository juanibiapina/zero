# Verification: ZeroErrors issue delete plan

Plan: `docs/plans/errors-delete.md`

Verified against `main` at `dc16345bfbd2c17257003d43e7b90cf94f3e8e7d`, which matched `origin/main` after `git fetch --all --prune`. The plan is untracked. The `zero-skills` checkout was also fetched and matched `origin/main` at `dbfc25533c9dba13ac61018141434eb08d513449`.

## Verdict

Not ready to execute. The storage and route design is sound, and issue-only delete solves the `docs-demo` case. The production verification sequence has one unsafe gap. The retention wording, retrofit scope, dialog async behavior, and tests need correction before implementation.

## Verified without findings

- The Errors domain schema has two data tables, `issues` and `events`; `project` is a required text column on `issues`, not an entity. The only project filter is the free-text input in `IssuesPage`, backed by `listIssues({ project })`. There is no distinct-project query or dropdown. Deleting the last issue with `project = "docs-demo"` removes that label from every current Errors surface. Evidence: `apps/vault-api/src/errors/ErrorsDO/db/schema.ts:15-36`, `apps/vault-api/src/errors/ErrorsDO/index.ts:156-184`, `apps/dashboard-web/src/products/errors/pages/IssuesPage.tsx:24-37,60-66`.
- Events are pruned after every ingest and capped at 50 while `issues.count` keeps the all-time count. Evidence: `apps/vault-api/src/errors/ErrorsDO/index.ts:28,118-149`; the current integration test confirms count 55 with 50 stored events at `apps/vault-api/src/tests/errors.test.ts:176-198`.
- Application state outside the ErrorsDO does not reference an issue id. The exception is observability logging, covered in SHOULD-FIX 1.
- Org selection is `ERRORSDO.idFromName(orgId)` for both API-key and Clerk requests. An id supplied under another org reaches a different DO and cannot delete the source row. Evidence: `apps/vault-api/src/errors/vaults.ts:15-23`, `apps/vault-api/src/dashboard-app.ts:54-77,84-101`.
- The Vault project-delete precedent uses one handler under both auth paths and returns 204 or 404. Evidence: `apps/vault-api/src/routes/projects.ts:39-50,56-61`.
- The proposed transaction is valid. Installed `do-orm` commit `5094ebc` implements `db.transaction(fn)` with `DurableObjectStorage.transactionSync(fn)`: `node_modules/.pnpm/do-orm@https+++codeload.github.com+juanibiapina+do-orm+tar.gz+5094ebcbe8a9717a472e13432c313757f3942f57/node_modules/do-orm/src/db.ts:195-197`. Cloudflare documents that `transactionSync` rolls back when its synchronous callback throws: <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionSync>. The existing `record()` method performs several synchronous SQL statements without an explicit transaction. That is also valid because Cloudflare automatically groups a no-`await` series of reads and writes atomically. An explicit transaction for delete is still clearer. If the two deletes were allowed to commit separately, a failure after deleting events would leave an issue whose count remains but whose recent-event tail is empty. The proposed transaction prevents that state.
- Re-ingest after delete follows the promised path. `record()` finds no fingerprint, creates a random issue id with count 1 and `isNew: true`, then `ErrorsService.report()` calls the notifier because `isNew || isRegression`. Evidence: `apps/vault-api/src/errors/ErrorsDO/index.ts:84-105`, `apps/vault-api/src/errors/services/ErrorsService.ts:25-54`.
- `HTMLDialogElement.showModal` and `close` are absent in the installed jsdom 30. A direct probe produced `showModal: "undefined"` and a `TypeError`. Radix Alert Dialog 1.1.23 was also probed in an isolated jsdom 30 + React 19 setup: it rendered with `role="alertdialog"`, focused Cancel, and closed on Escape.
- `@zero/ui` has no dialog primitive. `AppLayout` mounts `<Toaster position="bottom-right" />`, no caller invokes `toast`, and `toast` is not re-exported. Evidence: `packages/ui/src/components/AppLayout.tsx:309`, `packages/ui/src/index.ts:39`, and the complete primitive list under `packages/ui/src/components/ui/`.
- The dashboard API tests do run in CI. Both packages define `test: "vitest run"`; CI runs root `pnpm run test`; Turbo includes `@zero/dashboard-api#test`. Evidence: `apps/vault-api/package.json:13`, `apps/dashboard-web/package.json:12`, `.github/workflows/ci.yml:61-62`, `turbo.json:16`. `pnpm turbo run test --dry=json` also listed the dashboard API and web test tasks while marking `@zero/agent-e2e#test` nonexistent.
- The current dashboard-web baseline passes: 4 files and 25 tests.
- A read-only production query on 2026-07-28 confirmed that `docs-demo` currently has one open issue titled `Hello from getting-started` with count 3. No id was printed or deleted.

## BLOCKER

### 1. The UI production check runs after all scratch issues are deleted

Plan steps 1-6 create scratch issues and delete every remaining issue in `$P`. Step 7 then says to confirm deletion, toast, and row removal from both the list and detail pages (`docs/plans/errors-delete.md:427-431`). There is no scratch issue left to delete. Completing step 7 as written would require deleting another production issue or creating undeclared data, so the sequence does not meet its own "without risking real data" claim.

The id rule also breaks around the recreated issue. Step 5 creates a new id from the ingest response. Step 6 deletes the remaining issues without first listing again, while the final rule permits only ids obtained from step 2 or step 8 (`docs/plans/errors-delete.md:423-442`).

Fix: reserve known scratch issues for the two console checks and perform those checks before final cleanup. Use at least three distinct scratch issues: one for public DELETE/repeat DELETE/re-ingest, one for list-page delete, and one for detail-page delete. Re-list `?project=$P` immediately before every cleanup pass, verify every row has the expected scratch project and title, and delete only ids from that fresh listing. Then re-list and require `[]` before touching `docs-demo`.

## SHOULD-FIX

### 1. "For good" and "nothing outside the DO stores an issue id" are false

`LogNotifier` writes `issueId`, project, title, level, and count with `console.log` (`apps/vault-api/src/errors/notify/LogNotifier.ts:13-19`). Worker observability is enabled (`apps/vault-api/wrangler.jsonc:19`), so Cloudflare Workers Logs stores that record outside the DO. Cloudflare documents a maximum log retention of seven days: <https://developers.cloudflare.com/workers/observability/logs/workers-logs/#limits>. SQLite-backed DOs also have point-in-time recovery for the past 30 days: <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api>.

The delete is a hard delete from the active Errors tables, but it is not immediate erasure from logs and recovery history. This affects the rationale at `docs/plans/errors-delete.md:40-47,158-169` and the changelog phrase "for good" at `docs/plans/errors-delete.md:374-377`.

Fix: state the interface narrowly: it removes the active issue row and stored event rows. Remove "for good" and "get this data out of my account" unless log and PITR retention are addressed. Rewrite the changelog from the user's perspective without the internal "projects are just labels" explanation, which also conflicts with the root `AGENTS.md` changelog rule against internal mechanics.

### 2. The confirmation retrofit is scope creep and misses a third existing site

The plan says there are two existing `confirm()` sites and uses that as the reason to retrofit Projects and Keys (`docs/plans/errors-delete.md:241-243,299-303`). There are three:

- `apps/dashboard-web/src/products/vault/pages/ProjectsPage.tsx:39`
- `apps/dashboard-web/src/products/vault/pages/EnvironmentsPage.tsx:46`
- `apps/dashboard-web/src/account/pages/KeysPage.tsx:67`

Leaving Environments unchanged defeats the stated consistency goal. The plan also says Projects and Keys are covered by existing tests (`docs/plans/errors-delete.md:456-458`), but `ProjectsPage.test.tsx` only covers load error and retry. It has no project-delete test. There is no `EnvironmentsPage.test.tsx`.

Fix: drop phase 5 from this task. Keep `ConfirmDialog` because the new irreversible Errors action requires a real confirmation dialog, but defer the Vault/account migration to a separate change with all three sites and complete tests. If the retrofit stays, include Environments and add cancel, confirm, pending, success, and failure tests for all three destructive flows. Replace the acceptance criterion about no `window.confirm`, which is already literally true because current callers use unqualified `confirm()`.

### 3. The proposed dialog interface does not define how async confirmation avoids Radix's immediate close

The plan gives `pending` and says the dialog closes on success, while `onConfirm` returns `void` (`docs/plans/errors-delete.md:258-265,284-287`). Radix `AlertDialog.Action` is a close control. Its documented behavior is to close the dialog: <https://www.radix-ui.com/primitives/docs/components/alert-dialog#action>. A standard shadcn composition therefore closes immediately on click. The pending state is never visible, and a failed request cannot leave the dialog open for retry.

Fix: choose and document one behavior. For success-only close, either make `onConfirm` return `Promise<void>` and let `ConfirmDialog` await it, or prevent the Action's default close and let the caller set `open=false` only after success. Add a deferred-promise test that proves Confirm is disabled while pending, duplicate submits are blocked, failure does not navigate or remove the row, and success closes the dialog.

### 4. The API test plan cannot prove that event rows were deleted or that notification fired again

The plan explicitly says to verify through `getIssue` and `listIssues`, not SQL (`docs/plans/errors-delete.md:348-353`). `getIssue` returns `null` as soon as the issue row is absent, before querying events (`apps/vault-api/src/errors/ErrorsDO/index.ts:187-195`). Orphaned events would therefore be invisible to every proposed assertion.

The re-ingest case only asserts `isNew` and a different id. The promised second "new issue" notification is not asserted, despite an existing `MockNotifier` test seam in `apps/vault-api/src/tests/errors.test.ts:369-421`.

Fix: after delete, use `runInDurableObject` from `cloudflare:test` to query `SELECT COUNT(*) FROM events WHERE issue_id = ?` and require zero. This is an appropriate implementation-level assertion for the storage invariant. In the re-ingest case, inject `MockNotifier` and require two `new` calls, with the second call carrying the recreated id. Keep the org-isolation and both-auth-path cases already in the plan.

### 5. Console coverage omits the detail-page flow and does not explain how toast errors are observed

The acceptance criteria include delete from `IssueDetailPage`, navigation after success, and toast feedback, but phase 6 adds only `IssuesPage.test.tsx` and updates `KeysPage.test.tsx` (`docs/plans/errors-delete.md:331-342,394-397`). There is no current detail-page test.

The proposed page test says it mocks only the Errors client and Clerk, yet a page rendered without `AppLayout` has no Toaster. It cannot find `toast.error(err.message)` in the DOM as written. jsdom can assert dialog role and copy, Cancel focus, Escape, calls, reload, router navigation, and disabled state. It cannot establish visual styling or real-browser focus trapping.

Fix: add `IssueDetailPage.test.tsx` with a real MemoryRouter route and a location probe. Cover cancel, success navigation, and rejected delete. For toast feedback, either render the exported Toaster in the harness or mock the exported `toast` object and assert `success`/`error` calls. Add role, initial Cancel focus, Escape, and deferred-pending assertions to the Issues page test.

### 6. The skill rollout order conflicts with the `zero-skills` repo instructions, and the public route needs explicit public docs

The main repo correctly requires a `zero-skills` update for a new documented endpoint. The external repo adds another rule: verify every endpoint against production before changing the skill (`/home/juan/workspace/juanibiapina/zero-skills/AGENTS.md`). The plan edits the skill in phase 7 and deploys in phase 8 (`docs/plans/errors-delete.md:398-403`), so it cannot perform that production check first.

The planned product docs describe console cleanup, but do not explicitly promise to document `DELETE /errors/v1/issues/:id`, its 204/404 responses, and recreation behavior on the public docs site. The internal design inventory and agent skill are not substitutes for user-facing public interface docs.

Fix: commit code, tests, product docs, and the root changelog together in `zero`; deploy and verify the public route; then update and push `zero-skills` in the same coordinated rollout window. Add the exact DELETE contract to an Errors docs page as well as the skill. Record both repository commits and the production check in the verification note.

## NIT

### 1. "Exactly two tables" should say "two domain tables"

The Errors migration defines only `issues` and `events`, so the data-model conclusion is right. At runtime, `do-orm` also creates `__migrations`: `node_modules/.pnpm/do-orm@https+++codeload.github.com+juanibiapina+do-orm+tar.gz+5094ebcbe8a9717a472e13432c313757f3942f57/node_modules/do-orm/src/migrate.ts:155-159`. Use "two domain tables" to avoid a false literal claim.

### 2. The local verification commands use shell-pipe notation

Commands such as `pnpm --filter @zero/dashboard-web run test | lint | typecheck | build` (`docs/plans/errors-delete.md:343-346`) are not executable shorthand in a shell. They pipe output into commands named `lint`, `typecheck`, and `build`.

Fix: list each command separately or join complete commands with `&&`.

## Round 2

Re-verified against `main` and `origin/main` at
`dc16345bfbd2c17257003d43e7b90cf94f3e8e7d`. The revised plan and this report
remain the only untracked files. The `zero-skills` checkout still matches
`origin/main` at `dbfc25533c9dba13ac61018141434eb08d513449`.

### Verdict

There are no blockers. The original production-data blocker is fixed: the API,
list-row, and detail-page flows now have separate scratch issues. Five
SHOULD-FIX items remain before execution. Two concern the revised async and test
contracts, two concern rollout and production safety, and one is an acceptance
criterion with no implementation step.

### Round 1 findings

| Round 1 finding | Round 2 status |
|---|---|
| BLOCKER: no scratch data remained for the console flows, and the recreated id escaped the listing rule | The missing scratch data is resolved by three issues, one per flow (`docs/plans/errors-delete.md:610-620,652-676`). The recreated issue is re-listed before its successful delete (`docs/plans/errors-delete.md:661-665`). The new absolute id rule still contradicts the repeat-404 check and multi-id cleanup wording. That residual issue is SHOULD-FIX 2 below, not a blocker, because the repeat targets a scratch id already proved absent. |
| SF1: deletion claims ignored Workers Logs and DO PITR | Resolved. The plan now limits the promise to active ZeroErrors read paths and names the 7-day Workers Logs and 30-day PITR retention (`docs/plans/errors-delete.md:54-65,239-246,700-704`). Cloudflare's current Workers Logs limits table says 7 days, and its SQLite storage documentation says PITR can restore any point in the past 30 days. The proposed dialog, docs, and changelog avoid erasure claims. |
| SF2: `confirm()` retrofit was scope creep and missed a third site | The retrofit is removed. All three current sites and line numbers are correct: `ProjectsPage.tsx:39`, `EnvironmentsPage.tsx:46`, and `KeysPage.tsx:67`. The plan leaves them untouched (`docs/plans/errors-delete.md:92-102,331-342`). The claimed filed follow-up is not operationally defined. See SHOULD-FIX 5. |
| SF3: async confirmation did not account for Radix closing Action | Resolved at the `ConfirmDialog` interface. The published `@radix-ui/react-alert-dialog` 1.1.23 tarball implements Action with `DialogPrimitive.Close`; its `@radix-ui/react-dialog` 1.1.23 dependency calls `onOpenChange(false)` after the supplied click handler; `@radix-ui/primitive` 1.1.7 skips that close callback when the event is default-prevented. The plan's `preventDefault`, pending, resolve, and reject behavior is valid (`docs/plans/errors-delete.md:359-378`). Test coverage does not yet cover every promised pending-state behavior. See SHOULD-FIX 4. |
| SF4: server tests could not detect orphaned events or prove a second notification | Resolved. Installed `@cloudflare/vitest-pool-workers` 0.18.5 exports `runInDurableObject` from the runtime `cloudflare:test` module and declares its callback as `(instance, state)` (`node_modules/.pnpm/node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts:24-30`; installed `dist/worker/lib/cloudflare/test.mjs:1-3`). `apps/vault-api/tsconfig.json:4` already includes `@cloudflare/vitest-pool-workers/types`. The revised test queries `state.storage.sql` directly and seeds multiple events (`docs/plans/errors-delete.md:536-543`). `MockNotifier` exists at `apps/vault-api/src/tests/errors.test.ts:364-369`, captures id and kind, and is already injected through `createDashboardApp(typedEnv, { notifier: mock })` at lines 396 and 408. The new assertion is implementable. |
| SF5: no detail-page test and no workable toast assertion | Resolved. The plan adds a routed detail-page test with a location probe and mocks the exported `toast` object (`docs/plans/errors-delete.md:470-512`). `AppLayout` already owns the real Toaster, while page tests can assert the mock without rendering it. |
| SF6: skill shipped before production verification and public docs omitted the route | The skill is now after production verification, and the public docs scope includes the complete DELETE contract (`docs/plans/errors-delete.md:421-462,593-599`). The independent `zero-docs` and `zerovault-api` deployments create a new ordering problem. See SHOULD-FIX 3. |
| NIT1: literal two-table claim | Resolved as "two domain tables," with `__migrations` called out (`docs/plans/errors-delete.md:28-34`). |
| NIT2: invalid shell pipes | Resolved. The local commands are complete commands (`docs/plans/errors-delete.md:516-527`). |

### Verified code and package claims

- `errors-clerk-auth.test.ts` mocks `@clerk/hono` at line 7. Its mock reads
  `X-Test-Clerk-User-Id` and `X-Test-Clerk-Org-Id` at lines 16-17, and its
  existing active-org test sends both at lines 60-61. The Clerk DELETE case is
  in the right file. Its current `request()` helper hardcodes the list URL and
  GET method, so implementation must extend that helper or issue a direct
  `app.fetch` request. This is local test work, not a design problem.
- `runInDurableObject` accepts the typed stub returned by `errorsDO(orgId)` and
  gives the callback the `DurableObjectState` as its second argument. The
  planned direct SQL invariant is supported without a tsconfig change.
- Radix Action closes by default, and `event.preventDefault()` in the supplied
  click handler stops that close for the exact published versions the plan
  names.
- The three `confirm()` line claims match the current files exactly.

## SHOULD-FIX

### 1. `reload()` cannot keep the list dialog open until the list is consistent

The plan says the list's `onConfirm` awaits delete, calls `reload()`, shows the
toast, and therefore closes only after the list is consistent
(`docs/plans/errors-delete.md:399-402`). That does not match the current
`useAsyncData` interface. `reload` returns `void` and only increments a nonce
(`packages/ui/src/hooks/useAsyncData.ts:23,33-35`). The fetch starts later in an
effect (`packages/ui/src/hooks/useAsyncData.ts:37-41`). `onConfirm` therefore
resolves and closes the dialog before the reload has completed.

Fix: keep the existing shallow mutation pattern and state the real behavior:
after DELETE succeeds, trigger `reload()`, show the toast, and close the dialog;
`AsyncState` owns the subsequent loading state. Change the success test to
resolve both the DELETE and the second `listIssues` call, then assert that the
row is gone. Do not change the shared `useAsyncData.reload` interface only to
make this dialog awaitable.

### 2. The production sequence still cannot satisfy its absolute id rule, and it does not prove the key and console use the intended org

The rule says every DELETE targets an id printed by the immediately preceding
listing (`docs/plans/errors-delete.md:610-616`). Step 4 repeats DELETE on
`ID_API` after the preceding list has proved that id absent
(`docs/plans/errors-delete.md:656-660`). That exception is safe, but it violates
the rule. Steps 8 and 10 also permit deleting several ids from one listing
(`docs/plans/errors-delete.md:677-687`), so only the first delete would have an
immediately preceding listing under a literal reading.

The setup says the key is from the dashboard but never calls the existing
`GET /errors/v1/whoami` route or compares its org with the console's active org.
Most scratch operations remain safe because `$P` is fresh. The final
`docs-demo` cleanup intentionally touches persistent production data, so using
a key for the wrong active org is the one path that could delete data outside
the intended org.

Fix:

1. Add a preflight call to `/errors/v1/whoami`, print its `orgId`, and require the
   operator to match it to the console's active organization before POST or
   DELETE.
2. Define the listing rule for successful deletes. Name the repeat-404 request
   as the sole exception: it targets the scratch id that the prior successful
   delete and list proved absent.
3. If a cleanup listing contains more than one row, re-list before each delete
   and select one id whose project and title still match. For `docs-demo`, stop
   unless the listing is exactly the expected demo issue.

With those edits, no successful delete can reach a real issue except the named
`docs-demo` leftover that the operator has explicitly checked.

### 3. Public docs can deploy before the route, and the lockfile makes all four Workers build

Phase 7 puts code and `apps/docs` in one commit, then waits for
`zerovault-api` and `zero-docs` (`docs/plans/errors-delete.md:591-603`). Those
are independent Cloudflare builds. The docs build is package-scoped while the
dashboard Worker builds the monorepo, so the public cleanup command can become
visible before DELETE exists in production. This conflicts with the rollout
reason used to delay `zero-skills`.

Adding `@radix-ui/react-alert-dialog` also changes `pnpm-lock.yaml`. The root
`AGENTS.md` build-watch-path table lists `pnpm-lock.yaml` for all four Workers.
The code push therefore triggers `zero-api`, `zerovault-api`, `zero-landing`,
and `zero-docs`, not only the two builds named in the plan. This matters because
a `zero-api` deployment resets assigned agent Durable Objects.

Fix: use two commits in `zero`.

1. Commit storage, routes, UI, console tests, server tests, the internal design
   note, and the changelog together. Push once, then wait for all four builds
   triggered by the lockfile. This remains the only code deployment.
2. Verify the route and console in production. Then commit and push the public
   `apps/docs` changes, which trigger only `zero-docs`, and update
   `zero-skills` after the same production check.

This split keeps the changelog with the code, prevents docs from leading the
route, and does not cause a second agent Worker deployment. Record both `zero`
commits and the `zero-skills` commit. Shipping phases 1-6 as one commit is not
the right rollout for these independent connectors.

### 4. The tests do not cover the full pending-state contract they claim to cover

The dialog promises that Confirm and Cancel are disabled while pending and that
Escape and overlay close requests are ignored
(`docs/plans/errors-delete.md:365-369`). The Issues test only requires disabled
Confirm and duplicate-submit protection (`docs/plans/errors-delete.md:489-492`).
Escape is tested only before confirmation, and no test requires pending Cancel
to be disabled. The plan then says the two pages exercise the full dialog
contract and that all behavior is covered (`docs/plans/errors-delete.md:509-512,769-773`).

Fix: in the deferred Issues-page test, assert that both Confirm and Cancel are
disabled, press Escape while DELETE is pending, and require the alert dialog to
remain open. Radix Alert Dialog already blocks ordinary outside interaction, so
an artificial overlay click assertion is unnecessary unless the implementation
adds an overlay close path.

### 5. The acceptance criteria require a filed follow-up, but no phase files it

The revised scope correctly defers the three existing `confirm()` migrations,
but says to file a follow-up and later requires that it be filed
(`docs/plans/errors-delete.md:331-342,774-776`). No implementation or shipping
phase names a tracker, command, owner, or recorded URL. An implementer cannot
know how to satisfy this criterion from the plan alone.

Fix: either add a concrete tracker step with the exact issue title and require
its URL in the verification note, or remove "filed" from the plan and acceptance
criteria. Recording the deferred scope in this plan is enough if no tracker is
used.

## NIT

### 1. `list` does not return an empty array

The helper pipes through `jq '.issues[] | {id, project, title, count}'`
(`docs/plans/errors-delete.md:641-644`). With no issues it prints no rows, while
steps 8 and 10 say it returns an empty array.

Fix: use `jq '[.issues[] | {id, project, title, count}]'`, or change the expected
output to no rows. The array form makes exact counts and the final `[]` check
clearer.

### Scope and implementability

Single-issue delete remains the smallest useful product change. Project delete,
event delete, bulk delete, mute, key scoping, and the three old confirmation
migrations should stay deferred. `ConfirmDialog` is warranted because two Errors
page call sites need the same async destructive-action behavior.

After the five SHOULD-FIX edits, the plan is implementable by someone who has
not read this conversation. Storage, route, auth, console behavior, tests,
retention wording, deployment order, and production cleanup will each have an
explicit step and a verifiable result.
