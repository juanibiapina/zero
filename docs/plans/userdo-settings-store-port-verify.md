# Verification: Move UserDO settings/link/idempotency behind the `Store` port

Reviewed plan: `docs/plans/userdo-settings-store-port.md`.
Verdict: **GO** (address concern C1 before/while implementing). No blockers.

Counts: **0 blockers, 2 concerns, 4 nits.**

Evidence base: read `store/{types,db,memory,system-topics}.ts`,
`store/{store-contract,system-topics}.test.ts`, `UserDO/index.ts`,
`UserDO/db/schema.ts`, `routes/user-settings.test.ts`, `routes/admin.ts`,
`routes/admin.test.ts`, and the do-orm source (`db.ts` `insert`/`update`/
`buildInsert`).

---

## 1. SQL / behavior preservation — PASS (no drift)

Checked each moved method against the do-orm implementation, not just the call
site. The two spots where the refactor's SQL text differs from the current text
both collapse to identical stored state because of how do-orm builds queries:

**Empty-patch update.** Current `updateSettings({})` builds an empty `updates`
object and calls `this.db.update(userSettings, {}, {where})`. do-orm's `update`
(`db.ts:143`):

```js
const entries = Object.entries(values).filter(([, v]) => v !== undefined);
if (entries.length === 0) return;   // no SQL emitted
```

So the current empty update already **no-ops** (emits no SQL). The plan's new
`upsertSettings` guards with `if (Object.keys(columns).length > 0) update(...)`.
Same effect: no SQL. Identical.

**Undefined timezone on insert.** Current `updateSettings` insert branch passes
`timezone: patch.timezone` (possibly `undefined`). do-orm's `buildInsert`
(`db.ts:234`) does **not** filter undefined, so it emits
`INSERT ... ("onboardingSeen","timezone","createdAt") VALUES (?,?,?)` binding
`undefined` → NULL. The plan's helper omits the `timezone` column entirely, so
the nullable column defaults to NULL. Same stored value (NULL). The new form is
also strictly safer (never binds `undefined`).

Everything else copies verbatim: same table objects, same `eq("id", …)`
predicates, `onboardingSeen ? 1 : 0`, `!!row.onboardingSeen`, `?? null`
mappings, and `new Date().toISOString()` → the equivalent `this.nowIso()`.
The `upsertSettings({ onboardingSeen: 0, createdAt, ...columns })` spread
reproduces each writer's insert defaults exactly:

- `setGoogleOnboardingStatus` (no row): current inserts
  `{onboardingSeen:0, googleOnboardingStatus:status, createdAt}`; helper yields
  the same via `upsertSettings({googleOnboardingStatus:status})`.
- `getSettings` seed (no row): current inserts `{onboardingSeen:0, createdAt}`;
  helper `upsertSettings({})` yields the same.

The **googleOnboardingStatus** field is a plain nullable text column; no default,
no coercion. Reads map `row.googleOnboardingStatus ?? null`. Preserved.

Conclusion: no `INSERT OR REPLACE`, no on-conflict merge, no timestamp drift, no
null-handling change. SQL semantics preserved.

## 2. R2 purge split — SAFE

Current `unlinkTelegram` (`UserDO/index.ts:220`): get row → if none return
`{removed:null}` → delete row → get `clerkUserId` → `attachments.deleteAllForUser`
→ return `{removed: existing.telegramId}`. The plan moves only the row
get+delete into `store.unlinkTelegram()` (sync, returns `{removed}`) and keeps
the R2 teardown in the DO wrapper guarded by `if (removed)`.

- **Ordering preserved:** the store call (row delete) runs to completion
  synchronously before the DO does the R2 purge, same as today.
- **Atomicity unchanged:** R2 was never in a transaction with the SQLite delete
  (separate system, async), so nothing regresses.
- **Guard equivalence:** `telegramId` is `notNull().unique()`
  (`schema.ts:telegramLink`), so `removed` is a non-empty string exactly when the
  old `existing` was truthy. `if (removed)` ≡ old `if (existing)`.
- **No other consumer of the combined behavior:** only caller is
  `routes/user-settings.ts:123`, which uses `{removed}` only. `routes/admin.ts`
  does not call unlink.

## 3. SystemTopicStore pass-throughs — COMPLETE (all 7 enumerated)

`SettingsStore` adds exactly 7 methods; the plan lists all 7 as `this.inner`
delegates:

1. `getSettings`
2. `updateSettings`
3. `setGoogleOnboardingStatus`
4. `getTelegramId`
5. `linkTelegram`
6. `unlinkTelegram`
7. `markProcessed`

None missing. `SystemTopicStore implements Store`, so a forgotten delegate is a
**typecheck** failure (not a silent runtime throw as the plan says — see nit N3),
but the requirement is met either way.

## 4. Deleting `index.test.ts` — NO COVERAGE LOST (coverage improves)

`index.test.ts` builds a hand-rolled `createFakeUserDO()` that **reimplements**
the settings/link logic inline and then asserts against that fake. It exercises
zero production code — confirmed: the fake's `getSettings`/`linkTelegram`/etc.
are fresh closures, not `UserDO` or `DbStore`/`MemoryStore`. Low value by
construction.

Assertion-by-assertion mapping to the new contract test (which runs the **real**
`MemoryStore`):

| index.test.ts assertion | New home (store-contract.test.ts) |
|---|---|
| getTelegramId null when unlinked | telegram-link block |
| linkTelegram returns `{previous:null}`, round-trips | telegram-link block |
| re-link returns previous id | telegram-link block |
| unlinkTelegram clears + returns removed | telegram-link block |
| unlinkTelegram on empty → `{removed:null}` | telegram-link block |
| getSettings isNewUser true first access (+ defaults) | settings block |
| getSettings isNewUser false subsequent | settings block |
| updateSettings sets onboardingSeen true | settings block |
| updateSettings reset to false | settings block |
| updateSettings({}) no-op | settings block |
| setGoogleOnboardingStatus visible via getSettings | settings block |

Every assertion is reproduced, now against real code, plus a **new** idempotency
block for `markProcessed` (which `index.test.ts` never covered). Deletion is
sound.

## 5. RPC honesty — PASS

The 6 externally-called methods keep their exact names and stay public:
`getTelegramId`, `linkTelegram`, `unlinkTelegram`, `getSettings`,
`updateSettings`, `setGoogleOnboardingStatus`. Grep confirms callers:
`routes/user-settings.ts` (all six via the settings/link routes) and
`routes/admin.ts:105-106` (`getTelegramId`, `getSettings` only).

`routes/user-settings.test.ts` and `routes/admin.test.ts` stub via
`Pick<UserDO, …>` over these names and `await` each call; names/signatures are
unchanged, so they stay green with no edits. `markProcessed` has no route test
reference; moving it private→store touches nothing external. Only internal caller
is `enqueueTurn` (`UserDO/index.ts:97`), which switches to
`this.store.markProcessed`.

## 6. "No schema/migration change" — TRUE

`telegram_link`, `user_settings`, `processed_updates` are already defined in
`UserDO/db/schema.ts` and created by existing migrations, confirmed on disk:
`0003_user_settings.sql`, `0004_rename_onboarding_seen.sql`,
`0009_google_onboarding_status.sql`, `0010_user_created_at.sql`,
`0016_processed_updates.sql`, `0017_user_timezone.sql` (all present in
`UserDO/db/migrations/` and imported in `migrations.ts`). Grep confirms the three
table objects are referenced **only** in `schema.ts` and `UserDO/index.ts` — the
move relocates access without touching any definition. No new migration.

## 7. Changelog — CORRECT (none)

Purely internal refactor: identical stored state, unchanged RPC signatures,
unchanged routes, no user-observable change. Per AGENTS.md, refactors get no
entry. Correct.

---

## Concerns

**C1 (concern) — `getSettings` seed must reuse the written `createdAt`, not
re-generate it.** The plan offers two options for the seed path: "Re-read once
after seeding, **or reconstruct from the known defaults**." For `createdAt` the
"reconstruct" option is wrong: `upsertSettings({})` generates the timestamp
internally via `this.nowIso()`; if `getSettings` then reconstructs the return
with its **own** `nowIso()`, `DbStore` returns a `createdAt` that differs from the
row it just wrote (two clock reads under a real clock). The current code returns
the exact value it inserted. The fixed-clock `MemoryStore` in the contract test
(`() => "2026-01-01T00:00:00.000Z"`) makes both reads equal, so the suite would
**not** catch this drift off-workerd.
Fix: mandate that the seed path returns the timestamp actually written — either
re-read the row after `upsertSettings`, or have `upsertSettings` return the
`createdAt` it used — and drop the "reconstruct" wording for `createdAt`.

**C2 (concern) — `getSettings` seed is a read that writes; only `MemoryStore`
proves it off-workerd.** `getSettings` mutates on first access (seeds the row),
and the contract suite runs `MemoryStore` only; `DbStore`'s real do-orm seed is
exercised solely in the workerd-backed CI run. This matches the existing design
(topics/conversations are verified the same way), so it is acceptable, but the
plan should say plainly that the seed-on-read insert for `DbStore` is proven only
in CI, and keep the `MemoryStore` seed insert byte-for-byte aligned with
`DbStore`'s (same default columns) so the contract test is a faithful proxy.

## Nits

**N1** — The plan overstates the caller set: it says `linkTelegram`,
`unlinkTelegram`, and `updateSettings` are called by `routes/admin.ts`. Grep
shows `admin.ts` calls only `getTelegramId` and `getSettings`
(`admin.ts:105-106`); the write methods are `routes/user-settings.ts` only. Does
not change the conclusion (all six stay public because user-settings needs them),
but the "external callers" list should be corrected.

**N2** — The "identical SQL" phrasing in the Preservation section is slightly too
strong: the emitted SQL text differs for the empty-patch update and the
undefined-timezone insert. Both converge to identical stored state via do-orm
(filters undefined, early-returns on empty). Add a one-line note so a future
reader who diffs the raw SQL is not surprised.

**N3** — The plan calls a missing `SystemTopicStore` pass-through "a runtime
blocker — would throw." Because the class declares `implements Store`, a missing
method is caught at **typecheck**, not runtime. Harmless framing issue.

**N4** — After the move, `UserDO/index.ts` will have unused imports (`eq`, and
the three table objects `telegramLink`/`userSettings`/`processedUpdates`). Lint
will flag them; the plan should note they must be removed in commit 2. `this.db`
and `createDb` stay (needed for `new DbStore(this.db)`).

---

## Bottom line

The refactor preserves SQL semantics (verified against do-orm internals),
enumerates all 7 pass-throughs, loses no test coverage (the deleted test only
exercised a fake; the contract test covers the same behavior against real code
and adds idempotency), keeps the RPC surface honest, and correctly claims no
schema/migration/changelog change. **GO**, provided C1 is applied so `DbStore`'s
seeded `getSettings().createdAt` equals the value it wrote.
