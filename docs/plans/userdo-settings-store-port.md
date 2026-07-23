# Move UserDO settings / telegram-link / idempotency tables behind the `Store` port

## Goal

The UserDO settings, telegram-link, and idempotency tables use raw do-orm
directly inside the DO, which makes them untestable without workerd (the dev box
can't run workerd). Topics and conversations already go through the tested
`Store` port. Move these three tables behind the `Store` port using the SAME
pattern as topics/conversations, so they become testable off-workerd, and
collapse the 3x insert-or-update duplication into one shared helper. Behavior
must be preserved exactly (identical SQL semantics).

## Context / current state

`apps/agent-api/src/UserDO/index.ts` holds real per-user persistence logic that
talks to do-orm (`this.db`) directly against three tables defined in
`UserDO/db/schema.ts`:

- `telegram_link` (`telegramLink`): a single row holding the linked Telegram id.
- `user_settings` (`userSettings`): one row per user, columns `onboardingSeen`
  (int 0/1), `googleOnboardingStatus` (nullable text), `createdAt` (text),
  `timezone` (nullable text).
- `processed_updates` (`processedUpdates`): webhook idempotency, PK `updateId`.

Everything else the DO persists (topics, conversations, messages, attachments)
already goes through the `Store` port. The port is the template to copy:

- **Interface:** `store/types.ts` — `Store = TopicStore & ConversationStore &
  AttachmentRecordStore`. Each sub-interface is a small flat set of methods.
- **Prod adapter:** `store/db.ts` `DbStore implements Store` — do-orm over DO
  SQLite. Column names are the camelCase schema keys. Uses a private
  `nowIso()` for timestamps.
- **Test adapter:** `store/memory.ts` `MemoryStore implements Store` — in-memory,
  constructor takes an injectable `now: () => string` (fixed clock in tests).
- **Decorator:** `store/system-topics.ts` `SystemTopicStore implements Store` —
  wraps an inner `Store` and **explicitly delegates every method** to
  `this.inner`. The DO's `this.store` is `new SystemTopicStore(new DbStore(this.db))`.
- **Contract test:** `store/store-contract.test.ts` — runs the behavioral suite
  against `MemoryStore` with a fixed clock (`() => "2026-01-01T00:00:00.000Z"`).
  This is what makes the agent/orchestrator unit tests trustworthy.

This is the local-substitutable dependency category (deep-modules): the
`MemoryStore` stand-in already exists, so the seam is internal and needs **no
new port type**, just new methods on the existing `Store`.

## Findings

### Current raw do-orm usage (exact semantics to preserve)

All in `UserDO/index.ts`. Copy each verbatim into `DbStore`.

**Idempotency — `markProcessed(updateId): boolean`** (currently a *private* DO
method, only caller is `enqueueTurn`):

```ts
const existing = this.db.get(processedUpdates, { where: eq("updateId", updateId) });
if (existing) return false;
this.db.insert(processedUpdates, { updateId, createdAt: new Date().toISOString() });
return true;
```

**Telegram link:**

```ts
getTelegramId(): string | null {
  const row = this.db.get(telegramLink);
  return row?.telegramId ?? null;
}

linkTelegram(telegramId): { previous: string | null } {
  const existing = this.db.get(telegramLink);
  const previous = existing?.telegramId ?? null;
  if (existing) this.db.update(telegramLink, { telegramId }, { where: eq("id", existing.id) });
  else this.db.insert(telegramLink, { telegramId });
  return { previous };
}

unlinkTelegram(): { removed } {
  const existing = this.db.get(telegramLink);
  if (!existing) return { removed: null };
  this.db.delete(telegramLink, { where: eq("id", existing.id) });
  // ...then purges the user's R2 attachments (see below)
  return { removed: existing.telegramId };
}
```

Note: `unlinkTelegram` also calls `this.attachments.deleteAllForUser(clerkUserId)`
(R2). That is an account-teardown side effect, **not** a store concern, and R2
is a different port. It **stays in the DO** (see delegate changes).

**Settings — the 3x insert-or-update duplication:**

```ts
getSettings(): { onboardingSeen; googleOnboardingStatus; createdAt; timezone; isNewUser } {
  const row = this.db.get(userSettings);
  if (!row) {
    const createdAt = new Date().toISOString();
    this.db.insert(userSettings, { onboardingSeen: 0, createdAt });
    return { onboardingSeen: false, googleOnboardingStatus: null, createdAt, timezone: null, isNewUser: true };
  }
  return { onboardingSeen: !!row.onboardingSeen, googleOnboardingStatus: row.googleOnboardingStatus ?? null,
           createdAt: row.createdAt ?? null, timezone: row.timezone ?? null, isNewUser: false };
}

updateSettings(patch: { onboardingSeen?: boolean; timezone?: string }): void {
  const existing = this.db.get(userSettings);
  if (existing) {
    const updates: Record<string, number | string> = {};
    if (patch.onboardingSeen !== undefined) updates.onboardingSeen = patch.onboardingSeen ? 1 : 0;
    if (patch.timezone !== undefined) updates.timezone = patch.timezone;
    this.db.update(userSettings, updates, { where: eq("id", existing.id) });
  } else {
    this.db.insert(userSettings, { onboardingSeen: patch.onboardingSeen ? 1 : 0, timezone: patch.timezone, createdAt: new Date().toISOString() });
  }
}

setGoogleOnboardingStatus(status: string): void {
  const existing = this.db.get(userSettings);
  if (existing) this.db.update(userSettings, { googleOnboardingStatus: status }, { where: eq("id", existing.id) });
  else this.db.insert(userSettings, { onboardingSeen: 0, googleOnboardingStatus: status, createdAt: new Date().toISOString() });
}
```

The three spots repeat "get single row; if exists update chosen columns; else
insert with defaults + chosen columns". This is the target for the shared upsert
helper. `getSettings`'s only extra is that it reports `isNewUser` (true iff it
had to seed the row) and maps nullable columns.

### External callers (RPC surface that must stay)

Grep of the whole worker: these DO methods have real route/admin callers, so
they stay as public RPC that now **delegate to `this.store`**:

- `getTelegramId`, `linkTelegram`, `unlinkTelegram` — `routes/user-settings.ts`.
  Of these, `routes/admin.ts` calls only `getTelegramId` (see below).
- `getSettings`, `updateSettings` — `routes/user-settings.ts`. `routes/admin.ts`
  calls only `getSettings`.

`routes/admin.ts` (around lines 105-106) calls only `getTelegramId` and
`getSettings`; the write methods (`linkTelegram`, `unlinkTelegram`,
`updateSettings`, `setGoogleOnboardingStatus`) are **not** called there. This
does not change the conclusion — all six stay public because
`routes/user-settings.ts` needs them.
- `setGoogleOnboardingStatus` — no *external* caller, but finding #1 deliberately
  left it public for this task; keep it public and delegate. Internal callers:
  `runOnboarding`, `queueOnboarding`, `alarm`.

`markProcessed` is **not** RPC (private, single internal caller). It becomes a
`Store` method and the DO's private method is deleted; `enqueueTurn` calls
`this.store.markProcessed` directly (same as it already calls
`this.store.getOrCreateConversation`).

Do **not** recreate dead surface: only the six externally-called methods keep a
public delegate; `markProcessed` moves fully into the store.

### Schema / migration story

No change. `telegram_link`, `user_settings`, `processed_updates` are already
defined in `UserDO/db/schema.ts` and created by existing migrations
(`0003_user_settings`, `0004_rename_onboarding_seen`, `0009_google_onboarding_status`,
`0010_user_created_at`, `0016_processed_updates`, `0017_user_timezone`). Moving
access behind the port only relocates the read/write calls; it touches no table
definition and adds no migration. `DbStore` imports these three table objects
the same way it already imports `topics`/`conversations`/`messages`/`attachments`.

## Design

### New `Store` interface additions (`store/types.ts`)

Add one sub-interface and fold it into the `Store` union, mirroring the existing
style. Reuse the exact return shapes the DO already exposes so the delegates are
one-liners.

```ts
export interface UserSettings {
  onboardingSeen: boolean;
  googleOnboardingStatus: string | null;
  createdAt: string | null;
  timezone: string | null;
  // True only on the access that seeded the row (first-ever getSettings).
  isNewUser: boolean;
}

// Per-user identity, settings, and webhook idempotency. Single-row tables
// (telegram_link, user_settings) plus the processed_updates dedupe log.
export interface SettingsStore {
  // Seeds the settings row on first access; isNewUser is true only then.
  getSettings(): UserSettings;
  updateSettings(patch: { onboardingSeen?: boolean; timezone?: string }): void;
  setGoogleOnboardingStatus(status: string): void;

  getTelegramId(): string | null;
  linkTelegram(telegramId: string): { previous: string | null };
  // Removes the link row only; R2 attachment purge is the DO's job.
  unlinkTelegram(): { removed: string | null };

  // Record an update id; true if newly seen, false if already processed.
  markProcessed(updateId: string): boolean;
}

export type Store = TopicStore & ConversationStore & AttachmentRecordStore & SettingsStore;
```

Note `unlinkTelegram` is now **sync** and returns only `{ removed }` (no R2). The
DO wrapper stays async because it does the R2 purge after.

### `DbStore` implementation (`store/db.ts`)

Copy the do-orm bodies verbatim, swapping `new Date().toISOString()` for the
existing private `this.nowIso()`. Import `telegramLink`, `userSettings`,
`processedUpdates` from `../UserDO/db/schema`.

Collapse the three settings write branches into one private helper. The helper
**returns the persisted row** so seed-on-read never re-derives a value it did not
store (see C1 below):

```ts
private upsertSettings(columns: Partial<{
  onboardingSeen: number;
  googleOnboardingStatus: string;
  timezone: string;
}>): SettingsRow {
  const existing = this.db.get(userSettings);
  if (existing) {
    if (Object.keys(columns).length > 0) {
      this.db.update(userSettings, columns, { where: eq("id", existing.id) });
    }
    // re-read so callers see the persisted post-update state
    return this.db.get(userSettings)!;
  }
  this.db.insert(userSettings, {
    onboardingSeen: 0,
    createdAt: this.nowIso(),
    ...columns,
  });
  return this.db.get(userSettings)!;
}
```

Then:

- `updateSettings(patch)`: build the `columns` object from `patch` (the
  `onboardingSeen ? 1 : 0` and `timezone` mapping, only for keys that are
  `!== undefined`) and call `upsertSettings(columns)`.
- `setGoogleOnboardingStatus(status)`: `upsertSettings({ googleOnboardingStatus: status })`.
- `getSettings()`: read the row; if present, map it (`!!onboardingSeen`, nullable
  columns) with `isNewUser: false`. If absent, call `upsertSettings({})` to seed
  it and **map the returned persisted row** the same way, with `isNewUser: true`.

**C1 (must-fix) — the seed path must return the row it actually wrote.** Do
**not** reconstruct the seeded return from known defaults: `upsertSettings`
generates `createdAt` internally via `this.nowIso()`, so if `getSettings`
rebuilt the return with its own `nowIso()` it would read the clock a second time
and `DbStore` could return a `createdAt` that differs from the row it just wrote.
Under a real clock those two reads differ; the fixed-clock `MemoryStore` in the
contract test (`() => "2026-01-01T00:00:00.000Z"`) makes them equal, so the suite
would **not** catch the drift. The current code returns the exact value it
inserted, and the port must too. That is why `upsertSettings` returns the
persisted row (re-read after write): `getSettings` maps that row and is
guaranteed to return `createdAt` equal to what was stored
(`onboardingSeen:false, googleOnboardingStatus:null, timezone:null` are the
seeded defaults). `MemoryStore` mirrors the same return-the-persisted-row shape
(see below) so the two adapters stay byte-aligned.

`telegramLink` and `markProcessed` methods are copied as-is (they are already
minimal, no shared helper needed).

### `MemoryStore` implementation (`store/memory.ts`)

Add fields mirroring the three tables and implement the same semantics using the
injectable `this.now()`:

- `private settingsRow: { onboardingSeen: number; googleOnboardingStatus: string | null; createdAt: string; timezone: string | null } | null = null;`
- `private telegramId: string | null = null;`
- `private processed = new Set<string>();`

Implement `getSettings`/`updateSettings`/`setGoogleOnboardingStatus` with the
same seed-on-first-`getSettings` + `isNewUser` behavior, `getTelegramId`/
`linkTelegram`/`unlinkTelegram` over `telegramId`, and `markProcessed` over the
`Set`. Keep a single in-memory upsert helper analogous to `DbStore` so the two
adapters read the same.

**C1 / C2 — byte-align the seed with `DbStore`.** The `MemoryStore` upsert helper
must:

- Seed with the **same default values and shape** as `DbStore`
  (`onboardingSeen:0, createdAt = this.now(), googleOnboardingStatus:null,
  timezone:null`), so the contract suite is a faithful proxy for the do-orm
  insert it can't run off-workerd.
- **Return the persisted settings row** (the stored object after the write), and
  have `getSettings` map that returned row rather than reconstructing the return
  from defaults — matching the `DbStore` seed path exactly. This keeps the two
  impls returning the same `createdAt` (the value actually stored) and keeps them
  byte-aligned under the fixed clock.

Note: `getSettings`'s seed-on-read insert for `DbStore` (a read that writes) is
exercised only in the workerd-backed CI run; off-workerd the `MemoryStore` seed
stands in for it, which is why the two seeds must match value-for-value.

### `SystemTopicStore` pass-throughs (`store/system-topics.ts`)

Add explicit one-line delegates to `this.inner` for all seven new methods
(`getSettings`, `updateSettings`, `setGoogleOnboardingStatus`, `getTelegramId`,
`linkTelegram`, `unlinkTelegram`, `markProcessed`), matching how every existing
method is forwarded. Because `SystemTopicStore implements Store`, a missing
pass-through is a **typecheck failure** (the class no longer satisfies `Store`),
caught at build time — not a silent runtime throw.

### `UserDO` delegate changes (`UserDO/index.ts`)

- Delete the private `markProcessed`; `enqueueTurn` calls `this.store.markProcessed(input.updateId)`.
- `getTelegramId`/`linkTelegram`: `return this.store.getTelegramId()` / `this.store.linkTelegram(id)`.
- `unlinkTelegram`: keep async wrapper — `const { removed } = this.store.unlinkTelegram(); if (removed) { purge R2 via this.attachments.deleteAllForUser(clerkUserId) } return { removed };`. The R2 purge and `clerkUserId` lookup are unchanged; only the row delete moved into the store. `if (removed)` is equivalent to the old `if (existing)` guard because `telegramId` is `notNull`.
- `getSettings`/`updateSettings`/`setGoogleOnboardingStatus`: delegate to `this.store.*`.
- Internal callers (`alarm`, `queueOnboarding`, `runTurn`, `runOnboarding`)
  switch from `this.getSettings()/this.updateSettings()/this.setGoogleOnboardingStatus()`
  to `this.store.*` for consistency with how `enqueueTurn` already uses
  `this.store` (either works since the delegates remain; prefer `this.store`).
- After the move, `this.db` is used **only** to build `new DbStore(this.db)`; no
  raw table access remains in the DO. Keep the field for that construction.

## Test plan

Follow deep-modules "replace, don't layer": the interface is the test surface.

- **Delete `UserDO/index.test.ts`.** It tests a hand-written fake
  (`createFakeUserDO`) that re-implements the settings/link logic inline, not the
  real code — pure waste once the real logic sits behind the port. Its behaviors
  move to the contract test below and now exercise the real `MemoryStore`/`DbStore`
  logic.
- **Extend `store/store-contract.test.ts`** (runs on `MemoryStore` with the fixed
  clock) with new `describe` blocks:
  - *settings*: `getSettings` seeds and returns `isNewUser: true` on first
    access with `onboardingSeen:false`, `googleOnboardingStatus:null`,
    `timezone:null`, a `createdAt`; second access returns `isNewUser:false` and
    the same `createdAt`; `updateSettings({ onboardingSeen: true })` then reflected
    in `getSettings`; reset to `false`; `updateSettings({})` is a no-op;
    `updateSettings({ timezone })` sets timezone; `setGoogleOnboardingStatus`
    transitions (`queued`→`running`→`done`) visible via `getSettings`; upsert
    path covered (update-when-row-exists vs insert-when-missing) by driving each
    writer both before and after a row exists.
  - *telegram link*: `getTelegramId` null initially; `linkTelegram` returns
    `{ previous: null }` then round-trips via `getTelegramId`; re-link returns the
    previous id; `unlinkTelegram` returns `{ removed }` and clears the id;
    `unlinkTelegram` on empty returns `{ removed: null }`.
  - *idempotency*: `markProcessed(id)` returns `true` first time, `false` on the
    duplicate; a different id returns `true`.
- **`SystemTopicStore` forwarding**: add a couple of cases in
  `store/system-topics.test.ts` (or the contract test wired through a
  `SystemTopicStore(new MemoryStore(...))`) asserting settings/link/markProcessed
  pass through to the inner store, so the decorator can't silently drop them.
- **Unchanged**: `routes/user-settings.test.ts` and `routes/admin.test.ts` use
  `Pick<UserDO, ...>` stubs over the still-public method names; no edits needed —
  confirm they stay green.

The DbStore side is covered because the contract suite is written to point at the
port; the workerd-backed run of the same behavior happens in CI. Off-workerd, the
`MemoryStore` run proves the semantics and is the trustworthy stand-in per the
existing design.

## Preservation argument (same resulting stored state / same semantics)

This is preservation of **stored state and semantics**, not byte-identical SQL
text. Two spots emit different SQL text but converge to the same stored state via
do-orm normalization: (a) the empty-patch update — current `updateSettings({})`
already no-ops because do-orm's `update` filters `undefined` and early-returns
when no columns remain, and the new helper guards with
`if (Object.keys(columns).length > 0)`; same effect (no SQL). (b) the
undefined-timezone insert — current code binds `timezone: undefined` (do-orm's
`buildInsert` does not filter undefined, so it writes NULL), while the helper
omits the column so the nullable default is NULL; same stored value. A reader who
diffs raw SQL will see these two differences; both are behavior-preserving.

- Each moved method's do-orm calls are copied verbatim into `DbStore`: same table
  objects (`telegramLink`/`userSettings`/`processedUpdates`), same `eq(...)`
  predicates, same inserted/updated column maps, same `onboardingSeen ? 1 : 0`
  and nullable mapping, `new Date().toISOString()` → the already-equivalent
  `this.nowIso()`.
- The shared `upsertSettings` helper is a mechanical factoring of the identical
  "get row → branch exists → update chosen columns / insert defaults + chosen
  columns" the three call sites already do; each writer produces the same SQL as
  before.
- `MemoryStore` mirrors the same semantics and is cross-checked against `DbStore`
  by the shared contract suite (the mechanism that already guarantees parity for
  topics/conversations).
- The only relocation of behavior is the R2 attachment purge, which was never a
  store concern and stays in the DO unchanged. `if (removed)` reproduces the old
  `if (existing)` guard exactly.

No table, migration, RPC signature, or route contract changes.

## Commits

1. **Port: interface + adapters + contract tests.** `store/types.ts`
   (`SettingsStore` + `Store` union), `store/db.ts` (methods + `upsertSettings`),
   `store/memory.ts` (fields + methods), `store/system-topics.ts` (pass-throughs),
   extend `store/store-contract.test.ts` and `store/system-topics.test.ts`.
   Self-contained and green (new behavior fully proven on `MemoryStore`).
2. **Rewire `UserDO`.** Delegate the six public RPC methods to `this.store`, drop
   the private `markProcessed` (call `this.store.markProcessed`), point internal
   callers at `this.store`, remove all raw `this.db` table access, delete
   `UserDO/index.test.ts`. **Remove the now-unused imports** in
   `UserDO/index.ts` (`eq` and the three table objects
   `telegramLink`/`userSettings`/`processedUpdates`) — lint will flag them
   otherwise; keep `createDb`/`this.db`, still needed for `new DbStore(this.db)`.
   Typecheck proves every caller still resolves.

(An optional third commit could split the `UserDO/index.test.ts` deletion out,
but it belongs with the rewire that makes it redundant.)

## Skills to use

- `deep-modules` — local-substitutable seam reasoning; "replace, don't layer" for
  the test move.
- `testing` — contract tests through the port interface, not implementation.
- `tdd` — write the extended contract cases first, then the adapter methods.
- `git-commit` — when committing the two stages.

## Verification

Per AGENTS.md (workerd can't run on the dev box; verify the touched package
directly):

```bash
pnpm --filter @zero/agent-api run test
pnpm --filter @zero/agent-api run lint
pnpm --filter @zero/agent-api run typecheck
```

The workerd-backed suites (e2e, cross-worker build) run in GitHub Actions CI and
the Cloudflare deploy.

## Changelog

None. Purely internal refactor with identical observable behavior (same SQL, same
RPC signatures, same routes). Per AGENTS.md, refactors with no user-visible change
get no changelog entry.

## Acceptance criteria

- `store/types.ts` `Store` includes the `SettingsStore` methods; `DbStore` and
  `MemoryStore` both implement them; `SystemTopicStore` forwards them.
- The 3x settings insert-or-update is one shared `upsertSettings` helper in
  `DbStore` (and an analogous single helper in `MemoryStore`).
- `UserDO/index.ts` has no raw `this.db` access to `telegramLink`,
  `userSettings`, or `processedUpdates`; the six public RPC methods delegate to
  `this.store`; `unlinkTelegram` still performs the R2 purge; `markProcessed` is
  gone from the DO and called on the store.
- `store/store-contract.test.ts` covers settings get/update + googleOnboarding
  status transitions + isNewUser, telegram link/unlink incl previous/removed, and
  markProcessed new-vs-duplicate; `UserDO/index.test.ts` is deleted;
  `routes/*` tests unchanged and green.
- `pnpm --filter @zero/agent-api run test/lint/typecheck` pass.
- No schema, migration, RPC-signature, or route-contract changes; no changelog
  entry.
```