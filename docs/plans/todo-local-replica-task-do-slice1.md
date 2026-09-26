# Slice 1: one loose Task end to end through TaskDO

## Recommendation

Prove the **real mobile-to-server-to-web path** for a fresh, isolated test account: create a loose Task on the phone while offline, force-stop and reopen the app, reconnect, and read or edit that Task through the existing web REST route. A web REST write must also appear on the phone. Use a new `TaskDO` in the existing `zero-api` Worker and TinyBase persistence in the **actual mobile app**, not just the standalone spike. Gate the entire path to fixture accounts under `ENVIRONMENT=test`; ordinary production accounts keep their current `UserDO` and mobile cache/outbox path.

This is vertical because one Task has one durable write path across a screen, mobile SQLite, TinyBase sync, Cloudflare SQLite, and the web-facing REST route. It is deliberately **only a loose Task** (`projectId: null`, no recurrence). The [archived isolated proof](https://github.com/juanibiapina/zero/blob/a7c78c39e8b82e1340bfc6956940a9d9fdc167d3/spikes/tinybase/README.md) found that direct sync can create a Task referring to a missing Project; do not expose Project relationships until that invariant has a tested solution.

## Where data lives

| Stage | Account todo data | Mobile data | Web and other writers |
| --- | --- | --- | --- |
| Today, for real accounts | `UserDO` SQLite tables are authoritative. | `zero-app.sqlite` is an open-row cache; `zero-app-outbox-v2.sqlite` holds pending REST writes. | Existing REST routes call `UserDO`. |
| This slice, **fixture account only** | `TaskDO` holds the loose Task in a TinyBase `MergeableStore`, persisted in that DO's SQLite. Its `UserDO` todo tables must stay empty and unwritable for this fixture. | A separate, account-scoped Expo SQLite file persists the TinyBase `MergeableStore`; any TanStack data needed by the existing Home screen is a **disposable projection**, not another durable write store. | The existing Task REST route branches to `TaskDO` for this fixture. Project and Waiting writes fail closed; reads required by Home return empty sets, not rows from `UserDO`. |
| After the full migration, for every account | One per-account `TaskDO` holds **Tasks, Projects, manual Waiting conditions, and After relationships**, including terminal rows, with TinyBase merge metadata in DO SQLite. `UserDO` retains agent conversations and other non-todo state, not a writable todo copy. | An account-scoped Expo SQLite TinyBase store holds the **complete** synced todo dataset; offline edits persist there first and converge with `TaskDO`. The legacy mobile cache/outbox remains until pending actions are safely replayed or translated, then is retired. | Web REST and server todo writers mutate the **same TaskDO store** via typed RPC/domain methods. Existing web IndexedDB outbox requests continue through compatible REST routes until drained; the web does not need a TinyBase client. |

This is one convergent account dataset with local offline replicas, not two independently writable server stores. Moving existing accounts later requires a per-account write fence, complete import (including terminal rows), compatible handling of old outbox requests, and a recoverable handoff. Cloudflare offers no transaction across `UserDO` and `TaskDO`. **This slice does not migrate an existing account or claim that handoff is solved.** The [overall plan](todo-local-replica-sync.md) retains that gate.

## Future online agent sessions

Sessions stay in `UserDO`; the online session screen does not need an offline transcript. Today `getUserDO(env, clerkUserId)` calls `env.USER_DO.idFromName(clerkUserId)` and then `env.USER_DO.get(id)`. A future tool running in `UserDO` can do exactly the same with `TASK_DO`:

```ts
const id = this.env.TASK_DO.idFromName(clerkUserId);
const tasks = this.env.TASK_DO.get(id);
await tasks.addTask(/* validated Task intent */);
```

`idFromName` computes the DO ID; it is **not** a database lookup. `get` creates a stub. The awaited RPC call is the cross-DO hop. No KV mapping is needed between `UserDO` and `TaskDO`. The KV mapping used by Telegram converts a **Telegram account ID to a Clerk user ID** before the Worker looks up `UserDO`. Both DO namespaces can use that same Clerk user ID independently. The tool must refuse a missing Clerk ID, never use the current `"unknown"` logging fallback.

`TaskDO` owns the todo read/write methods used by both REST routes and future tools. A TaskDO write persists to its TinyBase store and syncs to the phone; TaskDO never calls back into UserDO. Later, task-writing tools must make resumed calls retry-safe and handle stale reads or offline edits. The current tool runner does not pass its persisted tool-call ID to `execute`, so that needs a separate tool change when sessions gain todo writes. **No agent-session or todo-tool implementation belongs to slice 1.**

## Why start here

1. **The user path is demonstrable.** The phone can create a Task offline; a second writer can see and change it through the existing REST interface. Dormant bindings alone would not prove this.
2. **The scope contains, but does not solve, the integrity failure.** The test only exercises loose Tasks, which need no Project/After reference. REST Project/Waiting writes fail closed for the fixture. TinyBase's direct sync can still accept arbitrary cells: keep that behavior confined to disposable test accounts and prove a separate integrity design before any real user connects.
3. **Real accounts remain safe.** The test gate covers mobile selection, WebSocket access, REST routing, and account purge. The fixture starts empty; no import, dual-write, or production fallback to a second authority occurs.

## Implementation

1. **The server owns the fixture Task.** Add TinyBase to `@zero/agent-api`; implement and export `TaskDO` with `WsServerDurableObject`, `MergeableStore`, and a fragmented DO SQLite persister. Bind `TASK_DO` with a new append-only SQLite-class migration in `wrangler.jsonc`, `wrangler.test.jsonc`, and `wrangler.e2e.jsonc` (the test migration histories differ); regenerate `worker-configuration.d.ts`. Gate `/api/task-sync` behind the existing `/api/*` guard and `ENVIRONMENT=test` plus a dedicated fixture identity; derive the DO ID solely from the guard's `userId`. The test bearer bypass is **not** proof of Clerk verification. Production sessions cannot reach this sync route. Add TaskDO purge/reset to `DELETE /api/user-data`, including active-socket/restart tests so auto-save cannot resurrect erased data.
2. **One Task reaches both writers.** For the fixture only, route existing Task create/read/edit operations through typed `TaskDO` query and command RPC methods that mutate its **same** TinyBase store as WebSocket sync; these methods must not depend on HTTP or agent-session internals. Preserve the REST response shape and idempotent client-minted IDs. For this fixture reject unsupported Task mutations rather than sending them to `UserDO`; allow only `projectId: null` and no recurrence. Block Project and Waiting REST mutations for the fixture and provide empty reads needed by Home without consulting `UserDO`. This does not restrict direct WebSocket cells; test that known limitation separately. Existing routes still call `UserDO` for all other accounts. Test both REST → WebSocket and WebSocket → REST against the real Worker.
3. **The phone uses its own durable replica.** Inside the actual mobile signed-in tree under the hermetic test profile and fixture identity, back the Home loose-Task path with an account-scoped TinyBase `MergeableStore` and Expo SQLite JSON persister. Persist a local edit before showing success, then synchronize over the authenticated Worker route. Preserve the existing Home UI through a `TasksApi` adapter or a derived, non-persisted TanStack projection; do not instantiate the old Task cache/outbox for this fixture or keep two writable local Task stores. No production mobile account selects this path. Test the production app's exact SDK/React dependency set, not only the standalone Expo Go spike.

## Exit proof and stop conditions

Use a hermetic Pixel flow and a local Worker in rootless Podman: start with a fresh fixture account; create a loose Task offline in Home; force-stop and reopen while offline; reconnect and confirm it through the existing `/api/tasks` REST read; edit it through REST and observe Home update. Repeat with a second client; invoke a TaskDO command directly from a server-side test caller and observe the change on the phone and through REST; restart the Worker; show account B cannot read it. Assert that Task and Project/Waiting writes for this fixture never reach `UserDO`, unsupported fixture writes fail closed, and an ordinary production-mode request cannot reach `TaskDO`. Delete fixture account data with a live socket; reconnect and verify it stays erased. A native persistence failure must be visible, not silently fall back to memory.

Stop if the phone only works in the standalone spike, if fixture writes split across `UserDO` and `TaskDO`, if offline edits vanish, or if deletion resurrects them. Project-linked Tasks, Waiting, After, recurrence, existing-user bootstrap, legacy outbox migration, and production cutover are **later slices**. The fixture path is internal, so it has no user-facing changelog entry; change `docs/storage.md` when the real storage authority moves. Run `gob run bin/ci`; on the documented NixOS host-`workerd` failure, run touched-package checks, Worker dry-run, and the Podman/Pixel proof separately.

## Skills for implementation

- `cloudflare` — DO migration, authenticated WebSocket routing, persistence, and erasure.
- `expo-overview`, `expo-data-fetching`, `testing` — native durable writes and a hermetic Pixel proof.
- `vocabulary`, `deep-modules` — keep the Task data interface and disposable UI projection distinct.
- `documentation` — keep the target storage map here until it ships; `docs/storage.md` describes the current live path.
