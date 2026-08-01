# Telegram link: an authoritative account record behind the KV lookup

## Goal

After a user links Telegram, the bot recognises them on their very next message.
Today it can tell them "Sign in and link this Telegram account" for up to a
minute *after* they linked, which is what a first tester hit on 2026-07-31.

Secondary goal: the web app should show a real success state after linking, so
the user knows the link worked and knows what to do next.

## The bug, with evidence

Production logs for the incident (`zero-api`, 2026-07-31, telegram id
`5013038033` → `user_3HH5CSMwmLLGSsquXT5WwXBSb64`). The last hex group of a
Cloudflare request id is the colo:

```
17:39:41.780  a23db281bf68 0b3c  drop_unknown_telegram_id      <- Telegram webhook colo
17:40:38.918  a23db3e72ca1 0b3c  drop_unknown_telegram_id
17:40:43.921  a23db4033cb3 452e  telegram_linked  (KV.put)     <- user's browser colo
17:40:50.939  a23db4324b1a 0b3c  start_command linked:false
17:40:53.228  a23db4409ac5 0b3c  drop_unknown_telegram_id
17:40:56.423  a23db4548df2 0b3c  start_command linked:false
17:41:23.375  a23db4fd0bfb 0b3c  start_command linked:false
```

All events are on one script version, so no deploy interfered. The reverse
lookup `tg:{telegramId} → clerkUserId` is written from the browser's colo and
read from Telegram's colo.

Cloudflare KV docs, `kv/concepts/how-kv-works`:

> Changes may take up to 60 seconds or more to be visible in other global
> network locations as their cached versions of the data time out. **Negative
> lookups indicating that the key does not exist are also cached, so the same
> delay exists noticing a value is created** as when a value is changed.

And `kv/api/read-key-value-pairs`:

> **If a given key has recently been read in a given location, writes or updates
> to the key made in other locations may take up to 60 seconds** (or the
> duration of the `cacheTtl`) to display. […] `60` is the default.

The user messaged the bot *before* linking. That read cached the miss in the
webhook colo. Every subsequent miss re-armed it for another 60s. The write was
invisible there the whole time.

This is not an edge case, it is the default path, and our own copy drives users
into it: `SIGN_IN_REPLY` says "Sign in at … then **come back here**". Coming back
promptly is precisely what fails.

Ruled out: wrong key (one `tg:${telegramId}` helper in all four call sites),
wrong namespace (a single KV binding), failed write (`telegram_linked` only logs
after `KV.put` resolves, and the key is present today), version skew, auth.

## Why we cannot detect readiness from the browser

The tempting fix is a "checking…" spinner that polls until the mapping is
visible, then releases the user. It cannot work. The poisoned negative cache
lives in the colo that serves Telegram's webhook POSTs. Every request the
browser makes is served by the *user's own* colo. A probe endpoint would execute
in the browser's colo, read a healthy cache, and report "ready" while the webhook
colo is still poisoned. There is no way to run code in the webhook colo on
demand: the only thing routed there is a real Telegram update, and provoking one
is exactly what we need to avoid.

So the choice is between a blind timer and removing the cause.

## Options

**A. Timed gate in the UI only.** After linking, hide the "Open in Telegram"
button for ~60s behind a "getting things ready" state, then reveal it.

Sound only if the user does not touch the bot during the wait, because any miss
re-arms the TTL for another 60s; the gate is what enforces that, so the copy must
say "don't open Telegram yet". Still not guaranteed: the docs say "up to 60
seconds **or more**", the clock that matters starts at the *last miss* (which the
browser cannot see) rather than at link time, and a user with the Telegram app
already open on the bot can defeat it. It also adds a full minute of dead time to
onboarding to work around a problem we can delete.

**B. Replace KV with a Durable Object.** Correct, but throws away a good
fit. KV is the right store for this mapping in the steady state: once a Telegram
id maps to a Clerk user it never changes, it is read on the hot path of every
inbound message, and an edge-cached read is the fastest thing available. The
propagation window is the *only* thing wrong with it, and that window is one
minute in each user's lifetime.

**C. Keep KV as the fast path, consult the authoritative record only on a miss.**
Recommended.

```
resolve(telegramId):
  hit = KV.get(tg:{id})        // steady state: unchanged, fast, every request
  if hit: return hit
  return account.owner(id)     // cold path only: strongly consistent
```

A miss occurs in exactly two cases: the first-link propagation window (once per
user) and a stranger messaging the bot. Both are cold. The linked-and-settled
case, which is effectively all traffic, never touches the account record. Writes
go to the account record first (authoritative) and then KV (cache); within 60s
KV catches up on its own and the account record goes quiet.

Rejected: lowering `cacheTtl` (minimum 30, only shrinks the window); bypassing
the edge cache with the KV REST API from the Worker (adds a secret and an
external call); using `KV.list` as the backstop (list is eventually consistent
too, and returns names without values, so it would mean encoding the Clerk id
into the key name).

Also rejected, and worth recording so it is not re-litigated: **a signed
`?start=` payload**. The web CTA already links to `t.me/<bot>?start=welcome` and
`start.ts:26-28` notes the payload is unused, so a signed token carrying the
Clerk user id would make the first `/start` self-identifying with no lookup at
all. It is elegant and it is not enough: it covers only `/start` arriving from
our own CTA, while the incident began with a plain typed message
(17:39:41) from a user who found the bot on his own. It would need the account
record anyway, so it buys nothing here.

D1 was evaluated and rejected: without read replication its reads are
strongly consistent and would work, but replication is an account-level toggle
that silently degrades reads to a lagging replica unless every read uses the
Sessions API with bookmarks, which is this exact bug reintroduced. It would also
add a `wrangler d1 migrations apply` step to a deploy pipeline whose commands
live in the Cloudflare dashboard, not the repo. A Durable Object's
serializability cannot be configured away.

## What to change

KV keeps its job, its binding, and its place on the hot path. Everything below
is additive.

### 1. `TelegramAccountDO` (new)

One DO per Telegram account, `idFromName("tg:" + telegramId)`. **It represents
one Telegram account's claim on a Zero user**: its identity is the Telegram
account, and its state is the answer to "who does this account belong to?". It
is the counterpart of `UserDO`, which holds the same binding from the Clerk
side. It is the source of truth; the KV entry is the derived copy. Do not call
it an index, or someone will drop it as a rebuildable lookup structure.

State is the `clerkUserId` in `ctx.storage`. Interface: `owner()`,
`claim(clerkUserId)`, `release()`. Follow the existing DO conventions: extend
`DurableObject<Env>` and use `ctx.storage` directly, as `ScheduleDO` does (no
`do-orm` for a single value); add a `stub.ts` helper alongside it like
`UserDO/stub.ts`, wrapped in `withDORetry`.

Address it as `idFromName(telegramId)`, with no prefix. The namespace is already
Telegram-only, and `UserDO/stub.ts:13` uses the bare `clerkUserId`. A prefix
would be noise you can never change without orphaning every object's state.

Wiring, all of which is easy to miss and each of which breaks the build or the
deploy on its own:

1. `export { TelegramAccountDO } from "./TelegramAccountDO/index"` in
   `src/index.ts`, next to the three existing exports (lines 13, 17, 18).
   A bound class that is not exported fails the deploy.
2. Binding `TELEGRAM_ACCOUNT_DO` **in both** `wrangler.jsonc` and
   `wrangler.test.jsonc`. They carry separate binding lists and separate
   migration histories: `wrangler.jsonc` is at `v7`, so the new tag is `v8`;
   `wrangler.test.jsonc` only has `USER_DO` and stops at `v6`, so its new tag is
   `v7`. Copying the same tag into both is wrong.
3. `pnpm --filter @zero/agent-api run cf-typegen` and commit the regenerated
   `worker-configuration.d.ts`. `Env` is `Cloudflare.Env` (`src/types.ts:12`),
   generated from the wrangler config, so without this `env.TELEGRAM_ACCOUNT_DO`
   does not typecheck.

Note `wrangler.test.jsonc` has already drifted: it is missing `SCHEDULE_DO` and
`LEARNING_DO` and the `v7` migration that added them. Do not treat that file as
a trustworthy template; add the new binding deliberately.

Deep-module note: the seam is "resolve a Telegram id to a Clerk user", not "a
DO" and not "KV". Put the whole resolve/link/unlink policy behind one module
(e.g. `src/telegram/identity.ts`) that owns both stores and the cache-first
order. Routes and commands call that; they should not know the mapping lives in
two places. That is also what makes the fallback testable without a DO.

Out of scope, but this object is where it would go: today a second Zero user can
link a Telegram account already linked to someone else, and `KV.put` silently
overwrites while the first user's `UserDO` still believes it owns that id.
Because every claim on an account now passes through one object, that conflict
becomes detectable in one place.

The four `tgKey` helper copies (`start.ts:16`, `new.ts:10`,
`user-settings.ts:27`, `telegram-webhook.ts:32`) collapse into that module.

### 2. Write path

`routes/user-settings.ts`: on link, `claim` the account, then write KV, and
`release` plus delete KV for the previous id on a re-link. On unlink, release
and delete. Claim before KV so a crash between the two leaves the authoritative
store correct and the cache merely stale, which the read path already tolerates.

### 3. Read path

`routes/telegram-webhook.ts:389` (`getClerkUserId`), `commands/start.ts:37`,
`commands/new.ts:23` all resolve through the module: KV, then the account on
miss. These three are mutually exclusive per update (grammY dispatches `/start`,
`/new`, or the generic message handler), so this is one resolve per update, not
three.

**Log when the fallback fires.** When KV misses and the account resolves, emit a
distinct line (e.g. `telegram_account_fallback` with `telegram_id` and
`clerk_user_id`). Without it the acceptance criteria below cannot be evaluated:
the absence of `drop_unknown_telegram_id` does not distinguish "the fallback
saved this user" from "KV happened to be warm". This whole diagnosis was made
from Workers Logs, and this is the line that proves the fix works in production
and shows how often the window is really hit. The three existing
`drop_unknown_telegram_id` call sites (`telegram-webhook.ts:297`, `new.ts:25`,
`start.ts:39`) should move into the module too, so both outcomes are logged in
one place.

### 4. No migration

The four existing keys (`tg:5013038033`, `tg:6711171416`, `tg:704737359`,
`tg:892522568`) need no backfill. They are served by KV, and their negative
cache can no longer be poisoned: poisoning requires a read that happened before
the key existed, which for them is history, and a cold read in a colo that has
never seen the key goes to the central store and hits. A future re-link claims
the account like any new link.

This also means the change carries no rollback risk: reverting the Worker leaves
KV exactly as it is today.

## Tests

- `TelegramAccountDO` unit: claim/owner/release, re-claim overwrites, unclaimed
  → null.
- Identity module unit with a fake KV and a fake account store. The important
  cases are the ordering ones: a KV hit does **not** consult the account (this
  is the hot-path guarantee, assert the account is never called); KV miss plus
  claimed account resolves; both miss resolves to null; re-link releases the
  previous id in both stores; unlink clears both.
- Existing tests will **fail**, not merely need tidying, and that is expected:
  `commands/start.test.ts:28` and `commands/new.test.ts:28` build a bare
  `fakeEnv` with only `KV` and `USER_DO`, and their unlinked-user cases pass an
  empty KV. Those cases now take the fallback path and will dereference an
  undefined `TELEGRAM_ACCOUNT_DO`. Give `fakeEnv` a fake account namespace.
  `telegram-webhook.test.ts` injects `getClerkUserId` through `WebhookDeps`
  (`telegram-webhook.ts:272`) and needs no such change.
- No test can reproduce a cross-colo KV stale read, so do not try. Simulating it
  is exactly what the fake-KV miss case above does.
- Verify per `AGENTS.md`: `pnpm --filter @zero/agent-api run test`, plus `lint`
  and `typecheck`. `workerd` does not run on this box, so no local worker.
- **`bin/e2e-test` is not covered by CI.** `AGENTS.md` is explicit: the
  `packages/agent-e2e` script is `e2e`, not `test`, so CI never runs it, and it
  needs a `workerd`-capable machine. Do not rely on it to catch a mistake here.
  It seeds only KV (`bin/e2e-test:66-69`, `tg:12345 → user_test`), which keeps
  working precisely because KV is read first; if someone later flips the order to
  account-first, that suite breaks and nobody finds out.

## Production verification

Unit tests cannot exercise the bug, so prove the fix on the deployed Worker:

1. Unlink a spare Telegram account, then message the bot to poison that colo's
   negative cache (expect `drop_unknown_telegram_id`).
2. Link it in the web app.
3. Immediately message the bot again.
4. Expect a real reply, and in Workers Logs a `telegram_account_fallback` line
   for that telegram id with no `SIGN_IN_REPLY`. That line is the proof; without
   it you have only shown that 60 seconds passed.

## Web app: a real ready state

`apps/agent-web/src/pages/Onboarding.tsx` already flips the Telegram card to
`Connected · {telegramId}` with an "Open in Telegram" button, and a tester still
reported "no success state". Two concrete weaknesses:

- It shows the raw numeric id. The widget payload carries `first_name` and
  `username`; show that instead, falling back to the id.
- The confirmation is small grey text competing with the Google card. Give the
  linked state clear visual priority and make "Open in Telegram" the obvious
  next action.

With the account record there is nothing to wait for, so **no countdown and no
polling**. If option A ships alone instead, this is where the 60s gate and its
"don't open Telegram yet" copy would live, keyed off the link time returned by
the server.

## Docs and changelog

- `docs/telegram-login.md` — the KV mapping is now KV plus an authoritative
  `TelegramAccountDO`; say why (the propagation window) so nobody deletes the
  backstop as redundant. Update the Re-linking section too.
- `AGENTS.md` architecture paragraph — "routes each update to the right user via
  KV" gains the backstop.
- `docs/telegram-webhook.md` if it names KV.
- `apps/agent-api/CHANGELOG.md`, user-facing, e.g.
  `- YYYY-MM-DD: Link Telegram and Zero knows you immediately — no more being
  told to link an account you just linked.`

## Skills to use

- `deep-modules` — choosing the identity seam so callers do not learn about DOs.
- `tdd` — the identity module and the DO are pure logic behind an interface.
- `testing` — what to fake (the account store) versus what to test for real.
- `changelog` — before editing `apps/agent-api/CHANGELOG.md`.
- `git-commit` — committing.

## Acceptance criteria

- Linking Telegram and immediately sending the bot a message is recognised, with
  no waiting period, including when the user messaged the bot before linking.
- `drop_unknown_telegram_id` and `start_command linked:false` no longer appear
  for a user who has linked.
- A `telegram_account_fallback` log line appears in production for a real
  link-then-message sequence, proving the backstop ran rather than the window
  merely elapsing.
- The four existing linked users keep working across the deploy with no manual
  backfill.
- A settled user's message resolves from KV alone: no `TelegramAccountDO` call.
  (`UserDO` is still called to enqueue the turn; that is unrelated.)
- The web app shows an unmistakable linked state naming the Telegram account,
  with "Open in Telegram" as the next action.
- Docs no longer describe KV as the routing mechanism; changelog entry ships in
  the same commit.

## Risks

- **Cost on the cold path.** A stranger messaging the bot now costs one DO RPC
  per message instead of a cached KV miss. Negligible at this traffic, and it is
  the only case besides first link that reaches the account.
- **New DO class needs a migration tag in two configs with different
  histories.** `wrangler.jsonc` is at `v7`, `wrangler.test.jsonc` at `v6`.
  Getting this wrong fails loudly, not silently.
- **`reproducible-locally` does not apply.** The failure is a property of
  Cloudflare's edge cache across colos and cannot be reproduced on one machine.
  The production verification section is the substitute; do not let it slide.
- **The backstop looks redundant.** Someone reading the code later sees two
  stores for one mapping and deletes the "unused" one. The identity module and
  `docs/telegram-login.md` must state the reason at the call site.
- **Rollback.** The change is additive; reverting the Worker leaves KV intact.
