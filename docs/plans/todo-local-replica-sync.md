# Move my todo data to a complete local replica

## Decision

Build the complete signed-in todo model in TinyBase, then move **one existing account** during a planned maintenance window. Pause todo writes, drain known offline queues, copy and verify every server row, and switch the server authority once. There is no need for a generalized per-account rollout system, automatic fleet migration, zero-downtime cutover, or indefinite support for old mobile builds. **Keeping the existing data and any queued work is non-negotiable.** If a device or queued action cannot be accounted for, do not cut over.

After the switch, one `TaskDO` owns the account's Tasks, Projects, manual Waiting conditions, and After relationships, including completed, Done, and resolved records. An account-scoped Expo SQLite TinyBase store holds the phone's complete offline replica. Web REST and server writers use typed `TaskDO` methods. `UserDO` retains conversations, settings, and other non-todo data; its old todo tables remain read-only as a recovery copy. Sign-in stays required. This plan is not authorization to deploy or migrate the account now.

## Starting point and non-negotiable gates

Today real accounts use `UserDO` SQL for todos. Mobile `zero-app.sqlite` is a disposable open-row TanStack cache; `zero-app-outbox-v2.sqlite` holds durable pending REST actions. Web has an IndexedDB outbox. The `listTasks`, `listProjects`, and `listWaitingConditions` methods omit terminal rows and **cannot** be used for migration. The [fixture-only slice](todo-local-replica-task-do-slice1.md) on `feat/taskdo-vertical-slice` proves loose-Task mobile/Worker/REST sync. A subsequent test-only backend slice creates/deletes Projects, files Tasks to Projects, and projects missing/deleted Project links as loose Tasks with a recovery report. A real Worker with two clients proved a late offline child survives deletion and a raw missing-Project Task stays visible; these checks have not proved Worker restart, phone recovery UI, the full relationship model, import, or a real account. The [library investigation](../investigations/todo-sync-libraries.md) records the TinyBase decision. `docs/storage.md` describes what is live, not this target design.

1. **Relationship integrity.** Direct TinyBase sync accepted a Task with a nonexistent Project in the isolated proof. Before the complete model can reach the real account, prove that direct sync, offline edits, and REST cannot create hidden orphans, invalid Afters/cycles, or divergent Project deletion/Done and recurring-Task outcomes. A rejected or conflicting edit stays recoverable and visible. Test the real synchronizer with a raw client, not just the mobile adapter. Try durable Project tombstones and deterministic, visible recovery projections for invalid relations before replacing TinyBase; the [local merge experiment](../../spikes/tinybase/scripts/relation-projection-proof.ts) supports this direction, while the [middleware experiment](../../spikes/tinybase/scripts/middleware-proof.ts) shows that store-level rejection alone does not prevent peer relay. If no representation passes these tests without a custom sync protocol, stop and ask for a new decision.
2. **No split authority.** The new `TaskDO` module owns validation, domain transitions, persistence, and a typed interface for REST/server writers. The authenticated WebSocket modifies the same dataset. No switched-account write may reach `UserDO` todo SQL. Mobile screens select the legacy REST/outbox adapter or the complete TinyBase adapter at one signed-in data seam, never one per screen. A TanStack screen projection may be disposable but cannot be another durable store.
3. **No lost personal data.** Preserve IDs and every Task field (dates, recurrence/cursor, project, source capture, sort key), every Project field, all manual Waiting/After rows, and terminal rows. Preserve or explicitly resolve each pending mobile/web outbox action **before** freezing the old authority. Keep a verified recovery copy of the old server data and old phone files until the new path has passed restart and sync checks. Do not silently repair preexisting invalid references or delete unreadable transactions.

Relevant source: `apps/agent-api/src/{UserDO/index.ts,TaskDO/index.ts,routes/{tasks,projects,waits,task-sync,user-settings}.ts,store/{tasks,projects,waiting-conditions,project-afters}.ts,do/purge.ts}`, `packages/agent-core/src/collection/`, `apps/agent-mobile/src/{lib/{db,entity-api,taskdo-replica}.ts,app/(signed-in)/}`, and `apps/agent-web/src/lib/`.

## Implementation and proof, in order

### 1. The fixture handles every todo verb safely

Extend the fixture `TaskDO` store to the full model. Preserve the current REST shapes and domain behavior: Project deletion removes its Tasks and both directions of After relationships, Project Done settles Afters and reopening restores them, and recurring completion/Undo advances/restores one cursor exactly once. Keep complete records in the replica; Home, Projects, Browse/Upcoming, Undo, launcher count, and day rollover continue to show their existing open subsets. Use one TinyBase adapter behind the existing `TasksApi`/`ProjectsApi`/`WaitsApi` screen interfaces rather than a separate fixture path on each screen. Keep normal accounts on the legacy path.

**Exit:** real-Worker tests with two independent clients and REST cover every verb, terminal bootstrap, invalid raw sync, offline Project deletion versus a late Task, same-cell edits, recurrence retries, socket/Worker restart, and a recoverable conflict. Behavior-named hermetic Pixel flows cover the complete screen path and offline restart. No fixture todo write reaches `UserDO`.

### 2. A one-account migration can be rehearsed and restarted

Implement a small, authenticated, operator-invoked migration path rather than a cohort rollout system. `UserDO` stores a durable `legacy`/`frozen`/`switched` marker. Every legacy mutating method checks it, not just its HTTP route: a request that read routing state before the freeze must not write afterward. While frozen, todo writes fail visibly/retry; do not accept them into either store. Take a consistent internal SQL snapshot of **all** legacy todo rows, not the open-list methods. If the snapshot is too large for one RPC, page it while the source stays frozen. Validate existing references and capture field-by-field counts/checksums; stop for explicit repair if any row is invalid.

Import into an inaccessible `TaskDO` with stable IDs and an import generation. Make the copy retryable without duplication; compare all rows, relations, terminal states, and selected REST views to the frozen source. Only then mark the destination ready and record `switched` in `UserDO`. Routes check this marker and send all todo reads/writes to `TaskDO`; old `UserDO` todo methods remain fenced. A crash before switching permits retry or discarding the incomplete destination and unfreezing the unchanged source. A crash after destination activation rolls forward to the switch marker, never unfreezes a competing authority. There is no cross-DO transaction.

**Exit:** a disposable account with realistic terminal rows survives kills before/during import and between destination activation and the switch marker; each restart yields one complete authority and no lost acknowledged write. An old REST caller still reaches `TaskDO` after switching. A second account cannot read the first account's data.

### 3. Known devices and web tabs have no unaccounted queued work

Before the real freeze, inventory every phone installation and browser profile/tab that may contain offline actions. Bring each online on the **old** REST path, inspect and drain its complete outbox, and confirm the resulting server records. Mobile `tx:` entries have a verb name and mutation but no dependable account ID; one collection's pending count does not cover the whole file. Unknown, corrupt, or unattributable entries require manual inspection/recovery and block cutover. Keep the original SQLite/IndexedDB data available until verification. Close or upgrade old clients after draining; do not rely on them never reconnecting by accident. Continue routing legacy REST to `TaskDO` during the transition, but do not promise that an unversioned old edit racing a new replica edit can be automatically reconciled.

**Exit:** document the inspected device/browser inventory, the queue count for each, any resolved actions, and a matching server read. Rehearse an offline queued action, a lost response, and a force-stop before and after draining. If the inventory is incomplete, stay on the old system.

### 4. Freeze, copy, switch, and bootstrap the real account

Schedule a short period with no todo editing. Deploy the prepared Worker first with the real account still on `UserDO`. Perform step 3, freeze writes, export/verify the complete source, copy to `TaskDO`, compare, and switch the server. Keep the frozen `UserDO` tables for recovery. Start the updated phone online, load and verify the complete account-scoped local dataset, then enable the new adapter on **all** signed-in screens. Do not display an empty new store as if it were an empty account. A bootstrapped phone can subsequently cold-start and edit offline; each action reports success only after Expo SQLite persistence. Errors leave data visible and recoverable. Keep the old phone files until offline restart, reconnect, REST, and server comparison pass.

**Exit:** the real account's counts and representative records match across frozen source, `TaskDO`, phone, and REST; completed/Done/resolved records remain on the phone. Create/edit/complete offline, force-stop, reopen offline, reconnect, and observe the same changes via REST. A web edit appears on the phone. Auth expiry or account change cannot display or upload the prior account's local file. A second test client verifies convergence without migrating a second real user.

### 5. Recovery and release stay on the new authority

Before the server switch, recovery is to abandon the dark import and unfreeze the original `UserDO`. **After the switch, never roll back to the frozen old tables:** new offline or REST writes exist only in `TaskDO`. Roll back the mobile UI to a REST adapter **backed by `TaskDO`** if necessary; keep its binding, routes, and data intact. A reverse data migration would need its own freeze and verified export. Test this rollback with a pending phone edit. Update account erasure so it fences sync, closes sockets, removes both old and new data, and retains a deletion marker; an old offline replica cannot repopulate an erased account. Test interrupted deletion and explicit fresh reenrollment.

Run `gob run bin/ci`; on this NixOS host use touched-package tests/lint/typecheck/build and deploy dry-run plus Podman-backed `pnpm --filter @zero/agent-mobile e2e:pixel` when host `workerd` fails. Stop Metro/Gradle before checks on `mini`. Verify the standalone preview APK on a **separate** device and its EAS Update/native fingerprint behavior per `docs/mobile-releases.md`; build natively **locally** unless explicitly asked otherwise. Do not install that APK on the USB Pixel. Update `docs/storage.md` only when live storage changes, plus `docs/todo-app.md`, entity docs, and the mobile README. Include the user-visible mobile bullet in `apps/agent-mobile/CHANGELOG.md` in the shipping change; add an agent changelog bullet only if agent users observe a change. Do not push, deploy, or switch the account merely because this plan exists.

## Deliberately omitted

No automatic onboarding/migration for other real accounts, staged cohorts, indefinite compatibility window for abandoned old APKs, or zero-downtime handoff. Those require a separate plan if the product gains users. Optional sign-in, guest mode, web local-first storage, history/search UI, and online agent todo tools also remain later work. RxDB stays excluded; changing sync libraries or inventing a protocol needs an explicit decision.

## Skills during implementation

- `vocabulary`, `deep-modules` — keep the authority and mobile-data interfaces small and test through them.
- `cloudflare`, `testing`, `reproducible-locally` — prove DO fencing, restart, sync, and data parity.
- `expo-overview`, `expo-data-fetching`, `expo-router`, `expo-ui` — implement the account-scoped offline phone path.
- `eas-app-stores` — check native release compatibility while following the local-build policy.
- `documentation`, `changelog` — update the live storage description and shipping notes together.
- `git-commit` — use only if explicitly asked to commit.
