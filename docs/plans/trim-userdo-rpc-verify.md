# Verification: Trim UserDO's dead RPC surface

Verdict: **GO**. No blockers, no concerns. The plan is accurate and buildable
exactly as written.

Method under review: `apps/agent-api/src/UserDO/index.ts`. The plan deletes 12
topic/conversation delegate methods, makes 3 methods `private`, keeps 11, and
prunes now-unused type imports.

## How this was verified

1. Enumerated every DO-stub entry point. The only typed stub is
   `getUserDO(env, clerkUserId): DurableObjectStub<UserDO>` (`UserDO/stub.ts`).
   Grepped all `getUserDO(...)` and `USER_DO` usages: the sole call sites are
   `commands/new.ts`, `routes/admin.ts`, `routes/onboarding.ts`,
   `routes/user-settings.ts`, `routes/telegram-webhook.ts` (+ their test mocks).
   No other typed DO wrapper exists.
2. Grepped every one of the 15 target method names across the whole repo
   (`apps/agent-api` src + tests, `packages/agent-e2e`, `apps/agent-web`).
3. Grepped every `Pick<UserDO, ...>` test fake.
4. Applied the plan's exact edits on a throwaway basis and ran
   `typecheck`, `lint`, and `test`, then reverted with `git checkout`.

## Proof: build passes with the plan applied

Applied all four steps (delete 12, privatise 3, remove the whole
`Message, Role, Thread, Topic, TopicMeta` import) and ran the touched package:

- `pnpm --filter @zero/agent-api run typecheck` -> exit 0
- `pnpm --filter @zero/agent-api run lint` -> exit 0 (eslint clean, all 5 pruned
  imports were genuinely unused; `Store` retained for the `this.store` field)
- `pnpm --filter @zero/agent-api run test` -> 41 files, 350 tests, all pass

Then `git checkout apps/agent-api/src/UserDO/index.ts` restored the tree
(working tree back to only the untracked plan file).

Typecheck is the decisive gate for claim (1): a surviving `userDO.saveTopic(...)`
stub call would fail to compile. It compiled clean, so no such caller exists.

## Findings against the six required checks

### 1. Every "delete" method has zero callers anywhere — CONFIRMED

For each of the 12, the only matches are the `Store` implementations
(`store/db.ts`, `store/memory.ts`, `store/system-topics.ts`), the `Store` port
type (`store/types.ts`), the `UserDO` delegate being deleted, `Store`-instance
calls in tools/agents/tests (`store.X(...)` / `s.X(...)` / `d.store.X(...)`), and
internal `this.store.X(...)` calls inside the DO. None is a `userDO.X(...)` /
`getUserDO(...).X(...)` stub call.

Notable internal call sites that use `this.store` directly (not the deleted
delegate), so deletion cannot break them:
- `enqueueTurn` -> `this.store.getOrCreateConversation` (index.ts:153),
  `this.store.storeMessage` (index.ts:160)
- `alarm` -> `this.store.findThreadsAwaitingReply()` (index.ts:179)

`packages/agent-e2e` has zero references to any of the 12. No test calls any of
them through a stub.

### 2. Every "make private" method is called only via `this.` — CONFIRMED

- `markProcessed`: single caller `this.markProcessed(input.updateId)`
  (index.ts:151). No stub caller.
- `runTurn`: single caller `this.runTurn(chatId, topicId)` (index.ts:180, the
  `runAlarmTurns` dep). The many other `runTurn` grep hits are the unrelated
  `agents/orchestrator.ts` exported function (imported here aliased as
  `orchestrateTurn`) and the `alarm.ts` dep param — not the DO method. No stub
  caller.
- `runOnboarding`: single caller `this.runOnboarding()` (index.ts:184). The
  same-named import from `../do/onboarding` (used at index.ts:214 as a bare
  `runOnboarding({...})` call) is a different symbol; `private` on the method
  does not change that resolution. No stub caller.

### 3. The 11 "keep" methods each have a real external caller or are framework — CONFIRMED

- `enqueueTurn` -> `telegram-webhook.ts:360`
- `resetConversation` -> `commands/new.ts:30`
- `queueOnboarding` -> `routes/onboarding.ts:44`
- `getTelegramId` -> `routes/admin.ts:105`, `routes/user-settings.ts:49`
- `linkTelegram` -> `routes/user-settings.ts:92`
- `unlinkTelegram` -> `routes/user-settings.ts:123`
- `getSettings` -> `routes/admin.ts:106`, `routes/user-settings.ts:163/200/206`
- `updateSettings` -> `routes/user-settings.ts:205`
- `alarm` -> DO runtime override (must stay public)
- `constructor` -> DO runtime
- `setGoogleOnboardingStatus` -> **no external caller**; kept public by judgment
  (see check 5). The plan states this honestly and does not claim an external
  caller for it.

### 4. No test fake references a deleted/privatised method — CONFIRMED

All four `Pick<UserDO, ...>` fakes reference only kept-public methods:
- `UserDO/index.test.ts:9` — `getTelegramId | linkTelegram | unlinkTelegram |
  getSettings | updateSettings | setGoogleOnboardingStatus` (all kept public)
- `routes/user-settings.test.ts:39` — same list (all kept public)
- `commands/new.test.ts:16` — `resetConversation` (kept)
- `routes/onboarding.test.ts:11` — `queueOnboarding` (kept)

None picks a deleted delegate or `markProcessed`/`runTurn`/`runOnboarding`, so no
`Pick` breaks. Confirmed by the clean typecheck above.

### 5. `setGoogleOnboardingStatus` kept-public judgment — REASONABLE

It is internal-only in production (called via `this.` at index.ts:196 and 220;
the only other `setGoogleOnboardingStatus` grep hit is an unrelated React
`useState` setter in `apps/agent-web/src/App.tsx`). By the pure goal it could be
private. Keeping it public is justified:
- It is picked by two settings-contract test fakes (`index.test.ts:9`,
  `user-settings.test.ts:39`). TypeScript cannot `Pick` a `private` member, so
  privatising it would force edits to both fakes (and their `setGoogleOnboardingStatus`
  fake impls at index.test.ts:43 / user-settings.test.ts:89).
- It clusters with `getSettings`/`updateSettings`, which architecture-review
  finding #3 will move behind the `Store` port; deferring avoids collision.

The cost/benefit (churn on two fakes for one method of RPC narrowing) supports
deferral. Reasonable.

### 6. Behavior genuinely preserved — CONFIRMED

- The 12 deletions are pure `this.store.X()` pass-throughs with zero call sites;
  runtime paths already go through `this.store`. Nothing changes at runtime.
- `private` is a compile-time-only modifier; the runtime methods still exist and
  `this.`-dispatch is unchanged. Cloudflare DO RPC only ever exposed them to the
  stub, and nothing called them over the stub, so narrowing has no runtime
  effect.
- No `Store`, adapter, orchestrator, alarm, route, or onboarding logic is
  touched. The 350-test suite passes unchanged (no test edits), matching the
  plan's "no test edits expected".

## Nits

- Plan step 4 hedges ("remove any that typecheck/lint flags as unused"). In
  practice all five type imports (`Message`, `Role`, `Thread`, `Topic`,
  `TopicMeta`) become unused and must be removed together; `Store` stays. The
  throwaway run confirms removing all five is correct and lint-clean. Not a
  defect, just a concretisation of the hedge.

## Counts

- Delete methods verified zero-stub-caller: **12 / 12**
- Privatise methods verified `this.`-only: **3 / 3**
- Keep methods verified (8 external callers + `alarm`/`constructor` framework +
  1 judgment-public): **11 / 11**
- `Pick<UserDO>` fakes referencing only kept methods: **4 / 4**
- Blockers: **0**  Concerns: **0**  Nits: **1**

Go.
