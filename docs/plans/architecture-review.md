# Architecture Review — deep-module opportunities

Scope: the `zero` monorepo, agent product first (`apps/agent-api`), then the
console side (`apps/vault-api`, `apps/errors-api`, packages, web/mobile). Method:
[review-architecture] + [deep-modules] vocabulary (shallow module, leaky
abstraction, temporal decomposition, info leakage, deletion test, ports &
adapters). Every finding cites files actually read. No code was changed.

The agent worker is, on the whole, well-layered and unusually well-documented.
Most seams already match the docs (`Store`, `WebSearch`, `PageFetcher`,
`GoogleWorkspace`, `AttachmentStore` ports; the single `runAgent` machine; the
runtime-agnostic orchestrator). The findings below are targeted, not a rewrite.

Ordered by leverage (highest first).

---

## 1. `UserDO` exposes ~13 dead pass-through RPC methods — HIGH

**Location:** `apps/agent-api/src/UserDO/index.ts` (the "Topic model" and
"Conversations and messages" blocks, lines ~57–120).

**What it is now:** `UserDO` re-declares one-line delegates to `this.store` for
`listTopics`, `getTopic`, `createTopic`, `updateTopicBody`,
`getTopicsWithBodies`, `saveTopic`, `getOutboundLinks`, `getBacklinks`,
`getOrCreateConversation`, `storeMessage`, `getConversationHistory`,
`findThreadsAwaitingReply`, plus `markProcessed`. Each is a public method on the
Durable Object class (so each is an RPC entry point).

**Symptom:** shallow module + dead interface. I grepped every caller: none of
these are invoked over the DO stub from outside the DO. Internal callers use
`this.store` directly (see `enqueueTurn` calling `this.store.getOrCreateConversation`
/ `this.store.storeMessage`; the orchestrator and tools take a `Store`, never the
DO). The only DO methods actually called externally are `enqueueTurn`
(webhook), `resetConversation` (`commands/new.ts`), `getTelegramId` /
`linkTelegram` / `unlinkTelegram` / `getSettings` / `updateSettings`
(`routes/*`), and `queueOnboarding` (`routes/onboarding.ts`). The topic/message
delegates are pure surface area with zero call sites.

**Why it matters:** the DO's *apparent* interface is ~3x its real one. An agent
(human or AI) reading `UserDO` to learn "what can I do to a user" sees a fake
topic/conversation API that duplicates the `Store` port it already has to learn.
It invites drift: someone could call `userDO.saveTopic(...)` over RPC and
silently bypass the `SystemTopicStore` read-only overlay reasoning. Deletion
test: removing them concentrates nothing (there is no caller) and shrinks the
class to its genuine responsibilities (identity, settings, idempotency, turn
execution).

**Proposed change:** delete the unused delegates. Keep only the methods with
external callers. `UserDO`'s public interface becomes: `enqueueTurn`, `alarm`,
`runTurn`/`runOnboarding` (internal), `queueOnboarding`, `resetConversation`,
`getTelegramId`/`linkTelegram`/`unlinkTelegram`, `getSettings`/`updateSettings`.
The `Store` port stays the one topic/conversation surface, which is the intended
design (docs/framework.md: "agents depend on the `Store` port … `UserDO` supplies
the production `DbStore` adapter").

**Blast radius / risk:** very low. Pure deletion of uncalled methods; typecheck
proves no caller. Delete or trim any `UserDO/index.test.ts` cases that only
exercised the delegates. **Size: S.**

---

## 2. Telegram `Bot` construction is duplicated 4x and already drifted — HIGH

**Location:** `apps/agent-api/src/telegram/chat-action.ts:13`,
`telegram/send-message.ts:18`, `telegram/files.ts:21`,
`routes/telegram-webhook.ts:327`.

**What it is now:** four sites each do
`const botInfo = JSON.parse(env.TELEGRAM_BOT_INFO); const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo, client: { apiRoot: env.TELEGRAM_API_ROOT } })`.

**Symptom:** duplicated logic + info leakage, and it has *already* produced a
latent bug. `chat-action.ts:13` is `new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo })`
— it omits `client: { apiRoot: env.TELEGRAM_API_ROOT }` that the other three
carry. So the typing-action call ignores `TELEGRAM_API_ROOT` and always targets
real Telegram, while every other call honors the override (dev/e2e mock server,
per docs/e2e-tests.md). Typing indicators are low-impact, so it went unnoticed —
which is exactly how duplicated construction rots.

**Why it matters:** the "how to become the bot" knowledge (parse the cached
`getMe` JSON, wire the api-root override) is copy-pasted, so a change (a new
client option, a header) has to be made in four places and one already fell out
of sync. Tests that want to assert against a mock Telegram have to know the
construction shape.

**Proposed change:** one factory, `createBot(env): Bot` in `telegram/` that owns
the `botInfo` parse + `client.apiRoot` wiring; all four sites call it. This is a
single-seam consolidation (in-process, no port needed — it is not a
test-substitution boundary, the mock already lives at `TELEGRAM_API_ROOT`).
Optionally go one step deeper to a small `TelegramClient` that also owns
`sendMessage` / `sendChatAction` / `getFile`, since those three modules are all
"env in, grammY call out" wrappers; but the factory alone removes the drift and
fixes the api-root bug.

**Blast radius / risk:** low, contained to `telegram/`. The api-root fix is a
behavior change (chat actions now honor the override) — desirable, and covered
by a changelog-free internal note. **Size: S** (factory) / **M** (full client).

---

## 3. `UserDO`'s own tables bypass the `Store` port — MEDIUM

**Location:** `apps/agent-api/src/UserDO/index.ts` — `markProcessed`,
`getSettings`, `updateSettings`, `setGoogleOnboardingStatus`, `getTelegramId`,
`linkTelegram`, `unlinkTelegram` all call `this.db` (do-orm) directly against
`telegramLink`, `userSettings`, `processedUpdates`.

**Symptom:** inconsistent seam + hard-to-test logic. Topics and conversations go
through the `Store` port (two adapters, a contract test, unit-testable with
`MemoryStore`). But identity, settings, and idempotency persistence live as raw
do-orm *inside the DO*, so they can only be tested through a real Durable Object.
`getSettings` / `updateSettings` / `setGoogleOnboardingStatus` each re-implement
the same "get row, branch on exists, insert-or-update, map nullable columns"
dance three times (lines ~290–324) — the kind of do-orm detail the `Store`
adapter was created to hide for topics.

**Why it matters:** the DO holds real logic (the settings insert-or-update
branching, the `isNewUser` signal, the onboarding-status state transitions) that
has no unit test surface short of booting `workerd` — which, per AGENTS.md, the
dev box can't even run. It also splits "what is persisted per user" across two
mental models (port vs inline), so a reader has to know which tables are behind
the abstraction and which aren't.

**Proposed change:** extend the `Store` port with the small identity/settings
surface (`getSettings`/`updateSettings`/`setOnboardingStatus`/`getTelegramLink`/
`setTelegramLink`/`markProcessed`) and move the do-orm bodies into `DbStore` +
`MemoryStore`, covered by the existing `store-contract.test.ts`. The DO keeps
only orchestration (alarm, turn wiring, R2 purge). This is the local-substitutable
category: the stand-in (`MemoryStore`) already exists, so the seam is internal
and needs no new port type.

**Blast radius / risk:** medium — touches both store adapters, the contract
test, and the DO, plus the settings routes' expectations. Mechanical, but wider
than #1/#2. **Size: M.**

---

## 4. Interface-agent no-silence delivery policy is buried in a 150-line function — MEDIUM

**Location:** `apps/agent-api/src/agents/interface.ts`, `runInterfaceAgent`
(the tail after `runAgent`, roughly lines 300–360: the "clean finish deliver
final message" branch, the echo guard, and the "cap cut-off / no reply"
fallback branch).

**Symptom:** hard-to-test seam + low locality. `runInterfaceAgent` assembles
tools, builds the conversation, marks cache breakpoints, runs the agent, renders
the transcript, logs, then applies a genuinely subtle decision: *given*
`finishReason`, the model's final `text`, and the `replies` already sent, decide
whether to deliver the final text, suppress it as an echo, or send
`FALLBACK_MESSAGE`. The docs (docs/topics.md) spend two paragraphs on why this is
right (the ack-then-answer / research-after-ack cases). That reasoning is only
reachable through the full agent run with a scripted model — the pure
decision has no direct test.

**Why it matters:** this is the exact place where "the user gets no answer" or
"the user gets a duplicate" regressions live, and it is regression-prone (the
comment describes a past bug where any earlier ack suppressed the real answer).
It is pure logic (`finishReason`, `text`, `lastReply`, `replies.length` → an
action) trapped inside I/O.

**Proposed change:** extract a pure `decideFinalDelivery({ finishReason, text,
replies }): { deliver: string | null; fallback: boolean }` and unit-test it
directly against the enumerated cases (clean-with-final, clean-echo,
clean-empty-no-reply, cap-cutoff, cap-with-replies). `runInterfaceAgent` calls
it and only performs the persist+send. Internal in-process seam; no port. The
existing end-to-end interface tests stay as coverage of the wiring, but the
branch matrix moves to fast pure tests.

**Blast radius / risk:** low-medium, contained to `interface.ts` and its test.
Behavior identical; the win is testability and locality. **Size: M.**

---

## 5. Clerk external-account lookup duplicated across token modules — LOW/MEDIUM

**Location:** `apps/agent-api/src/google-token.ts` (`getGoogleAccountEmail`,
and the token fetch), `github-token.ts` (`getGithubUsername`),
`admin-users.ts` — each builds `createClerkClient({ secretKey, publishableKey })`
and, for the provider lookup, `user.externalAccounts.find(a => a.provider.includes("google"|"github"))`.

**Symptom:** duplicated logic / shallow helpers. The "make a Clerk backend
client from env" and "find the external account for provider X" steps are
repeated in three files with the same shape and the same never-throw error
convention.

**Why it matters:** low individually, but it is the seam where a Clerk SDK bump
or an auth-convention change (e.g. token caching, error reporting) has to be
applied in parallel across files. It also blurs where "Clerk access" lives.

**Proposed change:** a tiny `clerk.ts` with `clerkClient(env)` and
`externalAccount(env, clerkUserId, provider) → { username, email, token }`, so
`google-token`, `github-token`, and `admin-users` share one Clerk seam. True
external (Clerk) — but a single production adapter is enough; these modules are
already mockable at the `getGoogleAccessToken`/`getGithubInstallationToken`
boundary the callers inject, so don't over-build a port here.

**Blast radius / risk:** low. **Size: S.**

---

## 6. `github-token.ts` is a dual-path capability with no consumer — LOW (watch)

**Location:** `apps/agent-api/src/github-token.ts`.

**What it is now:** `getGithubInstallationStatus` and
`getGithubInstallationToken` implement the same App-JWT → installation →
token flow twice (the file comment says so: "Mirrors the token flow
step-for-step"). The header also states "there is no consumer of the token yet
(the container that ran git/gh was removed)."

**Symptom:** duplicated flow + speculative surface. Only the *status* path is
wired (admin GitHub-status route); the *token* path has no caller.

**Why it matters:** it is dead-ish code kept warm for a future GitHub coding
capability. Not urgent, but flagged so it doesn't quietly rot like #2 did. If the
capability is coming soon, fold the two paths into one internal helper
(`resolveInstallation(env, userId) → { username, installationId, mint() }`) so
status and token share it. If it is not coming, consider deleting the token path
until there is a consumer.

**Blast radius / risk:** low. **Size: S.**

---

## What's already good (do not refactor)

- **`Store` port + `DbStore`/`MemoryStore` + `store-contract.test.ts`**
  (`store/*`). Textbook local-substitutable seam; the contract test is what makes
  the agent/orchestrator unit tests trustworthy. The `[[Name]]` link invariant
  (`syncOutboundLinks`, `store/links.ts`) is isolated as pure helpers plus adapter
  logic — correct split.
- **`SystemTopicStore` decorator** (`store/system-topics.ts`). Read-only system
  topics enforced structurally at the store boundary, not by prompt — a deep
  module that hides the overlay from every consumer.
- **The single `runAgent` machine** (`agents/run.ts`) driving four agents
  (interface/research/writer/onboarding) with different prompts+tools. High
  leverage, genuinely deep: caching, step cap, usage extraction all hidden.
- **True-external ports:** `WebSearch`/`brave.ts`, `PageFetcher`/`tavily.ts`,
  `GoogleWorkspace`/`rest.ts`, `AttachmentStore`/`r2.ts`, `model.ts`. Each hides a
  lot (Brave 429 retry, Tavily extract caps, Gmail MIME/base64url/multi-calendar
  fan-out, AI-Gateway BYOK tagging) behind small flat interfaces with an
  in-memory test adapter. `google/rest.ts` is the deepest and best example.
- **Runtime-agnostic `orchestrator.ts`** and the DO-free `do/alarm.ts` /
  `do/onboarding.ts` extractions. The alarm's backoff/circuit-breaker logic is
  testable without a Durable Object — exactly the right seam given the workerd
  limitation.
- **`processTelegramMessage` + `WebhookDeps`** (`routes/telegram-webhook.ts`).
  The message pipeline is injectable and unit-tested without grammY or a DO.
- **Console side:** `errors-api/services/ErrorsService.ts` + `notify/notifier.ts`
  (clean services layer with a `Notifier` port), `vault-api/ProjectVaultDO`
  (envelope encryption fully hidden; "the DO IS the project"), and
  `vault-api/vaults.ts` (single DO-resolution seam). These are healthy; leave
  them.

## Tightly coupled but fine as-is

- **`UserDO.runTurn` wiring six adapters inline** (search, fetcher, google,
  timezone, setTimezone, send). This is a composition root — the correct place to
  assemble concrete adapters per turn. It reads top-to-bottom and each dependency
  is threaded once. Do not extract a "TurnDeps builder"; that would add
  indirection without a second caller (one-adapter-means-hypothetical-seam).
- **Prompts as large string literals in `agents/prompts.ts`.** Cohesive, easy to
  diff, no logic. Fine.
- **`agents/run.ts` `AGENT_MAX_STEPS = 200` shared by all agents.** Coupling is
  intentional and documented; not a seam problem.

---

## Ranked shortlist (turn into tasks)

1. **Trim `UserDO`'s dead RPC surface** — delete the ~13 uncalled
   topic/conversation delegates; keep only externally-called methods. (S, low
   risk, biggest navigability win.)
2. **`createBot(env)` Telegram factory** — one construction site; fixes the
   `chat-action.ts` missing-`apiRoot` drift so typing actions honor
   `TELEGRAM_API_ROOT`. (S, fixes a latent bug.)
3. **Move `UserDO`'s settings/link/idempotency tables behind the `Store` port**
   — one persistence model, unit-testable without workerd, kill the 3x
   insert-or-update duplication. (M.)
4. **Extract `decideFinalDelivery` pure fn from `runInterfaceAgent`** — direct
   tests for the no-silence/echo/fallback branch matrix where duplicate/silent
   regressions live. (M.)
5. **Shared `clerk.ts` seam** — one Clerk client + `externalAccount(provider)`
   helper for `google-token`/`github-token`/`admin-users`. (S, low.)

[review-architecture]: ../../.agents/skills/review-architecture/SKILL.md
[deep-modules]: ../../.agents/skills/deep-modules/SKILL.md
