# Plan: data deletion from user settings

## Goal

A signed-in user can erase everything Zero stores about them from the Settings
page, without asking anyone. Deleting data does not delete the Clerk sign-in
account: the user stays signed in and starts over as a blank user.

## Background (state of the code today)

Per-user data lives in four places:

- **`UserDO`** (`apps/agent-api/src/UserDO/index.ts`, one instance per Clerk
  user id): DO SQLite holds topics/knowledge, conversations, messages, pending
  queue, processed update ids, file metadata rows, schedules, settings
  (timezone, country, onboarding flags, `createdAt`) and the Telegram link row.
  Plain DO storage holds `clerkUserId`, the admin task (`ADMIN_TASK_KEY`) and
  `LINKS_REBUILT_KEY`.
- **`ScheduleDO`** (one per user): every deadline for the user (idle/size
  learning, onboarding, admin task, user schedules) plus its alarm.
- **`LearningDO`** (one per user): learning job state and the learner wire log
  plus its alarm.
- **R2 `FILES`** bucket: file bytes, keyed by `storageKey` rows that live in
  UserDO SQLite. `UserDO.deleteAllFiles()` already exists and deletes blobs then
  rows (`files/store.ts` `deleteAll`).

The Telegram binding is separate and dual-stored: `TelegramAccountDO` (source of
truth) and the `tg:{id}` KV cache, both handled only through
`telegram/identity.ts` (`unlinkTelegramAccount`). See `docs/telegram-login.md`.

Settings routes are in `apps/agent-api/src/routes/user-settings.ts`, mounted
after Clerk auth in `app.ts`, so handlers read a verified `c.get("userId")`. The
UI is `apps/agent-web/src/pages/SettingsPage.tsx` (Telegram card, Google card,
re-run onboarding). `apps/agent-mobile` has no settings screen: out of scope.

### Every place per-user data lives

Swept from the Worker's bindings (`wrangler.jsonc`) and every outbound call, so
the list is exhaustive rather than remembered.

**Deleted by this feature (all six):**

| Store | What it holds | How it goes |
|---|---|---|
| `UserDO` SQLite + KV | topics, conversations, messages, queue, file rows, schedules, settings, Telegram link, admin task | `deleteAll()` |
| `ScheduleDO` | every deadline + alarm | `deleteAll()` |
| `LearningDO` | job state, learner wire log + alarm | `deleteAll()` |
| `TelegramAccountDO` | the account→user claim | `release()` |
| KV `tg:{id}` | cache of that claim (the only KV key shape in the Worker) | `delete()` |
| R2 `zero-attachments` | file bytes under `files/{user}/` and `attachments/{user}/` | per-record + prefix sweep |

**Not deleted, deliberately.** The UI must say the honest version of this, not
"we deleted everything, everywhere":

- **Clerk account** (name, email, the Google OAuth grant and its tokens). We
  sign the user out, we do not delete the account, and Zero keeps the Google
  grant until the user disconnects it. The Settings copy should point at the
  "Disconnect" buttons for anyone who wants that too.
- **Analytics Engine** (`zero-events`, `zero-ai-usage`): write-only datasets
  indexed by Clerk user id. There is no delete API; Cloudflare stores data for
  three months and it ages out (Analytics Engine Limits docs).
- **Workers Logs**: log lines carry `clerk_user_id`. No per-record delete; they
  age out with the observability retention window.
- **AI Gateway logs**: each call carries `cf-aig-metadata` with
  `{ user_id, agent }` (`agents/model.ts` `gatewayMetadata`), and requests carry
  `safety_identifier: clerkUserId` to OpenAI. These *can* be deleted per user:
  `DELETE /accounts/{id}/ai-gateway/gateways/{gateway}/logs` accepts `filters`
  on `metadata.key` / `metadata.value`. It needs a Cloudflare API token the
  Worker does not hold, so it is an ops step, not part of the request. Document
  it in `docs/data-deletion.md` as the manual follow-up for a user who asks.
- **ZeroErrors** (project `zero-agent`): error contexts include
  `clerk_user_id`, never message content. Cleared by deleting the issue.
- **Discord signup notice**: a one-off message with name and email in our
  channel. Manual.
- **Telegram**: the chat history on the user's own device and Telegram's
  servers is theirs, not ours. Deleting our copy does not clear their chat.
- **The model provider**: prompts already sent to OpenAI are subject to their
  retention, not ours.

## What to change and why

### 1. Purge helper (`apps/agent-api/src/do/purge.ts`, new)

A DO's own storage wipe is three lines, but the *order* is the interesting part,
so put the sequence in one testable function following the `do/*` pattern
(pure-ish, injected dependencies, unit tested without a DO):

```ts
purgeUserData({ telegramId, releaseTelegram, purgeSchedules, purgeLearning, purgeUser, resetUser })
```

Order, and why:

1. **Release the Telegram claim first** (`unlinkTelegramAccount`: release
   `TelegramAccountDO`, delete the `tg:` KV key). This closes the window where
   an inbound Telegram message resolves to this user mid-wipe and writes fresh
   rows behind the purge.
2. **`ScheduleDO.purge()`** then **`LearningDO.purge()`**: kill pending
   deadlines and job state so nothing re-enters `UserDO` after it is wiped.
3. **`UserDO.deleteAllData()`**: it holds the data users actually mean.
4. **`UserDO.reset()`** (`ctx.abort`), in `try/catch`: drops the live instance
   so nothing rebuilds a schema in the object we just emptied. Its rejection is
   expected, see § 3.

Each step is idempotent, so a partial failure is safe to retry by pressing the
button again.

### 2. `ScheduleDO.purge()` and `LearningDO.purge()`

Both: `await this.ctx.storage.deleteAlarm()` then
`await this.ctx.storage.deleteAll()`. Neither keeps in-memory state that
survives, so no re-init is needed.

### 3. `UserDO.deleteAllData()`

Steps, in this order:

1. Read the Telegram id and return it to the caller (the route needs it only if
   it did not read it first; prefer the route reading `getTelegramId()` up
   front, keeping identity policy out of the DO as it is today).
2. Delete every R2 object of this user, **before** wiping SQLite, because the
   `storageKey`s live in the file metadata rows. Reuse `files/store.ts`
   `deleteAll()`, which is already the complete sweep: it deletes each record's
   `storageKey`, then `deletePrefix("attachments/{clerkUserId}/")` and
   `deletePrefix("files/{clerkUserId}/")`. The prefix passes are not redundant
   with the per-record loop; they are what removes **orphans**, objects whose
   metadata row was lost (a failed save, an old bug), which a row-driven loop
   can never see. `FILES` is the only bucket and those two prefixes are the only
   key shapes it ever writes (`files/store.ts:89`, `files/store.ts` `deleteAll`),
   so after this the user owns no R2 object. `deletePrefix` pages with a cursor
   until `truncated` is false, so a user over the 1000-key list page is fully
   swept.

   **Take `clerkUserId` as an argument**: `deleteAllData(clerkUserId)`. Today
   `deleteAllFiles()` reads it from DO storage and returns early when it is
   absent (it is only written by `enqueueTurn`), which would silently skip the
   R2 sweep. The route has the verified Clerk id — it is the DO's own name — so
   there is no reason to depend on internal state for the one step that touches
   a store the wipe cannot reach.
3. `await this.ctx.storage.deleteAlarm()`.
4. `await this.ctx.storage.deleteAll()` — on a SQLite-backed class (UserDO is in
   `new_sqlite_classes`, wrangler.jsonc tag v5) this removes "the entire
   contents of the private SQLite database, including both SQL data and
   key-value data", atomically, and at `compatibility_date` ≥ `2026-02-24`
   (this Worker is `2026-06-01`) it also deletes the alarm (Cloudflare Storage
   API docs). Step 3 is therefore belt-and-braces; keep it only if you want the
   code to be independent of the compat date.
5. **Write nothing back.** Do not re-run `migrate` here. The point of the wipe
   is an empty Durable Object: `deleteAll()` "effectively deallocat[es] all
   storage used by the Durable Object" (Cloudflare Storage API docs), and
   re-creating the `__migrations` table plus the schema immediately re-allocates
   it. An empty object costs nothing and is evicted normally.

   The live instance is now holding a `Database` over a schema-less SQLite, so
   it must not serve another request. Add a separate `reset()` RPC that calls
   `this.ctx.abort("user data deleted")`, and have the route call it right after
   `deleteAllData()` inside `try { } catch { }`. `abort` forcibly resets the
   object and its error "is not able to be caught within the application code"
   (Cloudflare `DurableObjectState` docs), so the RPC always rejects on the
   caller's side; that rejection is the success signal, not a failure. Keeping
   it as a second RPC is what makes this readable: `deleteAllData()` resolves or
   throws honestly, and only `reset()` is expected to throw.

   If anything ever addresses this DO id again, the constructor re-runs
   `migrate` (idempotent: `CREATE TABLE IF NOT EXISTS __migrations` plus a
   max-version check) and the user is a fresh, empty user. That is exactly why
   the Telegram claim is released first: after the purge, nothing routes to this
   object.

`ScheduleDO` and `LearningDO` need no equivalent: neither declares a
constructor, so `deleteAll()` leaves them genuinely empty with nothing in memory
to reconcile.
Nothing is re-seeded: the wipe leaves no settings row at all. The user is a
blank slate, and the UI signs them out (see § 5), so the next sign-in runs the
normal new-user path — onboarding, and the Gmail scan if they connect Google.
That is the intended outcome of "delete everything", not an accident: the DO
must not be left holding sentinel state to paper over the UI.

Two consequences to know about, both accepted:

- The onboarding screen fires the Gmail scan whenever Google is connected and
  `googleOnboardingStatus` is null (`Onboarding.tsx:255`). After a wipe the user
  is signed out, so this happens only if they sign in again and walk through
  onboarding themselves — a deliberate act, not a silent re-import.
- `GET /api/user-settings` writes a `signup` analytics data point when the
  settings row is missing (`user-settings.ts`, `isNewUser` from `db.ts:841`), so
  a user who deletes and comes back counts as a second signup. Correct enough:
  they are starting over.

Rejected alternative: re-running `migrate` in place so the instance stays
usable. It keeps the object allocated with a full empty schema forever, which is
the opposite of the goal, and it is not needed once the object is aborted.

Known races, both accepted:

- A turn already running on this DO's alarm can interleave with the wipe and
  fail on missing rows. It surfaces as a reported alarm error and self-heals on
  the next message.
- A `LearningDO` slice that is mid-flight when the purge runs keeps calling back
  into `UserDO` over RPC (`learnCreateTopic` and friends), so it can re-create a
  topic seconds after the wipe. Purging `LearningDO` before `UserDO` shrinks but
  does not close the window; a learner slice runs for minutes. Mitigation, cheap
  and idempotent: after `UserDO.deleteAllData()` returns, call
  `LearningDO.purge()` and `ScheduleDO.purge()` a second time, before the
  `reset()`. A write that still lands re-constructs the aborted UserDO, re-runs
  `migrate` and leaves a schema plus a fragment of the user's own data behind,
  so the object is no longer empty; a second press of the button removes it.
  Closing the window properly needs a deletion generation stamped on every
  write, which is not worth it today.

Neither is worth a lock for a rare, user-initiated action.

### 4. Route `DELETE /api/user-data`

In `routes/user-settings.ts`, Clerk-authed like its neighbours:

- read `getTelegramId()` from the UserDO,
- call `purgeUserData(...)` wiring `unlinkTelegramAccount(c.env, id)` (skipped
  when null), `getScheduleDO(...).purge()`, `getLearningDO(...).purge()`,
  `getUserDO(...).deleteAllData(clerkUserId)`, the second Schedule/Learning purge, and
  `getUserDO(...).reset()` whose rejection is swallowed,
- `log("user_data_deleted", { clerk_user_id })`,
- return `200 { deleted: true }`.

Do it inline (not `waitUntil`): the UI must not report success before the data
is gone.

### 5. Settings UI: danger zone

A `DangerZone` card at the bottom of `SettingsPage.tsx`, after `GoogleConnect`:

- Copy states plainly what goes: conversations and messages, everything the
  assistant learned about you (topics), uploaded files, schedules and reminders,
  your Telegram link and your settings. And what stays: your sign-in account,
  your Google and Telegram accounts (disconnect them above if you want those
  gone), your Telegram chat history on your own device, and usage logs that age
  out on their own. See the table in Background for the exhaustive version.
- Two-step confirm, no new UI primitive needed (only button/card/input/table
  exist): the first click reveals an `Input` where the user types `DELETE`, and
  the destructive button stays disabled until it matches exactly. Cancel
  restores the collapsed state.
- While deleting: disabled button, "Deleting…". On failure: `ErrorText` with
  the status, button re-enabled (retry is safe, the purge is idempotent).
- On success: **sign the user out**. `const { signOut } = useClerk()` then
  `await signOut({ redirectUrl: "/" })`. `AuthGate` in `App.tsx` renders Clerk's
  `SignIn` for a signed-out visitor, so they land on the sign-in screen with
  nothing of theirs left in the app. This also throws away every piece of
  client state (the `AppShell` settings fetch, the Telegram and Google card
  state) without hand-rolling resets, and it means no signed-in session keeps
  poking `/api/*` against a wiped user mid-purge.
- Copy must say so: "This signs you out. Signing in again gives you a fresh,
  empty Zero."

## Tests

- `store/store-contract.test.ts`: no new store method is needed. `deleteAllFiles`
  already exists on the port and in both adapters (`db.ts`, `memory.ts`), and
  nothing is written back after the wipe.
- `do/purge.test.ts` (new): with fakes, asserts the call order (Telegram release
  before the DO purges, `UserDO` last), that a null Telegram id skips the
  release, and that a throw from one step propagates (the route returns 500 and
  the user retries).
- `routes/user-settings.test.ts` (extend): `DELETE /api/user-data` returns 200,
  clears the `tg:` KV entry and releases the account DO via the existing
  `fakeAccountNamespace`, calls `purge()` on the fake Schedule/Learning
  namespaces and `deleteAllData()` on the fake UserDO. Add a case for a user
  with no Telegram link.
- `do/purge.test.ts` also pins the abort contract: a rejecting `resetUser` must
  not fail the purge, and a rejecting `purgeUser` must.
- `files/store.test.ts` (extend): `deleteAll()` removes an **orphan** object
  under `files/{user}/` that has no metadata row, and one under the legacy
  `attachments/{user}/` prefix. The existing tests cover the row-driven path;
  the orphan case is the one that proves the R2 sweep is complete, and it is
  cheap with the in-memory blob store (`files/memory.ts`).
  `files/memory.ts` already implements `deletePrefix` by prefix match, so the
  fake is faithful enough for this (paging is not observable in memory).

## Docs and changelog

- `apps/agent-api/CHANGELOG.md`: `- YYYY-MM-DD: You can delete everything Zero
  knows about you from Settings: conversations, memories, files, schedules and
  your Telegram link. It signs you out, and signing in again gives you a fresh,
  empty Zero.` (load the `changelog` skill; no em dashes.)
- New `docs/data-deletion.md`: what the purge covers, the ordering rationale,
  the accepted mid-turn race, and what is explicitly not deleted. Link it from
  `docs/design.md`'s routes section and from `docs/telegram-login.md` where the
  dual-store unlink is described.

## Skills to use

- `development-guidelines` — throughout.
- `tdd` — for `do/purge.ts` and the route.
- `testing` — fakes for the DO namespaces.
- `changelog` — when adding the agent changelog entry.
- `git-commit` — when committing.

## Acceptance criteria

- A signed-in user with data (topics, messages, files, a schedule, a Telegram
  link) can press Delete in Settings, confirm, and afterwards: the Telegram
  account no longer resolves to them (bot replies as to a stranger), their
  topics and messages are gone, and no schedule fires.
- The `FILES` bucket holds **no object** under `files/{clerkUserId}/` or
  `attachments/{clerkUserId}/`, including objects with no metadata row. Check
  with the S3-compatible API (`aws s3 ls s3://<bucket>/files/<user>/`) or the R2
  dashboard; `wrangler` has no object-listing command.
- The three Durable Objects are left **empty**, not re-initialised: no schema,
  no settings row, no alarm, nothing for Cloudflare to keep. Verify on a real
  deployment by querying the user's `UserDO` storage after a delete (e.g. an
  admin read that reports row counts, or `wrangler` DO inspection) and seeing
  nothing.
- After deleting, the user is signed out and sees the sign-in screen. No Gmail
  scan runs as part of the deletion; signing in again starts the normal
  new-user flow.
- Deleting twice in a row succeeds both times (retry after a failed purge).
- Deleting a brand-new user with no Telegram link and no files succeeds.
- The button cannot fire without typing the confirmation word.
- `DELETE /api/user-data` without a Clerk session returns 401.
- `pnpm --filter @zero/agent-api run test|lint|typecheck` pass.
