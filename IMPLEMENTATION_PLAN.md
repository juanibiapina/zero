# Zero Rewrite — Implementation Plan

Actionable plan to build the meta-agent system designed in `PLAN.md`. This
document is grounded in the current codebase and resolves the gaps `PLAN.md`
leaves open (persistence layer, LLM access, cleanup scope, typing indicator).

## Goal

Replace the container-based `pi-coding-agent` with an in-DurableObject
two-phase meta-agent system (interface agent + writer agent) backed by a topic
knowledge model stored in `UserDO` SQLite. See `PLAN.md` for the full design
and rationale.

## Grounding: what already exists

- **`UserDO`** (`apps/api/src/UserDO/index.ts`): `DurableObject` using **do-orm**.
  Tables defined in `db/schema.ts` via `table()`/`column()`; migrations are
  numbered `.sql` files in `db/migrations/`, imported and registered in
  `db/migrations.ts`, applied by `migrate()` in `blockConcurrencyWhile`. Query
  API: `db.all(table, { where, orderBy: asc/desc, limit })`, `db.get`,
  `db.insert`, `db.insertReturning`, `db.update`, `db.delete`, with `eq`, `and`,
  `asc`, `desc` from do-orm. Adding a table means editing **both** `schema.ts`
  and adding a new `NNNN_*.sql` migration wired into `migrations.ts`.
- **Typing indicator**: `markSessionActive`/`markSessionIdle` + `alarm()`
  re-send Telegram `chatAction` every 4s while any session row has
  `status="active"`. Keyed off the `sessions` table, which this rewrite
  removes; the mechanism must be reworked (see Phase 3).
- **Webhook** (`routes/telegram-webhook.ts`): grammY `webhookCallback`, resolves
  a `TopicContext` (telegramId, chatId, topicId; DMs use topicId=0), downloads
  attachments, then calls `processTopicMessage` via `waitUntil`. Commands
  `/new`, `/abort`, `/status` route to `commands/*`.
- **LLM access today**: the container runs pi with pi-ai's
  `cloudflare-ai-gateway` provider. Requests hit **Cloudflare AI Gateway**
  authenticated with `cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>`; the
  gateway holds the BYOK Anthropic key (Anthropic bills directly). Per-user
  attribution is added via `cf-aig-metadata: {"user_id": …}` (see
  `ai-gateway.ts`). Env carries `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`,
  `MODEL_ID=claude-sonnet-4-6`, and the `CLOUDFLARE_API_KEY` secret.

## LLM access decision (resolved)

Call the LLM from the worker/DO with the **`ai` SDK + `@ai-sdk/anthropic`**,
routed **through the existing Cloudflare AI Gateway** (not the raw Anthropic
API). Rationale: keeps BYOK billing, per-user spend limits, and analytics that
already exist; no new secret. **No Cloudflare Agents SDK** (`agents`,
`@cloudflare/ai-chat`) is needed — it is a stateful chat framework with no
gateway integration of its own; it would just call the same AI SDK. `UserDO`
already provides the DO + orchestration, so use the plain AI SDK inside it.

Confirmed working pattern (cloudflare/agents issue #511, AI Gateway Workers
Bindings docs) for an **authenticated gateway with a stored Anthropic provider
key (BYOK)** — Zero's exact setup:

```ts
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({
  apiKey: "",                                     // MUST be present; see note
  baseURL: await env.AI.gateway(env.CLOUDFLARE_GATEWAY_ID).getUrl("anthropic"),
  headers: {
    "cf-aig-authorization": `Bearer ${env.CLOUDFLARE_API_KEY}`,
    "cf-aig-metadata": JSON.stringify({ user_id: clerkUserId }),
  },
});
// generateText({ model: anthropic(env.MODEL_ID), ... })
```

Key facts:

- **`apiKey: ""` is required.** `@ai-sdk/anthropic` throws if neither `apiKey`
  nor `ANTHROPIC_API_KEY` env exists, even though the real Anthropic key lives
  in the gateway. Pass an empty string; do **not** add an Anthropic secret.
- **`cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>`** authenticates to the
  gateway; the gateway injects the stored Anthropic `x-api-key` upstream. The
  gateway token is the same `CLOUDFLARE_API_KEY` the container's secret-proxy
  substitutes today.
- **`cf-aig-metadata: {"user_id": clerkUserId}`** reproduces `ai-gateway.ts`'s
  per-user tagging directly from the worker (analytics + split-by-value spend
  limits). Headers are per-provider-instance, so build the provider per request
  (cheap) to tag each user.
- **Add the `ai` binding** to `wrangler.jsonc` (`"ai": { "binding": "AI" }`) so
  `env.AI.gateway(id).getUrl("anthropic")` builds the endpoint (avoids
  hardcoding account/gateway ids) and enables `patchLog`/`getLog` for cost
  tracking later. Alternatively hardcode the URL from `CLOUDFLARE_ACCOUNT_ID`/
  `CLOUDFLARE_GATEWAY_ID`; the binding is preferred.
- Wrap this in a small `agents/model.ts` factory taking `(env, clerkUserId)` so
  both agents share config and per-user tagging.

Model ids: interface agent uses `MODEL_ID` (`claude-sonnet-4-6`); writer can
use the same to start (revisit for quality later). The AI SDK passes the id
straight to the Anthropic Messages API through
the gateway; smoke-test one `generateText` call before Phase 2 to confirm the
id is accepted.

## Architecture: deep modules (runtime-agnostic)

The system's essential logic is independent of how Cloudflare runs it. Design
the deep modules first, put ports at the true-external seams, then choose an
implementation per seam based on the runtime. Two agents only: a **stateless
interface agent** (manages topics, generates replies) and **one writer agent**.
No router, no per-topic agents, no separate routing pass — the interface agent
discovers topics itself via its tools.

### Modules

1. **TopicStore** — the knowledge model + conversation persistence. Owns topics
   (list/get/create/update/save) and conversation threads + messages. Pure
   logic over a storage seam.
2. **InterfaceAgent** — stateless per turn. Given the user message, conversation
   history, a TopicStore, an LLM, and a reply sink, it runs the tool loop
   (`reply`, `list_topics`, `get_topic`, `create_topic`, `update_topic`),
   sending replies as it goes and tracking the set of topics it touched. Hides
   the agent loop behind one call: `run(input) -> { replies, accessedTopics }`.
3. **WriterAgent** — stateless per turn. Given the accessed topics and the
   exchange, consolidates durable knowledge into each topic via a single
   `save_topic` tool (merge into sections + one `## Log` line; refresh
   description/summary; never rewrite/compact). One call:
   `run({ topics, exchange }) -> void` (writes through TopicStore).
4. **TurnOrchestrator** — in-process glue = `handleMessage` logic. Load/create
   the thread, store the user message, run InterfaceAgent, persist replies, then
   run WriterAgent over the accessed topics. Knows nothing about alarms, DOs, or
   Telegram — only the modules and ports below.

### Seams and dependency classes

| Seam | Class (deep-modules) | Port? | Prod adapter | Test adapter |
|------|----------------------|-------|--------------|--------------|
| LLM | true external | **yes** | AI SDK `generateText` through AI Gateway | mock model (scripted tool calls) |
| Reply sink (messenger) | true external | **yes** | Telegram `sendMessage` | capture array |
| Storage | local-substitutable | **yes** (2 adapters justified) | DO SQLite via do-orm | in-memory store |
| Execution / keep-alive | runtime | n/a (chosen impl) | **DO alarm (locked)** | direct call in tests |

The two agents and the orchestrator are the deep modules; the **interface is the
test surface**. Tests drive the orchestrator with the mock LLM + capture sink +
in-memory store and assert observable outcomes (replies sent, topics written).
No Telegram, no DO, no network in unit tests.

### Choosing the implementation per seam (by runtime)

The deep modules do not change with the runtime; only the adapters do.

- **LLM**: `generateText`/`stepCountIs` through the AI Gateway — same on raw DO
  or Agents SDK. Locked.
- **Reply sink**: Telegram HTTP helper — same either way. Locked.
- **Storage**: (a) raw DO SQLite via do-orm (our current stack), or (b) Agents
  SDK `this.sql` / a `Session` `SkillProvider` over topics. do-orm is less code
  now; Session buys prompt assembly, prefix caching, and compaction if adopted.
- **Execution / keep-alive** (the one that forced this discussion): **locked to
  a DO alarm** (15 min wall-clock budget, our stack). See the Execution model
  section below. Graduation paths behind this seam, if turns later grow long or
  expensive: Agents SDK **Fiber** (`runFiber`/`keepAlive`, auto-recovery) or
  **granular Workflows** (per-step durability, but reshapes InterfaceAgent into
  a hand-rolled step loop — a bigger change than swapping the adapter).

Decision: implement all four modules against the three ports now, with the
**raw-DO adapters** (do-orm storage + DO-alarm execution). Because the logic
sits behind ports, we can swap in Agents SDK adapters (Session storage, Fiber
execution) later without touching the agents or orchestrator. Adopt the Agents
SDK wholesale only if Session memory + Fiber recovery are worth conforming
`UserDO` to the `Agent` base class.

## Execution model (DO alarm) — locked

The turn runs **inside `UserDO`** (so topic tools hit local SQLite and replies
go straight to Telegram — no per-tool RPC), triggered by a **DO alarm** with a
15-minute budget. The webhook never runs the turn (its `waitUntil` caps at 30s).

1. **Webhook enqueues, returns 200.** On a message, resolve `clerkUserId` from
   `KV.get(tg:{telegramId})` and call `userDO.enqueueTurn({ updateId, chatId,
   topicId, text })` inside `waitUntil` (spans only the fast enqueue). Return
   200 immediately so Telegram does not retry.
2. **`enqueueTurn` (cheap, synchronous).** Dedupe on `updateId` via
   `processed_updates`; get/create the conversation; `storeMessage(user)`; arm
   the alarm (`setAlarm(Date.now())`) if none is scheduled. No LLM work.
3. **`alarm()` = the turn runner (15 min).** Find threads awaiting a reply
   (tail message role is `user`), run the orchestrator for each, then re-arm if
   more arrived while running. DO alarms **auto-retry** on throw/eviction (the
   alarm is not cleared until the handler completes), giving crash durability.
4. **`runTurn` (orchestrator, inside the DO).** Mark `busy_since = now`; start
   the typing loop; load history; run InterfaceAgent (tools read/write the
   local do-orm store and call `sendMessage` directly, tracking `accessed`);
   persist replies; if `accessed` is non-empty, run WriterAgent; in `finally`,
   stop typing and clear `busy_since`.
5. **Typing = local `setTimeout`, not the alarm timer.** A self-rescheduling
   `setTimeout(tick, 4000)` re-sends `chatAction` every 4s (Telegram's action
   expires ~5s) and fires once immediately; cleared in `finally`. While
   `generateText` awaits an LLM call the isolate is idle, so the timer fires.
   This keeps the single DO alarm free for turn scheduling — no multiplexing.
6. **Concurrency.** `UserDO` is single-threaded with input gates: an incoming
   `enqueueTurn` can slot in between the running alarm's awaits, append its
   message, and be picked up by the end-of-alarm re-arm check. Turns for one
   `(chatId, topicId)` are serialized; no overlap.
7. **Idempotency / durability.** `processed_updates` dedupes fully re-delivered
   webhooks. Alarm auto-retry covers crashes but can re-run a partially-sent
   turn (re-send). For MVP, accept the rare mid-turn duplicate; a per-turn
   reply-progress marker can be added later if needed.

## Conversation UX: live progress replies

The `reply()` tool sends **immediately**, and the conversation prompt instructs
the agent to narrate as it works: a quick acknowledgement first ("Got it, let me
check that."), then the answer, optionally more messages in between. Users see
the agent respond within a second or two and watch it progress, instead of
staring at a typing indicator until a single final message lands. This is why
`reply()` is a streaming tool and not a return value: interstitial feedback is
the point. The typing indicator still runs (local 4s `setTimeout` loop, see
Execution model) to cover gaps between replies.

## What to build (module by module)

Follow the module layout in `PLAN.md` § Module Structure. Concrete deltas:

### Phase 1 — Persistence in UserDO

1. `db/schema.ts`: add `topics`, `conversations`, `messages` tables (columns per
   `PLAN.md` § SQLite Schema, with these deviations). `topics` uses a
   **surrogate integer PK** (`id INTEGER PRIMARY KEY AUTOINCREMENT`) with `name`
   as a separate `TEXT NOT NULL UNIQUE` column — not `name` as PK. This gives a
   stable identity, makes rename a one-field `name` update (with a uniqueness
   check), and lets future foreign keys point at `id`. `messages` uses an
   autoincrement id. Add a nullable `busy_since` (ISO timestamp) column on
   `conversations` to mark a thread mid-turn (used by the typing loop / stale
   guard) — no separate table, since `conversations` is already 1:1 on
   `(chatId, topicId)` and its row always exists before processing. Add a
   `processed_updates(update_id TEXT PRIMARY KEY, created_at TEXT)` table for
   webhook idempotency (see Execution model). Note do-orm `table()` may not
   express `CHECK`/`REFERENCES`; put those constraints in the raw `.sql`
   migration and keep the schema.ts shape aligned.
2. Add migrations `0011_topics.sql`, `0012_conversations.sql`,
   `0013_messages.sql`, `0014_processed_updates.sql`; register in
   `db/migrations.ts` (`busy_since` is part of the `conversations` migration).
3. `UserDO` methods (plain methods, callable through the stub):
   - `getOrCreateConversation(chatId, topicId): string` (UNIQUE(chat_id,topic_id);
     generate id, e.g. `crypto.randomUUID()`).
   - `storeMessage(conversationId, role, content)`.
   - `getConversationHistory(conversationId, limit)` → ordered `Message[]`
     (`orderBy: asc("id")`, bound to last N; N≈20).
   - Topic CRUD: `listTopics()`, `getTopic(name)`, `createTopic(name, desc)`,
     `updateTopicBody(name, body)`, `getTopicsWithBodies(names)`,
     `saveTopic(name, {body, description, summary}, newName?)`. Lookups are by
     `name` (what the agent knows); the surrogate `id` is internal. Rename is a
     simple `name`-column update guarded by a uniqueness check (`uniqueName`
     collision handling); no PK churn. Update
     `last_active_at` on writes.
   - Turn plumbing: `enqueueTurn({updateId, chatId, topicId, text})` (dedupe on
     `processed_updates`, store user message, arm alarm), `markProcessed`,
     `findThreadsAwaitingReply()` (tail message role is `user`), `markBusy` /
     `clearBusy`.
4. Unit tests mirroring `UserDO/index.test.ts` for every method.

### Phase 2 — Agents and tools

1. `agents/model.ts`: gateway-backed anthropic provider factory (above).
2. `agents/prompts.ts`: interface + writer system prompts.
   The interface prompt must instruct the agent to **reply immediately with
   short progress messages** as it works, not only at the end — e.g. send
   "Got it, let me check that." via `reply()` before doing topic lookups, then
   the substantive answer via another `reply()`. This live feedback is a
   product requirement (the user should see the agent acknowledge and narrate),
   enabled by `reply()` sending each message the instant it is called.
3. `tools/topics.ts`: factory `buildInterfaceTools(accessed, send, db)`
   returning `reply`, `list_topics`, `get_topic`, `create_topic`,
   `update_topic` as `ai` SDK tools (zod params, `execute`). `reply(text)`
   **sends to Telegram immediately** (via the DO send helper, step below) and
   also appends to the internal replies list for persistence. Every topic
   read/write adds the topic name to the `accessed` set. Tools operate on the
   DO db directly (they run inside the DO).
4. `agents/interface.ts`: `runInterfaceAgent` using `generateText` with
   `stopWhen: stepCountIs(10)` (ai SDK v5) / `maxSteps: 10` (v4 — pin version
   and match its API). Feeds history as `messages`, new message last. The agent
   discovers topics itself through `list_topics`/`get_topic`; there is no
   separate routing pass.
5. `tools/save-topic.ts` + `agents/writer.ts`: `runWriterAgent` with the single
   `save_topic` tool and the body-consolidation policy (merge new durable facts
   into sections + one `## Log` line per exchange; never rewrite/compact;
   refresh description + summary). Include a fallback-append so nothing is lost
   if the model skips a tool call.
6. Integration tests with a mocked model (ai SDK provides `MockLanguageModelV*`
   / simulate tool calls) asserting: replies collected + sent, accessed set
   tracked, writer called per accessed topic.

### Phase 3 — Orchestration + Telegram

See the **Execution model (DO alarm)** section for the full flow; this phase
builds it.

1. `telegram/send-message.ts`: helper `sendMessage(env, chatId, topicId, text)`
   that builds a grammY `Bot` from `env` (like `chat-action.ts`) and calls
   `formatAndSend(text, (t, mode) => bot.api.sendMessage(chatId, t, {
   message_thread_id, parse_mode }))`. `formatAndSend` is already
   transport-agnostic, so no relocation is needed. The `reply` tool and
   `runTurn` close over this to send from inside the DO.
2. `UserDO.runTurn(conv)`: the TurnOrchestrator, run from `alarm()`. Marks
   `busy_since`, starts the typing loop, loads history, runs InterfaceAgent
   (tools use the local do-orm store and `sendMessage`, tracking `accessed`),
   persists replies, runs WriterAgent when `accessed` is non-empty, and in
   `finally` stops typing + clears `busy_since`. No value returned to any caller
   (replies already went out).
3. `UserDO.alarm()`: the turn runner. Drain `findThreadsAwaitingReply()`,
   `runTurn` each, re-arm (`setAlarm(Date.now())`) if more remain. Relies on DO
   alarm auto-retry for crash durability.
4. Typing loop: a self-rescheduling `setTimeout(tick, 4000)` inside `runTurn`
   that re-sends `chatAction` (fires once immediately, cleared in `finally`).
   Not the DO alarm timer — that stays dedicated to turn scheduling.
5. `routes/telegram-webhook.ts`: replace the `processTopicMessage` call with a
   fast `getUserDO(env, clerkUserId).enqueueTurn({ updateId, chatId, topicId,
   text })` inside `waitUntil`, then return 200. Resolve `clerkUserId` from
   `KV.get(tg:{telegramId})` (as `process-topic-message.ts` does today). For
   MVP, drop attachments with a notice (out of scope for the topic model
   initially).
6. Commands (locked): keep **`/new`** — reset the conversation thread for this
   `(chatId, topicId)` (delete/rotate the `conversations` row + its `messages`;
   leave topics intact). **Drop `/abort`** (synchronous in-DO turn, nothing to
   abort) and **`/status`** (no session/context-window metric anymore). Removed
   in commit 8d.

### Phase 4 — Cleanup

Remove container + session machinery once the new path works:

- Delete `AgentContainer.ts`, `agent-client.ts`, `process-topic-message.ts`,
  `handle-agent-end.ts`, `secret-proxy.ts`, `ai-gateway.ts` (fold its
  metadata-tagging into `agents/model.ts`), and the `commands/*` that can't be
  reworked. **Tasks are parked, not deleted**: strip the container dependency
  from `tasks.ts`/`routes/tasks.ts` but keep `/api/tasks` as a no-op stub (202)
  so the web onboarding call keeps working; reimplement as a meta-agent turn
  later.
- Remove `packages/agent-server/` and its deps (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai`, `@cloudflare/containers`).
- `wrangler.jsonc`: remove `containers`, the `AGENT_CONTAINER` DO binding,
  export of `AgentContainer`/`ContainerProxy` in `index.ts`, add a migrations
  tag deleting the `AgentContainer` class. Keep `USER_DO`. Add the `ai` binding
  (`"ai": { "binding": "AI" }`) for gateway URL resolution (see LLM access).
- `index.ts`: stop exporting `AgentContainer`/`ContainerProxy`.
- Drop the `sessions` table usage in `UserDO` (leave the physical table or add a
  migration to drop it; no user data lost).
- **Cost tracking**: drop the custom path entirely — remove `SESSIONS_DB`, the
  `d1_databases` binding in `wrangler.jsonc`, and `admin.ts`'s cost view (or
  repoint it at the gateway). The AI Gateway already logs per-request model,
  tokens, and USD cost, attributed per user via the `cf-aig-metadata` we send.
  Re-add an in-app view later from the gateway (`env.AI.gateway(id).getLog` +
  `aiGatewayLogId`, or the gateway REST API) if wanted.
- R2 `AGENT_STATE_BUCKET`: remove binding (no more state.tar.gz) unless kept for
  future attachments.

Add deps: `ai`, `@ai-sdk/anthropic` (pin major versions; the `maxSteps`
vs `stopWhen` API differs between v4 and v5 — write code against the installed
version).

## System-wide impact

- **Auth flow unchanged**: Clerk + Telegram-login link (`KV tg:*`, `telegramLink`
  table) stays. Only the message-processing path changes.
- **Callbacks gone**: `/message-end`, `/agent-end`, `/state`, `/close-session`
  lived inside `AgentContainer.fetch`; removed with the container. No external
  caller depends on them.
- **Cost tracking**: previously via `/agent-end` → `SESSIONS_DB`. Dropped; the
  AI Gateway logs per-user cost/tokens directly (fed by `cf-aig-metadata`). No
  custom path in the new design (see Phase 4).
- **CPU/wall limits**: two sequential agents with several tool round-trips run
  in the **DO alarm** (15-min wall budget), not the webhook's `waitUntil` (30s).
  CPU time is billed separately (subrequest/LLM wait is not CPU; avg Worker
  ~2.2ms), so the orchestration is CPU-cheap; bump `limits.cpu_ms` in
  `wrangler.jsonc` as a safety margin. Bound history (last N) and writer steps
  (`topics.length + 2`). Monitor.

## Test strategy

- **Unit**: each topic/conversation/message DO method; each tool `execute`;
  prompt builders. Follow existing `*.test.ts` colocated style (vitest, DO test
  harness already used in `UserDO/index.test.ts`).
- **Agent integration**: mock the language model, drive scripted tool calls,
  assert reply collection, accessed-set tracking, and writer invocation.
- **Webhook/E2E**: extend `routes/telegram-webhook.test.ts` for the
  enqueue path (webhook → `enqueueTurn` → 200) and the alarm-driven `runTurn`;
  keep/adjust `packages/integration-tests` round-trip
  against a mock Anthropic (or the gateway) once the path is live.
- Gate everything behind `gob run bin/ci` (build + lint + tests).

## Documentation

- Update `docs/design.md` and `docs/framework.md`: remove container/secret-proxy
  narrative, describe the two-phase agent + topic model and gateway-from-worker
  LLM access.
- Update root `AGENTS.md` architecture paragraph (drop containers/R2 tar).
- Add a short `docs/topics.md` describing the topic model and writer policy.

## Skills to use

- **tdd** — build DO methods, tools, and agents test-first.
- **code** — implementation of each phase.
- **cloudflare** — DO SQLite, do-orm migrations, AI Gateway config, wrangler
  migrations tags.
- **git-commit** — one atomic commit per coherent step (schema, methods, tools,
  agents, orchestration, each cleanup deletion).
- **changelog** — if a changelog is maintained, record the architecture change.

## Commit plan

Ordered conventional commits. Every commit builds and passes
`gob run bin/ci`; only the cutover (7) changes runtime behavior; cleanup (8a-d)
only removes now-unreferenced code. Implement slice-by-slice (build each
commit's changes + tests, verify green, commit, next).

**0 — docs: plan the rewrite.** Commit `PLAN.md` + `IMPLEMENTATION_PLAN.md`.
Pure docs, anchors the branch.
`docs: plan container-to-meta-agent rewrite` · verify: CI.

**1 — chore: AI SDK deps + gateway config.** Add `ai`, `@ai-sdk/anthropic`; the
`ai` binding, `limits.cpu_ms` in `wrangler.jsonc`; regen
`worker-configuration.d.ts`. No logic; unblocks the build for commit 3 onward.
Files: `apps/api/package.json`, `pnpm-lock.yaml`, `wrangler.jsonc`, generated
types. `chore(api): add ai-sdk deps and AI Gateway binding` · verify: CI
(build + typecheck).

**2 — feat: topic + conversation persistence.** Schema + migrations
(`topics`, `conversations`+`busy_since`, `messages`, `processed_updates`),
TopicStore CRUD + turn-plumbing methods, tests. Additive, no callers yet.
Files: `UserDO/db/schema.ts`, `db/migrations/0011..0014_*.sql`, `migrations.ts`,
`UserDO/index.ts`(+test). `feat(userdo): topic model and conversation storage`
· verify: CI + DO unit tests.

**3 — feat: gateway model factory.** `agents/model.ts` (`createAnthropic` via
gateway + per-user `cf-aig-metadata`) + test. Small adapter behind the LLM port.
`feat(agents): AI Gateway anthropic model factory` · verify: CI + unit test.

**4 — feat: interface agent + tools.** `tools/topics.ts` (reply/list/get/
create/update, accessed-set), `agents/interface.ts` (`generateText` loop),
interface prompt; tests with mock LLM + in-memory store (the interface test
surface). `feat(agents): stateless interface agent with topic tools` · verify:
CI + agent integration tests.

**5 — feat: writer agent.** `tools/save-topic.ts` + `agents/writer.ts`
(consolidation policy, fallback-append) + writer prompt; tests.
`feat(agents): writer agent for topic consolidation` · verify: CI + writer
tests.

**6 — feat: DO-alarm turn execution.** `enqueueTurn`, `alarm()`/`runTurn`
orchestrator, `setTimeout` typing, `telegram/send-message.ts`; tests. Wires
2-5 together; dead until cutover. Files: `UserDO/index.ts`,
`telegram/send-message.ts`(+tests). `feat(userdo): alarm-driven turn
orchestrator` · verify: CI + alarm/runTurn tests.

**7 — feat: webhook cutover.** Webhook calls `enqueueTurn` + returns 200;
rework `/new`; drop attachments with a notice. The only behavior change;
independently deployable and revertable. Files: `routes/telegram-webhook.ts`,
`commands/new.ts`(+webhook/E2E tests). `feat(api): route Telegram turns through
the meta-agent` · verify: CI + integration round-trip.

**8a — refactor: remove container runtime.** `AgentContainer.ts`,
`agent-client.ts`, `process-topic-message.ts`, `handle-agent-end.ts`,
`secret-proxy.ts`, `ai-gateway.ts` (+tests). `refactor(api): remove container
agent runtime` · verify: CI.

**8b — chore: remove agent-server + deps.** `packages/agent-server/`,
`pi-coding-agent`/`pi-ai`/`@cloudflare/containers`, `pnpm-lock.yaml`.
`chore: drop agent-server package and container deps` · verify: CI.

**8c — chore: prune container infra.** `wrangler.jsonc` (containers,
`AGENT_CONTAINER`, R2, D1; migration tag deleting `AgentContainer`),
`index.ts` exports. `chore(api): remove container bindings and add DO migration`
· verify: CI + `wrangler deploy --dry-run`.

**8d — refactor: drop commands/cost/sessions; park tasks.** Remove
`commands/{abort,status}.ts`, `admin.ts` cost view, `sessions` table + methods
(+tests). **Tasks are parked, not deleted**: they will be reimplemented later as
a meta-agent turn on the new runtime. For now remove only the container
dependency — gut `runTask`/`agent-client` usage but keep `/api/tasks` as a stub
that accepts the request and no-ops (returns 202) so the web onboarding call
does not 404; leave a `TODO(tasks)` marker. `refactor(api): remove session/cost
tracking; stub tasks route` · verify: CI + web onboarding still loads.

**9 — docs: architecture.** `docs/design.md`, `docs/framework.md`, root
`AGENTS.md`, new `docs/topics.md`. `docs: describe meta-agent architecture`
· verify: CI.

**Workflow notes:** commits 3-5 stay green without the DO/webhook via the
deep-module ports (mock LLM + in-memory store). Keep the old container path
compiling until the cutover (7); all its deletions live in 8a-d. If
implementing broadly first, stash the whole tree and peel out one commit's
files at a time, verifying each before committing.

**Open questions (commit-affecting):** (1) pin `ai` v4 vs v5 in commit 1 (drives
the tool/step API in 4-6). (2) `/abort`//`/status` dropped in 8d — confirm no
web UI depends on them. (3) tasks are **parked** in 8d (stub route, container
dep removed) and will be reimplemented later as a meta-agent turn; decide what
the stub does with Google onboarding status in the meantime (mark done, or
leave pending).

## Acceptance criteria

Per `PLAN.md` § Acceptance Criteria, plus: LLM traffic flows through the
Cloudflare AI Gateway with per-user metadata; the agent sends live progress
replies (an acknowledgement lands before the substantive answer, each `reply()`
delivered immediately); `gob run bin/ci` green; no references to
`AgentContainer`/`agent-server` remain.

## Open questions to resolve first

1. ~~Does `@ai-sdk/anthropic` work against the Cloudflare AI Gateway with
   BYOK?~~ **Resolved** (see LLM access decision): yes, with `apiKey: ""` +
   `cf-aig-authorization`. Still smoke-test that model id `claude-sonnet-4-6` is
   accepted at the gateway's Anthropic endpoint before Phase 2.
2. Installed `ai` SDK major version (governs `maxSteps` vs `stopWhen`). Note:
   Agents SDK v0.3.0 / `ai-gateway-provider` v3.0.0 (Dec 2025) target AI SDK v6;
   pin whichever `ai` major you install and match its tool/step API.
3. ~~`send` reachability from inside the DO.~~ **Resolved**: `telegram/send.ts`
   is already a pure, transport-agnostic function; add a `telegram/send-message.ts`
   helper that builds a grammY `Bot` from `env` (like `chat-action.ts`) and
   wraps `formatAndSend`. The `reply` tool calls it directly from the DO.
4. Fate of `/new`, `/status`, `/abort` (commands). Tasks are parked (stub
   `/api/tasks`, reimplement later). (`SESSIONS_DB` cost
   view resolved: dropped in favor of AI Gateway logs.)
