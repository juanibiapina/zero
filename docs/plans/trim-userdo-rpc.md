# Trim UserDO's dead RPC surface

## Goal

UserDO exposes ~13 topic/conversation delegate methods as Durable Object RPC
that have ZERO external callers (internal code uses `this.store` directly).
Remove the dead RPC methods so the DO's public interface shrinks to what's
actually called across DO boundaries. Preserve behavior exactly — this is
interface pruning, not logic change.

## Background

`UserDO` (`apps/agent-api/src/UserDO/index.ts`) is the per-user Durable Object.
Cloudflare exposes every **public** method of a DO class as an RPC entry point
reachable through the stub (`getUserDO(env, clerkUserId)` in `UserDO/stub.ts`,
which wraps `env.USER_DO.get(id)`). So each public method widens the DO's real
network interface.

The intended topic/conversation surface is the `Store` port (`store/types.ts`),
supplied in production by `DbStore` wrapped in `SystemTopicStore`
(`this.store` in the DO). Agents, tools, the orchestrator, the alarm, and
onboarding all depend on `Store`, never on the DO stub, for topics and
messages. `UserDO` nonetheless re-declares one-line `this.store.X()` delegates
for the whole topic/conversation API. Those delegates are pure surface area:
nothing calls them over the stub, and the DO's own code already calls
`this.store.X()` directly (e.g. `enqueueTurn` uses
`this.store.getOrCreateConversation` / `this.store.storeMessage`; `alarm` uses
`this.store.findThreadsAwaitingReply`). This is the deletion test passing
cleanly: removing the delegates concentrates nothing because there is no caller.

This is finding #1 of `docs/plans/architecture-review.md` (HIGH, size S). It is
the biggest navigability win: today the DO's *apparent* interface is ~3x its
real one, duplicating the `Store` port a reader already has to learn, and
inviting drift (someone could call `userDO.saveTopic(...)` over RPC and bypass
the `SystemTopicStore` read-only overlay).

## Evidence: method-by-method call-site audit

Every public method of `UserDO` was grepped across the whole repo (worker
routes, alarm/turn code, webhook, `apps/agent-api` tests, `packages/agent-e2e`,
and all `USER_DO` binding / stub usages). "External caller" means a call through
the DO stub (`userDO.method(...)` / `getUserDO(...).method(...)`), not a call on
a `Store` instance.

| Method | External stub caller(s) found | Disposition |
|---|---|---|
| `listTopics` | none (only `store.listTopics` / `this.inner` / tests) | **delete** |
| `getTopic` | none (only `store.getTopic` / tools / tests) | **delete** |
| `createTopic` | none (only `store.createTopic` / tools / tests) | **delete** |
| `updateTopicBody` | none (only `store.updateTopicBody` / tests) | **delete** |
| `getTopicsWithBodies` | none (only `store.getTopicsWithBodies` / tests) | **delete** |
| `saveTopic` | none (only `store.saveTopic` / tools / tests) | **delete** |
| `getOutboundLinks` | none (only `store.getOutboundLinks` / tests) | **delete** |
| `getBacklinks` | none (only `store.getBacklinks` / tools / tests) | **delete** |
| `getOrCreateConversation` | none (only `store.*` / orchestrator / tests) | **delete** |
| `storeMessage` | none (only `store.*` / orchestrator / tests) | **delete** |
| `getConversationHistory` | none (only `store.*` / orchestrator / tests) | **delete** |
| `findThreadsAwaitingReply` | none (only `store.*` / alarm via `this.store` / tests) | **delete** |
| `markProcessed` | none (called only via `this.markProcessed` in `enqueueTurn`) | **make private** |
| `runTurn` | none (called only via `this.runTurn` in `alarm`) | **make private** |
| `runOnboarding` | none (called only via `this.runOnboarding` in `alarm`) | **make private** |
| `setGoogleOnboardingStatus` | none in production (called via `this.` in `queueOnboarding`/`runOnboarding`; only test fakes reference it) | **keep public** (see judgment note) |
| `enqueueTurn` | `routes/telegram-webhook.ts:360` | keep |
| `resetConversation` | `commands/new.ts:30` | keep |
| `queueOnboarding` | `routes/onboarding.ts:44` | keep |
| `getTelegramId` | `routes/admin.ts:105`, `routes/user-settings.ts:49` | keep |
| `linkTelegram` | `routes/user-settings.ts:92` | keep |
| `unlinkTelegram` | `routes/user-settings.ts:123` | keep |
| `getSettings` | `routes/admin.ts:106`, `routes/user-settings.ts:163/200/206` | keep |
| `updateSettings` | `routes/user-settings.ts:205` | keep |
| `alarm` | DO runtime override (must stay public) | keep |
| `constructor` | DO runtime | keep |

Confirmation of the finding's "~13": the 12 topic/conversation delegates +
`markProcessed` = **13 dead-RPC methods**, exactly as the review claimed.
`resetConversation` sits in the same "Conversations and messages" block but has a
real external caller (`commands/new.ts`) and stays.

### Judgment note on `setGoogleOnboardingStatus`

It is internal-only in production (no route or webhook calls it through the
stub; it is driven by `this.setGoogleOnboardingStatus(...)` inside
`queueOnboarding` and `runOnboarding`). By the goal it could be made private
too. It is left **public** here on purpose:

- It is part of the settings cluster (`getSettings` / `updateSettings` /
  `setGoogleOnboardingStatus`) that architecture-review **finding #3** will move
  behind the `Store` port. Restructuring it now collides with that task.
- Two test fakes `Pick<UserDO, ... "setGoogleOnboardingStatus">`
  (`UserDO/index.test.ts`, `routes/user-settings.test.ts`). Privatising it forces
  churn on both settings-contract fakes for marginal gain.

Making it private is deferred to finding #3. This keeps #1 tight and focused on
the unambiguous dead delegate surface.

## What to change and why

File: `apps/agent-api/src/UserDO/index.ts`.

1. **Delete the 12 topic/conversation delegate methods** (the entire
   "Topic model (delegated to the Store)" block and the topic/conversation
   delegates in the "Conversations and messages" block, *except*
   `resetConversation`): `listTopics`, `getTopic`, `createTopic`,
   `updateTopicBody`, `getTopicsWithBodies`, `saveTopic`, `getOutboundLinks`,
   `getBacklinks`, `getOrCreateConversation`, `storeMessage`,
   `getConversationHistory`, `findThreadsAwaitingReply`.
   Keep `resetConversation` (external caller). These are pure `this.store.X()`
   pass-throughs with no callers; deletion removes RPC surface only.

2. **Make `markProcessed` private** (`private markProcessed(...)`). It holds real
   `this.db` logic (dedupe insert into `processedUpdates`) but its only caller is
   `this.markProcessed(input.updateId)` in `enqueueTurn`. Private removes it from
   the RPC surface without touching behavior.

3. **Make `runTurn` and `runOnboarding` private.** Both are internal-only
   (called via `this.runTurn(...)` / `this.runOnboarding()` in `alarm`). This
   matches the review's "(internal)" annotation and tightens the RPC surface.
   Note `alarm` must stay a public `override`, and `enqueueTurn` /
   `queueOnboarding` stay public (webhook / route callers).

4. **Prune now-unused type imports.** After deletion, `Message`, `Role`,
   `Thread`, `Topic`, `TopicMeta` (imported from `../store/types` only for the
   delegate signatures) may become unused. Remove any that the typecheck/lint
   flags as unused; keep `Store` (used for the `this.store` field). Let
   typecheck/lint drive exactly which imports to drop.

Resulting `UserDO` public interface: `constructor`, `alarm`, `enqueueTurn`,
`queueOnboarding`, `resetConversation`, `getTelegramId`, `linkTelegram`,
`unlinkTelegram`, `getSettings`, `updateSettings`, `setGoogleOnboardingStatus`.

## How behavior is preserved

- The 12 deletions are of methods with **zero call sites** (typecheck is the
  proof: any surviving stub caller would fail to compile). Internal code already
  goes through `this.store`, so runtime paths are untouched.
- `markProcessed` / `runTurn` / `runOnboarding` change **visibility only**
  (`private`), not bodies. TypeScript `private` is compile-time; the runtime
  method still exists and `this.`-calls still resolve. Cloudflare DO RPC only
  ever exposed these to the stub, and nothing used them over the stub, so
  narrowing visibility has no runtime effect.
- No `Store`, adapter, orchestrator, alarm, or route logic is modified.

## Test impact

- `UserDO/index.test.ts`: `Pick<UserDO, ...>` lists
  `getTelegramId | linkTelegram | unlinkTelegram | getSettings | updateSettings |
  setGoogleOnboardingStatus` — all **kept public**. No change needed. It never
  references a deleted delegate or `markProcessed`/`runTurn`/`runOnboarding`.
- `commands/new.test.ts`: `Pick<UserDO, "resetConversation">` — kept. No change.
- `routes/onboarding.test.ts`: `Pick<UserDO, "queueOnboarding">` — kept. No change.
- `routes/user-settings.test.ts`: Picks only kept public methods. No change.
- `packages/agent-e2e`: no references to any deleted/privatised method. No change.
- Store behavior stays covered by `store/store-contract.test.ts` and
  `store/system-topics.test.ts` (the real topic/conversation contract), which
  never went through the DO delegates. No test is lost.

Net: no test edits expected. If the typecheck surfaces an unused-import lint
error after deletion, fix by removing the unused type import (step 4).

## Verification

Per AGENTS.md the dev box cannot boot `workerd`, so run the touched package
directly and rely on GitHub Actions CI for the workerd-backed suites (e2e,
cross-worker build):

```bash
pnpm --filter @zero/agent-api run lint
pnpm --filter @zero/agent-api run typecheck
pnpm --filter @zero/agent-api run test
```

Typecheck is the key gate: it proves no caller referenced a deleted method (a
dangling `userDO.saveTopic(...)` would fail to compile). Lint catches any import
left unused after the deletions.

## Changelog

None. This is an internal interface-pruning refactor with no user-observable
behavior change, so per AGENTS.md it gets no changelog entry.

## Skills to use

- `deep-modules` — the deletion test and "don't expose internal seams through
  the interface" framing that justifies the deletes and the `private` narrowing.
- `code` — executing the edits.
- `git-commit` — when committing.

## Acceptance criteria

- The 12 dead topic/conversation delegate methods are removed from
  `UserDO/index.ts`; `resetConversation` remains.
- `markProcessed`, `runTurn`, `runOnboarding` are `private`; `alarm`,
  `enqueueTurn`, `queueOnboarding`, `resetConversation`, `getTelegramId`,
  `linkTelegram`, `unlinkTelegram`, `getSettings`, `updateSettings`,
  `setGoogleOnboardingStatus` remain public.
- `pnpm --filter @zero/agent-api run lint`, `typecheck`, and `test` pass with no
  test edits (or only the unused-import cleanup from step 4).
- No changelog entry added.
```
