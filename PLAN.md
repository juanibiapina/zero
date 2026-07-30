# Plan: normal-agent interface, scheduled learning, compaction

Written 2026-07-30, revised the same day after two adversarial verification
passes against the source and Cloudflare's Durable Object documentation. The
findings and their fixes are folded into the phases below; `file:line` refs are
from those passes and predate the Phase 0 commits, so re-locate them before
trusting a line number.

## Status (2026-07-30)

Branch `agent-normal-interface`, one commit per numbered item, not yet merged or
deployed. **Phase 0 is done except 0.5b. Phases 1-3 are untouched.**

| Item | State | Commit |
|---|---|---|
| 0.1 delete `busySince` | done | `refactor(agent): delete the write-only busySince conversation flag` |
| 0.2 delete summaries, shrink `list_topics` | done | `refactor(agent): drop topic summaries and shrink list_topics to routing fields` |
| 0.3 knowledge version + four narrow write tools | done | `feat(agent): version topic knowledge and replace topic writes with four narrow tools` |
| 0.4 one delivery path | done | `feat(agent): deliver the model's own text blocks instead of a reply tool` + `feat(agent): log how many messages a turn sent` |
| 0.5a observe photo variants | done | `feat(agent): record the photo variants Telegram offers before changing selection` |
| 0.5b select by cost | **blocked on production data** (todo #17) | — |
| 1.1 message protocol schema, queue, delivery records | done | `feat(agent): store conversations as a protocol log with a durable message queue` |
| 1.2 compaction boundary, summary, staleness filter | done | `feat(agent): render conversations from a compaction boundary instead of a fixed window` |
| 1.3 persist the loop as it runs, resume, follow-up injection | done | `feat(agent): persist the agent loop as it runs and resume an interrupted turn` |
| 1.3 external-write claims | done | `feat(agent): claim irreversible tool calls so a resumed turn cannot repeat them` |
| 1.4 cross-turn cache diagnostic chain | done | `feat(agent): chain cache diagnostics across turns of a conversation` |
| 2.1 ScheduleDO + LearningDO shells | done | `feat(agent): add per-user schedule and learning durable objects` |
| 2.2 UserDO alarm drains turns only | done | `feat(agent): keep UserDO's alarm for turns and move other deadlines to the schedule` |
| 2.3 touch the idle deadline per message | done | `feat(agent): push a conversation's idle learning deadline on every message` |
| 2.4 size trigger | done | `feat(agent): ask for learning when a conversation's context grows too large` |
| 3.1 learning port on UserDO | done | `feat(agent): give learning a versioned port into the user's data` |
| 3.2-3.3 learner slices, checkpoints, compaction | done | `feat(agent): run learning as checkpointed slices in its own durable object` |
| 3.4 activation: writer deleted | done | `feat(agent): move consolidation off the turn path` |

`pnpm --filter @zero/agent-api run test | lint | typecheck` pass on the branch
(581 tests; the count fell when the writer's suite was deleted). The branch is pushed to `origin` but not merged; a branch push only
uploads a Worker version, so nothing is deployed, so none of the Phase 0 log lines have produced
production data yet; the acceptance criteria that read them are still open.

### What Phase 0 actually shipped, for a fresh reader

- Migrations `0021` (drop `conversations.busySince`), `0022` (fold every legacy
  topic summary into the body, then drop the column), `0023` (new `knowledge`
  table: single row, `version` starting at 1, `systemFingerprint`).
- Migration 0022 cannot parse `[[Name]]` tokens in SQL, so the one-time link
  re-derivation runs in `UserDO`'s constructor after `migrate`, guarded by the
  storage key `topicLinksRebuiltV22`, calling `DbStore.rebuildAllLinks()`.
- `TopicStore` writes are all versioned and take an input object:
  `createTopic({expectedVersion,name,description,body})`,
  `updateTopicBody`, `updateTopicMetadata`, `deleteTopic`, `setPinned`, each
  returning the new version and throwing `KnowledgeConflictError` on a stale
  one. `saveTopic` is gone. There is no unchecked write path.
- `syncSystemTopicsFingerprint(fingerprint)` bumps the version once when the
  bundled system-topic text changes; the fingerprint is derived from the content
  by `systemTopicsFingerprint()` in `store/system-topics.ts` and applied in the
  `UserDO` constructor.
- Tools: `create_topic` (non-empty body required), `edit_topic`, `append_topic`,
  `update_topic_metadata`, `delete_topic`. `update_topic` is deleted. Reads wrap
  their payload: `list_topics -> {version, topics}`, `get_topic -> {version,
  topic}`, `list_backlinks -> {version, topics}`.
- Tests write topics through `src/store/test-support.ts` (`seedTopic`, `setBody`,
  `setDescription`, `renameTopic`, `removeTopic`, `pinTopic`), which read the
  current version. Tests that are about versioning call the store directly.
- The `reply` tool, `decideFinalDelivery`, the echo guard and the
  `firstSendError` plumbing are deleted. `runAgent` takes `onText(text)`, called
  per non-empty text block per step **before** that step's tools run;
  `runInterfaceAgent.deliver` persists then sends inside it. The no-silence rule
  is now the pure `needsFallback({finishReason, sentCount})`.
- `scriptedModel` steps accept `{ tools, text? }`, so a test can express "say
  something, then keep working" without a tool.
- Log lines added: `topic_list_rendered`, `topic_reads_per_turn`,
  `topic_write_conflict`, `turn_messages_sent`, `telegram_photo_variants`.
- Docs updated: `docs/topics.md` (knowledge versions, new tool surface, the
  single delivery path), `docs/design.md` (schema tables). Changelog entry added
  for the delivery change.

### Deviations from the plan as written

- 0.2 keeps `messageCount`, `lastActiveAt`, `pinned` and `system` on `TopicMeta`;
  only the `list_topics` **tool** projects down to `{name, description}`.
  Backlink results still carry the fuller meta.
- 0.3 stores the counter in a dedicated `knowledge` table rather than "per-user
  storage" generally, and `setPinned` is versioned like the other writes.
  Onboarding only writes the pin when it is not already set, so a re-run does
  not invalidate every persisted read.
- 0.5b is unshipped on purpose: it is gated on a production sample and an
  image-quality probe, neither of which exists yet.

### What Phase 1.1 shipped

- Migration `0024`: `messages.content` becomes a JSON `ContentBlock[]` (every
  existing row rewritten as one text block by `json_array(json_object(...))`),
  plus `kind`, `stopReason`, `consolidatedAt`, the `pending_messages` queue and
  the `deliveries` table. Legacy assistant rows are stamped `stopReason
  'end_turn'`, without which every historical conversation would look unfinished
  to the new work rule.
- `store/messages.ts` holds the pure protocol rules both adapters share:
  `encodeContent`/`decodeContent` (tolerant of a pre-migration plain-text row),
  `messageText`, `defaultKind`, `isTerminalStopReason`, `conversationHasWork`.
- `storeMessage(conversationId, role, content, { kind?, stopReason? })` returns
  the row id and accepts blocks; assistant rows default to `stopReason
  "end_turn"` so a caller persisting a finished reply keeps today's semantics.
- New port methods: `enqueuePendingMessage`, `drainPendingMessages` (one
  transaction, arrival order, idempotent), `claimDelivery(messageId,
  blockIndex)`, and `findConversationsWithWork` replacing
  `findThreadsAwaitingReply`.
- `UserDO.enqueueTurn` queues the Telegram message instead of writing it to the
  transcript; `runTurn` drains the queue at turn start. Mid-loop follow-up
  injection is still Phase 1.3.
- Rendering is unchanged in bytes: every row is still a single text block, and
  `buildConversationMessages` flattens content with `messageText`.

### What Phase 1.2 shipped

- Migration `0025`: `conversations.compactedThroughMessageId` and
  `conversations.summary`, both NULL until a conversation is compacted, which
  renders as "show the whole log".
- Port: `getConversationContext(conversationId, limit) -> {summary, messages}`
  returns only rows after the boundary; `compactConversation(id,
  {throughMessageId, summary})` moves it and deletes nothing.
  `getConversationHistory` stays as the raw pager (learning will use it).
- `store/messages.ts` gained the pure render rules: `CONTEXT_BACKSTOP_MESSAGES`
  (60), `CONTEXT_BACKSTOP_CHARS` (150,000), `applyContextBackstop`,
  `applyStalenessFilter` + `STALE_TOPIC_STUB`, `contentChars`, `estimateTokens`.
  The backstop is the ceiling 3.4 must delete; nothing moves the boundary yet.
- The staleness filter is live already even though tool results are not persisted
  until 1.3: it maps `tool_use.id -> name` across the rendered messages and
  stubs a `list_topics`/`get_topic`/`list_backlinks` result whose payload
  `version` is missing or not the current knowledge version, keeping the
  `tool_use`/`tool_result` pair intact.
- The compacted summary is rendered as the leading user message
  (`[summary of earlier conversation]`); with a summary present the
  drop-leading-assistants rule is skipped, so a first reply after the boundary is
  not thrown away.
- `context_rendered` logs `total_tokens`, `summary_tokens`,
  `messages_after_boundary` and `stale_stubs`. This is the line the compaction
  threshold must be derived from; it is an estimate from characters (chars / 4),
  the authoritative figure is the gateway's.
- `DEFAULT_HISTORY_LIMIT` is gone. `TurnInput.historyLimit` survives only as a
  test override of the backstop.
- Docs: `docs/topics.md` "Conversation context", `docs/design.md` schema table.
  Changelog entry for the longer memory.

### What Phase 1.3 shipped

- `runAgent` gained four hooks: `onAssistant(content, stopReason)` (persist the
  response verbatim, returns the row id), `onText(text, {messageId, blockIndex})`,
  `onToolResults(results)` (persist before the next model call) and `onIdle()`
  (returning messages continues the same loop). No schema change: 1.1's
  `pending_messages` and `deliveries` were already there.
- **Resume**: `runAgent` opens by running the tool calls of a persisted assistant
  tail that has no results, so the invalid mid-response wire state is repaired
  before the first model call. Read tools re-run; topic writes replay with their
  original `expectedVersion` and conflict instead of duplicating.
- **Delivery is claim-then-send**, not persist-then-send: the row is already
  durable, so `deliver` claims `(messageId, blockIndex)` and skips a claimed block
  (`delivery_skipped`). `deliverUnclaimed(trailing)` sends what an interrupted run
  persisted but never delivered. The fallback gets its own terminal assistant row,
  which is also what stops the work rule from resuming a cap-exhausted run.
- **Rendering is block-verbatim.** `buildConversationMessages` now takes one input
  object (`{history, userMessage, trailing, now, timezone, summary, context}`) and
  renders an assistant row's blocks unchanged, a `tool_result` row as a `user`
  turn (results ordered first when coalesced), and a user row as timestamped text.
  The volatile per-turn context moved into the renderer as `context`.
- `runTurn` no longer requires a user tail: it asks `conversationHasWork`, then
  splits the filtered context at the newest `user_message` into
  `history` / `userMessage` / `trailing`.
- Logs added: `conversation_size` (`message_count`, `stored_bytes`),
  `topic_reads_avoided` (topic reads surviving the staleness filter),
  `followups_injected` (count + oldest age), `delivery_skipped`, plus
  `followups_injected` on `interface_completed`.
- **External writes** (second commit): migration `0026` adds `external_calls`
  (`toolUseId` PK, `tool`, `status`, `result`, timestamps). A tool declares
  `externalWrite: true` (`gmail_send`, `calendar_create_event`) and `runTool`
  claims it through the `ExternalCallGuard` port before `execute` runs:
  `claimed` -> run and record the serialized result; `completed` -> return the
  recorded result without calling out; `in_flight` -> return
  `UNCERTAIN_EXTERNAL_CALL` as an error result and do not call out. A tool that
  throws is recorded as completed with its error text, because the tool reported a
  known failure.
- `tool_result_reused` with `age_turns` was not added; `topic_reads_avoided`
  covers the same question per turn.

### Picking this up in a new session

```bash
git checkout agent-normal-interface   # unmerged, ahead of main
pnpm --filter @zero/agent-api run test    # 581 passing
```

**Every phase of this plan is implemented apart from 0.5b**, which is gated on a
production sample (todo #17). Nothing is deployed: the branch is unmerged, and a
branch push only uploads a Worker version.

What is left is verification, not construction:

1. Merge and deploy, then read the log lines the acceptance criteria name. They
   have no production data yet: `topic_list_rendered.chars`,
   `topic_reads_per_turn`, `turn_messages_sent`, `topic_reads_avoided` vs
   `stale_stubs`, `followups_injected`, `conversation_size`,
   `chain_crossed_turn`, `turn_queue_delay_ms` (**not implemented — see below**),
   `schedule_fired` / `schedule_finished`, `learn_started` /
   `learn_slice_completed` / `learn_completed`, `compaction_completed`.
2. `turn_queue_delay_ms` (enqueue -> `turn_started`) is the one named log line
   that was never added, and the plan calls it the most valuable one. Add it.
3. `LEARN_SIZE_THRESHOLD_TOKENS` (45,000) is a starting point, not a
   measurement. Move it using real `context_rendered.total_tokens` and
   `compaction_completed` pairs.
4. Watch the first real learning jobs: `learn_slice_completed` should show most
   jobs finishing in one slice, and `learn_completed` should always follow
   `learn_started` (its absence is the stall signal).

Note before Phase 2: Phase 1's acceptance criteria are log-based and nothing is
deployed yet. `topic_reads_avoided`, `stale_stubs`, `followups_injected`,
`conversation_size` and `chain_crossed_turn` have no production data, and the
plan's rule is to capture the pre-Phase-1 baseline (topic reads and AI Gateway
cost per turn) before Phase 3 changes it.

Delivery has a single call site (`deliver` in `agents/interface.ts`), which is
what makes the per-block claim work; keep it that way.

Before merging, note the Phase 0 acceptance criteria are log-based and nothing is
deployed yet: `topic_list_rendered.chars`, `topic_reads_per_turn` and
`turn_messages_sent` have no production data either.

## Goal

1. **The interface becomes a normal agent.** Its conversation is an append-only
   log of real messages including `tool_use` and `tool_result` blocks. Tool
   results are persisted, not thrown away and re-fetched next turn.
2. **Timers and learning move off the turn path.** `ScheduleDO` owns every
   deadline for a user, `LearningDO` durably executes learning jobs, and
   `UserDO`'s alarm does one thing: drain turns.
3. **Learning happens per idle period or per size threshold, not per turn.**

Everything that can be deleted is deleted before anything is moved.

## Measured background (do not re-derive)

Production, 2026-07-29, user `user_3Ea4tsHDgKswP3GgO0ITkoJmrKp`. Full write-ups
in `docs/plans/agent-latency-investigation.md` and
`docs/plans/writer-latency-investigation.md`.

- **Cost is dominated by cache writes.** One writer run: cache write $0.121,
  cache read $0.017, output $0.010. Anthropic prices cache read at 0.1x, input
  at 1x, a 5m-TTL cache write at 1.25x and a 1h-TTL write at 2x. The messages
  region uses the 5m sliding breakpoint and tools/system use 1h
  (`src/agents/run.ts:212-218`), so **the same token is 12.5x cheaper as stable
  message text than as a fresh tool result** — a tool result is new bytes in the
  message region on every run and can never be reused across runs.
- **The writer's cost is fixed, not proportional to what it learns.** Every run
  pays ~14,700 tokens for `list_topics` plus ~15,400 for one `get_topic`,
  whether it writes 27 output tokens or 2,244. Observed: 4-7 sequential LLM
  calls, ~89,000 input tokens to produce ~650 tokens of edits.
- **`list_topics` returns every topic** with `name`, `description`, `summary`,
  `lastActiveAt`, `messageCount`, `pinned`, `system`. That is 132 characters of
  JSON scaffolding per topic before content. For this user: 80 topics,
  summaries ~12,958 chars, descriptions ~2,902 (≈36 chars per topic), names
  ~1,231.
- **Topic sizes** range from 229 chars (`Mircea`) to 41,239 (`charles`).
  `charles` is 20+ labelled `##` sections of 285-6,081 chars each, two of them
  single-day research dumps totalling 10,871 chars.
- **Reply latency is already fine** after the anchored-edit fix:
  `interface_completed` at 1.8-8.5s. The remaining 20-40s is the writer tail,
  which lands on the user's *next* message because turns drain serially per DO.
- **A DO alarm invocation is killed at 900s wall time** with
  `outcome: exceededWallTime`. Not an exception: no `catch` sees it, nothing
  reaches ZeroErrors. Diagnose via Workers Logs `view: "invocations"`
  (`outcome`, `wallTimeMs`, `cpuTimeMs`), grouping by `$workers.requestId`.
  Markers `writer_started` / `turn_completed` / `alarm_finished` exist for this
  and are useful by their absence.
- **Users have up to 10+ conversations**, but typically only one or two are
  active at a time. Threads are per `(chatId, topicId)`.
- **`busySince` is write-only.** `markBusy`/`clearBusy` write it; nothing reads
  it. `findThreadsAwaitingReply` selects purely on `tail.role === "user"`
  (`src/store/db.ts:302`).

## Current shape, for a fresh reader

As of the branch head (Phase 0 and all of Phase 1 applied):

- `runTurn` (`src/agents/orchestrator.ts`) drains the pending queue, renders the
  conversation from the compaction boundary, asks `conversationHasWork`, splits at
  the newest user message, runs the interface agent, then runs the writer. The
  busy flag and its `try/finally` are gone.
- `runAgent` (`src/agents/run.ts`) is the shared tool loop. It persists each
  response and its tool results through hooks as it goes, delivers text blocks as
  the model writes them, and injects queued follow-ups where it would otherwise
  stop.
- The interface agent has no `reply` tool. Delivery is claim-then-send inside
  `deliver` (the row is persisted by the runner first), and `needsFallback`
  covers the no-silence case.
- History rows carry wire-format content blocks, `kind` and `stopReason`
  (`0024_message_protocol.sql`), and the loop now writes tool calls and results
  into them. The writer still gets its own in-memory `renderTranscript`, which is
  deleted with the writer at the LearningDO cutover.
- `getConversationHistory` is now the raw pager (learning will use it); the
  orchestrator reads `getConversationContext`. `listTopics()` has exactly one
  caller, the `list_topics` tool.
- Topic knowledge is versioned; every write states `expectedVersion` (Phase 0.3).
  Phase 1's staleness filter builds directly on that counter, which already
  exists and is already bumped by every write and by a system-topic content
  change.
- The interface agent is resumable: an interrupted turn's persisted responses and
  tool results are handed back to it as `trailing`, unclaimed text blocks are
  delivered, unanswered tool calls are re-run, and an irreversible call an earlier
  attempt started is reported as uncertain instead of repeated.

## Design decision: one knowledge version

Once tool results persist, a topic read stays in a conversation forever. Any
interface, onboarding, admin or learner write can make it stale; learning time
alone is not a valid invalidation signal.

Keep one integer `knowledgeVersion` per user. Every topic read returns the
current number:

- `list_topics() -> { version, topics }`
- `get_topic({ name }) -> { version, topic }`
- `list_backlinks({ name }) -> { version, topics }`

Every topic mutation takes `expectedVersion`, compares it to the current value
in the same SQLite transaction, applies only on equality, increments the number,
and returns the new version. A mismatch returns a normal tool error telling the
agent to reread and retry. This applies to create, anchored edit, append,
description update, rename, delete, pinning and internal onboarding/admin/
learner writes. Missing versions on pre-migration persisted results are stale.

The single global number is deliberately coarse. An edit to one topic
invalidates reads of every topic and makes parallel writes serialize through
rereads, but it gives one correctness rule for topic bodies, the catalog and the
link graph. Do not add per-topic/catalog/link revision types until production
`stale_stubs` and reread counts prove the global counter too expensive.

### Staleness: a render-time filter, no LLM call

When rendering any conversation, replace each topic-read result whose recorded
version differs from current `knowledgeVersion` with a short stub such as
`[stale: topic knowledge changed; reread before using or writing]`.

- **Replace, never delete.** Every `tool_use` block requires a matching
  `tool_result` in the Anthropic wire format. The stub preserves the pair.
- The filter is mechanical and applies to all conversations automatically.
- A successful write returns the incremented version, so a model making several
  sequential changes can use that result as the next `expectedVersion`.
- If two calls use the same version, one succeeds and the other gets a loud,
  recoverable conflict instead of clobbering or duplicating content.

This removes `lastLearnAt` and the special case where only learner writes
invalidated history. Staleness remains separate from compaction: invalidating a
result is cheap, while summarizing every conversation after every write is not.

### Size: summarizing compaction, only where needed

Compaction is **non-destructive**: every message stays in storage, compaction
only moves a per-conversation boundary and stores a summary. The model sees
`summary + messages after boundary`; the learner always reads the raw log.
Otherwise compaction would destroy the material learning needs.

Compaction is triggered by size and applies only to the conversation that
exceeded the threshold. Before summarization, apply the same knowledge-version
stubs to stale topic results. The compaction prompt must preserve conversational
continuity, user decisions and topic names, but must not copy topic bodies or
old tool-result facts into the summary; it directs the interface to reread named
topics for current knowledge. Otherwise a stale snapshot would escape from a
versioned tool result into an unversioned summary.

### Triggers for learning

- every conversation for the user idle 1h, **or**
- any conversation's rendered context exceeds the size threshold.

Either way learning consolidates topics from unconsolidated messages. Each
successful mutation increments `knowledgeVersion`; job completion does not.
The size trigger is what covers the always-active user.

### Concurrent writes

Two conversations may write at once. Both can read version 12, but the first
successful mutation commits version 13; the second receives a version mismatch
and must reread. The exact-anchor rule remains a second body-level guard, not the
primary concurrency protocol.

### Threshold: derive, do not guess

A large prefix costs cache reads on **every call of every turn**: 100,000 tokens
at $0.30/M is $0.03 per call, and a turn is several calls, so roughly $0.10/turn
in reads alone at Cloudflare's `compactAfter(100_000)` default — as expensive as
the writer being removed. Compaction costs a one-time summarization plus a cache
rebuild. Start nearer **40-50k tokens**, log rendered context size per turn, tune
from real sessions. Do not ship a guessed constant as if it were derived.

## Design decision: images stay verbatim

`view_attachment` returns a native base64 image block and is documented as
intra-turn only (`src/tools/attachments.ts:2-7`); the writer transcript redacts
it (`src/agents/interface.ts:150-158`). Once the log persists, that block is
re-sent on every request in the conversation.

Replacing a sent image with a marker after the fact is **wrong**: the model saw
the image, and the persisted bytes would no longer match what was sent, so the
prefix diverges and the cache breaks on the first re-read.

Prior art (pi, `packages/coding-agent/src/utils/image-resize.ts` and
`core/tools/read.ts:254`): resize **at ingest** (2000x2000 max, ≤4.5MB base64,
PNG vs JPEG whichever is smaller, then quality backoff, then dimension backoff),
keep the block verbatim for the rest of the session, and let compaction age it
out. No per-image expiry, no in-place rewrite; the only filters are a global
block-images setting and a non-vision-model downgrade, both applied when building
the request, never to storage.

Token cost of keeping an image is small: Anthropic scales to a 1568px long edge
and charges about `w*h/750`, so ~1600 tokens, at 0.1x on a cache read. What
matters is payload bytes re-sent per step, SQLite rows, and the 5MB per-image API
limit.

So: persist verbatim, bound the bytes upstream. Zero needs no WASM resizer —
Telegram already serves several `PhotoSize` variants (see Phase 0.5).

## Design decision: learning gets its own Durable Object

`ctx.waitUntil` is not a background-work mechanism inside a Durable Object.
Cloudflare documents that `DurableObjectState.waitUntil` has no effect: it does
not extend the object's lifetime or affect when an RPC completes
(https://developers.cloudflare.com/durable-objects/api/state/). Returning from
`UserDO.learn()` and leaving a multi-minute promise behind can therefore lose the
job after `ScheduleDO` has treated it as dispatched.

Learning instead runs in one `LearningDO` instance per user. The three Durable
Objects have distinct responsibilities:

- `ScheduleDO` owns *when*: all user deadlines, including idle learning,
  onboarding, admin tasks and later schedules. A due learning event calls
  `LearningDO.request(reason, conversationId?)`.
- `LearningDO` owns durable *execution*: job state, the learner's wire-format
  message log, model-step checkpoints, tool results and retry progress. Its own
  alarm performs a bounded slice and re-arms itself while work remains.
- `UserDO` owns user data and interactive turns. Learning reads messages/topics
  and applies mutations through short RPC methods. It never runs the learner's
  LLM loop, so a slow learner cannot hold the turn-draining alarm open.

A Durable Object cannot read another Durable Object's SQLite directly. Do not
pretend `LearningDO` can receive the existing in-process `Store`. Define a small
remote learning port at the seam, with a `UserDO` RPC adapter in production and
an in-memory adapter in tests. Keep the learner and its checkpoint machine
behind one module interface; the transport is implementation detail.

### Durable learning protocol

1. `LearningDO.request` stores or coalesces a pending reason and arms its alarm.
   One active job may have one queued successor; a size request retains its
   conversation ID for compaction.
2. At job start, `LearningDO` asks `UserDO.beginLearning(jobId)` for a frozen
   high-water message ID and pages raw unconsolidated messages up to it. Messages
   arriving later belong to the next job. The high-water mark, reason and input
   pages are persisted in `LearningDO` before the first model call.
3. Each alarm invocation runs a bounded number of model steps. Persist the raw
   assistant response before executing its tool calls, then persist every tool
   result before the next model call. If the slice is unfinished, set an
   immediate alarm and return normally. Never use `ctx.waitUntil`.
4. Learner topic writes use the same `expectedVersion` interface as interactive
   writes. If a mutation committed but its result was not checkpointed before a
   reset, replay with the old version conflicts instead of duplicating an append;
   the learner rereads and continues from the resulting state. No separate
   operation-marker protocol is needed.
5. After a clean model stop, `LearningDO` calls
   `UserDO.completeLearning(jobId, highWaterMessageId)`. One transaction stamps
   only the covered messages. The completion RPC is idempotent by `jobId` and
   does not change `knowledgeVersion`; topic mutations already did that. Only
   then may `LearningDO` mark the job complete and start a queued successor.

Unexpected alarm errors stay uncaught so Cloudflare's at-least-once alarm retry
runs. The explicit slice bound is still required: automatic retry cannot rescue
a deterministic 900-second loop, and Cloudflare limits alarm retries. A repeated
topic mutation is harmless because its expected version is stale.

## Observability (applies to every phase)

Two incidents on 2026-07-29 were found by hand-querying logs after a user
complained, and one of them was invisible for an afternoon because the failure
mode produced **no** log line and **no** exception. The rules below come from
that, not from general principle.

**Log completion, not only start.** A DO alarm invocation killed at the 900s
wall-time ceiling reports `outcome: exceededWallTime` to Cloudflare and throws
nothing, so no `catch` runs. The only in-app evidence is a completion line that
never appears. Every new async entry point (ScheduleDO's alarm, `learn`,
compaction) gets a start marker **and** a completion marker, and the completion
marker is the diagnostic.

**Emit counters that make a trend visible.** Both incidents were gradual climbs,
not step changes: the writer went 5,983 → 13,856 output tokens over one day.
A threshold alert would have caught neither promptly. Every field below is
chosen so a week-over-week median can be computed from it.

**Never log content.** `log.ts` convention: `service` + `msg`, snake_case
fields, no message content, tool results or request bodies. Errors go through
`logError` and `fmtErr`.

These lines are the substrate for the monitoring and alerting work already
queued as todo #13. Naming them now avoids that work having to add
instrumentation first.

### Per phase

**Phase 0**
- `0.2`: `topic_list_rendered` with `topic_count` and `chars`, plus
  `topic_reads_per_turn` (count of `get_topic` calls). The second one is what
  tells you whether dropping `summary` bought a saving or just moved cost into
  extra reads.
- `0.3`: `topic_write_conflict` with tool name and expected/current version, but
  no topic name or content. This measures the cost of the coarse global counter.
- `0.4`: `turn_messages_sent` with `count`. Message boundaries shift when
  `reply` is deleted, so this is how the change is observed in production
  rather than inferred.
- `0.5a`: `telegram_photo_variants` with candidate count and ordered dimension/
  optional-size tuples, never file IDs. `0.5b`: `attachment_ingested` with
  selected width, height, bytes and estimated visual tokens.

**Phase 1**
- `context_rendered` per turn: `total_tokens`, `summary_tokens`,
  `messages_after_boundary`, `stale_stubs`. `total_tokens` is what the
  compaction threshold must be derived from, so it has to land with this phase,
  not with Phase 3.
- `tool_result_reused` with `tool` and `age_turns`, or a per-turn
  `topic_reads_avoided` count. This is the phase's entire justification; without
  it there is no way to tell whether persistence is paying.
- `conversation_size` with `message_count` and `stored_bytes`, per conversation.
  Covers the storage-growth risk.
- `followups_injected` with count and oldest queue age, plus
  `followup_queue_depth` at enqueue. These prove Telegram messages arriving
  mid-run are drained rather than stranded.
- Cache diagnostics already log `cache_diagnostic`; it now carries
  `chain_crossed_turn` (1.4), so a cross-turn cache break is distinguishable from
  an in-run one.

**Phase 2**
- `schedule_fired` with `reason` (`idle` / `size` / `onboarding` / `admin_task`)
  and `schedule_finished` with `duration_ms`. Mirrors `alarm_finished`; its
  absence is the stall signal.
- `learning_job_queued` with `reason`, `coalesced` and whether a successor is
  pending; no content or raw IDs.
- `turn_queue_delay_ms`, measured from `enqueueTurn` to `turn_started`. This
  single number would have made the 2026-07-29 fifteen-minute delay obvious
  immediately instead of after an afternoon of log archaeology. It is the most
  valuable line in this plan.

**Phase 3**
- `learn_started` with `reason` and `unconsolidated_messages`.
- `learn_slice_completed` with `model_steps`, `mutations_applied`,
  `version_conflicts`, `duration_ms` and whether another alarm was armed.
- `learn_completed` with `duration_ms`, `topics_touched`, `topics_created`,
  `conversations_scanned`, `messages_consolidated`, plus `usageLogFields`.
- `compaction_completed` with `conversation_id`, `tokens_before`,
  `tokens_after`, `duration_ms`. The before/after pair is what tunes the
  threshold.
- `learn_skipped` with a reason when a trigger fires but nothing is due, so a
  learner that is quiet because it is broken is distinguishable from one that is
  quiet because there is no work.

## Phase 0 — Cleanups (done except 0.5b)

Each is its own commit. Delete obsolete paths before adding replacement logic;
0.3, 0.4 and 0.5 include behavior changes and their regression tests.

**0.1 Delete `busySince`. DONE.** Removes a column, two `Store` methods, three adapter
implementations (`DbStore`, `MemoryStore`, `SystemTopicStore`) and the
`try/finally` in `runTurn`. It is also the call that appeared in every DO-reset
stack. The column exists in `0014_conversations.sql`: either add a migration
that drops it or leave the column dead and remove only the code. Do not assume
`DROP COLUMN` round-trips through do-orm without checking.

Note it is *not* a substitute for the awaiting-reply flag added in 1.1 — it is
write-only and carries no state anyone reads.

**0.2 Delete topic summaries and shrink `list_topics`. DONE.** Keep one compact,
stable routing field (`description`) and one authoritative knowledge field
(`body`). Once `list_topics` returns only `name` and `description`, `summary` has
no distinct consumer: pinned topics render their bodies, and `get_topic` already
returns the full body. Do not retain two model-written representations of the
same current state.

Remove `summary` from the topic table, schema, `Topic`/`TopicMeta`, store
interfaces and adapters, system-topic definitions, tool schemas, prompts and
tests. `list_topics` returns `name` and `description` only. Descriptions become
short routing text, not a second knowledge document; body owns both current
state and history.

The physical column is removed, but existing data must not be discarded. In the
same migration:

1. For each non-empty legacy summary, leave the body unchanged when it already
   contains that exact text; otherwise append it under `## Legacy summary` (or
   use it as the body when the body is empty).
2. Rebuild outbound-link rows from every changed body so `topic_links` remains
   derived from body content.
3. Drop the `summary` column only after the copy. If do-orm cannot express this
   safely in one SQL migration, use a table-copy migration plus a one-time
   post-migration link reconciliation keyed by schema version; do not rely on
   every UserDO having run old application code before deployment.

Dropping summary is the largest fixed input saving available. Description
averages ~36 chars per topic for the reference user. Ship with
`topic_reads_per_turn`; if routing degrades, permit a somewhat richer
description rather than recreating a second summary field.

**0.3 Replace topic writes with four narrow tools. DONE.** Delete `update_topic`; no
tool may replace a complete non-empty body. The write interface becomes:

- `create_topic({ expectedVersion, name, description, body })`: require
  non-empty body and reject an existing name. Create the complete topic in one
  transaction, including outbound-link derivation.
- `edit_topic({ expectedVersion, name, oldText, newText })`: anchored
  replacement only. `oldText` must be non-empty and occur exactly once;
  everything outside it stays byte-identical.
- `append_topic({ expectedVersion, name, text })`: require non-empty text and
  append with one blank-line separator. If the existing body is empty, set it
  directly.
- `update_topic_metadata({ expectedVersion, name, description?, newName? })`:
  require at least one changed field, reject rename collisions, and never accept
  body content.

Add `knowledgeVersion INTEGER NOT NULL` to per-user storage, initially 1. Every
read tool wraps its existing payload with that version. Every write above and
every internal topic mutation checks `expectedVersion` and increments it in the
same transaction. Existing direct `TopicStore` write methods must not provide an
unchecked path that onboarding, admin code or LearningDO can accidentally use.

Bundled system topics also participate even though they are not in user SQLite.
Derive a deterministic fingerprint from their names, descriptions and bodies and
store it alongside the user's counter. When a Worker build changes the bundled
content, the next UserDO initialization stores the new fingerprint and increments
`knowledgeVersion` once. Do not maintain a manual version constant that can drift
from the content. This makes persisted Changelog/Zero reads stale after deploys
without introducing a second model-visible revision.

This covers every current case without an operation discriminator or a tool with
unrelated optional modes: create, revise, append/initialize, route, and rename.
A body edit plus metadata change takes two calls; the second uses the version
returned by the first. Each call leaves a valid topic.

Google onboarding currently fills the already-existing pinned `User` topic
through `update_topic.body` (`src/agents/onboarding.ts:52`,
`src/agents/prompts.ts:163`). Move it to `append_topic`, which deliberately
initializes an empty body. Writer/admin prompts currently teach
create-empty-then-update (`prompts.ts:229-239`); make them create with body and
use the other three tools only for existing topics. Update research tool
allowlists, scripted models, tool descriptions and tests in the same commit.

Add regression tests for create collision, create-with-body link derivation,
unique anchored edit, append into both empty and non-empty bodies, metadata-only
updates, rename collision, and onboarding into an existing empty pinned topic.
Do not call 0.3 complete merely because the schemas compile.

**0.4 One delivery path. DONE.** Delete the `reply` tool, the echo guard, the
`replies[]` bookkeeping and the `firstSendError` plumbing. In a normal agent the
assistant's text blocks *are* the messages: emit each text block as a Telegram
message as it is produced. Multi-message turns (acknowledge, then answer after
research) still work without a tool to express them.

This needs three things the current code does not have:

- **A per-step hook in the runner.** `runAgent` returns text only after the loop
  ends (`src/agents/run.ts:255-265`); intermediate text blocks are only in
  `generated`. Add an `onText(block)` callback invoked per step, with
  persist-before-send inside it.
- **A prompt rewrite.** "Reply as you work" (`src/agents/prompts.ts:86-90`) is
  written in terms of the `reply` tool. Rewritten badly, every "let me check
  that" preamble becomes a Telegram message; that is the main user-visible risk
  of this phase.
- **Updated e2e flows.** The scripted mock-Anthropic runs in
  `packages/agent-e2e/src/hello.test.ts` and `rate-limit.test.ts` call `reply`.

**Keep the no-silence fallback.** `decideFinalDelivery` goes, but cap exhaustion
still returns `finishReason: "tool-calls"` with `text: ""`
(`src/agents/run.ts:280-287`), and a clean finish can produce no text at all.
Rule that survives: if the run ends non-`stop`, or ends with nothing sent all
turn, send `FALLBACK_MESSAGE`. `FALLBACK_MESSAGE` is also used by the
orchestrator's error path and stays either way.

Persist-before-send is **load-bearing** and must survive: each text block is
persisted before the Telegram fetch leaves, so a mid-run eviction leaves the
tail as an assistant message and the retry skips the thread instead of
re-sending. Needs a test that fails if the order flips.

**0.5 Select Telegram image variants from measured payloads and a visual-token
budget. 0.5a DONE, 0.5b BLOCKED on production data (todo #17).** `extractAttachment` currently takes the last `PhotoSize`
(`src/routes/telegram-webhook.ts:147-148`) while the local type drops `width`,
`height` and `file_size` (`:56-59`). Telegram's official Bot API guarantees only
that `Message.photo` is an array of available `PhotoSize` values and that each
value carries width, height and optional file size. It does not document array
ordering or promise fixed 90/320/800/1280 dimensions:
https://core.telegram.org/bots/api#message and
https://core.telegram.org/bots/api#photosize. Treat folklore dimensions and
“last is largest” as claims to measure, not interface guarantees.

Ship this in two evidence-gated steps:

- **0.5a Observe without changing selection.** Add the missing fields and log one
  content-free `telegram_photo_variants` event per photo with candidate count,
  ordered `(width,height,file_size-present)` tuples and which candidate the
  current code selected. Never log file IDs. Collect a production sample across
  ordinary photos, Telegram's HD photo mode if it appears, screenshots and
  portrait/landscape images. Keep current behavior during this sample.
- **0.5b Select by cost.** Sort candidates explicitly. Anthropic documents an
  estimate of `width * height / 750` visual tokens for images that need no
  resizing (https://docs.anthropic.com/en/docs/build-with-claude/vision). Set an
  initial visual-token budget from the measured candidates and a small quality
  probe, then choose the highest-resolution candidate at or below that budget.
  If every candidate exceeds it, choose the smallest; if every candidate is
  below it, choose the largest. Reject a selected candidate above the existing
  5MB cap. A likely standard-photo result is the roughly 800px variant instead
  of 1280px, about 640 versus 1,638 tokens for 4:3, but the captured payloads and
  image-reading probe decide the shipped constant.

The quality probe must cover text-heavy screenshots, receipts/documents, people
and ordinary scenes. Compare answer correctness at each candidate size, not only
visual appearance. Log selected dimensions, estimated tokens and bytes after
0.5b so the saving is observable. This is independently useful today and a
precondition for persisting image blocks in Phase 1.

## Phase 1 — Persist the real message log (DONE)

**1.1 Migrate conversation history and delivery state in one migration**, so
the schema moves once. **DONE** (migration `0024`, `store/messages.ts`, the new
conversation-port methods). Deviations from the text below, all deliberate:

- Attachment references are not duplicated into `pending_messages`. Attachment
  rows are already written by `enqueueTurn` against the conversation and are
  addressed by the marker in the message text, so the queue stores the text
  only.
- The queue is drained once per turn, at turn start, not "at each safe point".
  Mid-loop injection is 1.3; until then the drain is what supplies the prompt.
- `stopReason` is stored for every assistant row, but the value is currently
  written by the persist-before-send path as `end_turn`, not read off a model
  response. 1.3 is where the model's own reason lands.
- Migration `0024` stamps legacy assistant rows `end_turn`. Without it the new
  work rule would treat every historical conversation as unfinished.

The original text:

- `content` becomes `ContentBlock[]` as JSON. Store wire format verbatim —
  `protocol.ts` round-trips unknown block types (`thinking`, server tool use),
  so raw storage is forward-compatible where a normalized schema would drop
  them. Existing string-content rows must keep working.
- Add a `kind` column: `user_message` / `assistant_message` / `tool_result`.
  One model response remains one `assistant_message`, even when its content
  contains both text and `tool_use`; do not split or normalize a wire message.
- Add `consolidatedAt`, the per-message marker Phase 3 needs.
- Add a durable `pending_messages` queue for Telegram inputs. Webhook enqueue
  writes there, not directly into the model transcript. Keep arrival order,
  message timestamps and attachment references; processed-update dedupe remains
  the outer idempotency guard.
- Add delivery records keyed by `(messageId, textBlockIndex)`, with a durable
  claimed timestamp. They prevent a persisted assistant block from being sent
  again after resume without changing the stored wire message.

There is no `turnId`, active-turn pointer, reply watermark or turn-status table.
Follow pi's follow-up model (current `badlogic/pi-mono` `origin/main`,
`packages/agent/src/agent-loop.ts:262-268`): incoming messages wait outside the
transcript while the current agent finishes; when it would otherwise stop, they
are injected as user messages and the same loop continues.

Use "all" queue semantics for Telegram bursts: at each safe point, one SQLite
transaction drains every pending message for that conversation in arrival order,
inserts the corresponding user messages at the transcript tail, and marks the
queue rows injected. The transaction prevents a reset from losing or injecting
a message twice. If the transcript is idle, the same drain supplies the initial
prompt. If a message arrives after the final empty check, `enqueueTurn` arms a
fresh immediate alarm, as it does today.

Replace `findThreadsAwaitingReply` with protocol-aware
`findConversationsWithWork`. Work exists when the pending queue is non-empty or
the persisted transcript needs continuation: a real user message or tool result
needs a model response, or an assistant `tool_use` lacks finalized results. An
assistant message with a terminal stop reason and an empty pending queue is idle.
Persist stop reason with every assistant response so this is data, not an
inference from text or role. `runTurn` must move from string/tail assumptions to
this state machine.

**1.2 DONE.** Add a per-conversation compaction boundary and summary.
`getConversationHistory` returns `AgentMessage[]` rendered as
`summary + messages after boundary`, with the staleness filter applied. Delete
the 20-message window (`DEFAULT_HISTORY_LIMIT`).

**Keep a backstop ceiling until Phase 3 ships.** Phases deploy independently, and
nothing moves the boundary in production until the 3.4 activation, so removing
the limit here would put unbounded context into production between deploys.
Keep a hard message/char ceiling here and delete it in the same 3.4 commit that
enables size-triggered compaction. Do not ship 1.2 with neither.

**1.3 DONE** (see "What Phase 1.3 shipped").
Persist as the loop runs. Store each model response as one verbatim
assistant wire message before executing its tools; store the ordered
`tool_result` user message before making the next model call. A response that
contains text and `tool_use` stays one row. Image blocks are persisted
**verbatim** (see the design decision above); 0.5 is what keeps them small.

A reset can occur after a tool side effect but before its result row. Handle the
three classes explicitly, keyed internally by `tool_use.id` rather than exposing
another marker to the model:

- read tools may run again;
- topic writes replay with their original `expectedVersion`, so an already
  committed mutation conflicts and cannot duplicate;
- external writes (`gmail_send`, `calendar_create_event`) get a durable
  `started` claim before the request leaves and a `completed` result after it
  returns. On resume, never repeat a `started` call whose outcome is unknown;
  persist an uncertainty result telling the model/user to inspect Gmail or
  Calendar before another attempt. This is the same explicit at-most-once
  tradeoff as Telegram delivery, not a claim of impossible exactly-once I/O.

Text delivery remains persist-before-send. Derive one delivery record per
Telegram text block from the persisted assistant response and claim it durably
before the fetch leaves. On resume, claimed blocks are not sent again. This
keeps the existing at-most-once tradeoff (a reset between claim and Telegram may
lose one message) explicit instead of overloading transcript state with delivery
state.

After a terminal assistant response or fallback is persisted and delivered, do
not end immediately. Atomically drain pending Telegram follow-ups. If any were
injected, continue the same agent loop and let them receive the next response;
if none exist, return. Follow-ups never interrupt a model stream or the current
tool loop. They are checked only at the point where the agent would otherwise
stop.

Keep the existing per-turn writer handoff (`renderTranscript`) unchanged during
Phase 1. It already receives the in-memory messages generated by each completed
loop segment, and forcing it onto the durable log would require artificial turn
IDs solely for a module deleted in Phase 3. Delete `renderTranscript`,
`MAX_TOOL_RESULT_CHARS` and `MAX_RESEARCH_RESULT_CHARS` together with the writer
at the LearningDO cutover.

**1.4 DONE.** Migration `0027` adds `messages.responseId`; `runAgent` takes
`previousResponseId` and opens its chain on the conversation's newest persisted
response id, marking that first request `crossRun` so `cache_diagnostic` carries
`chain_crossed_turn`. Research and the writer pass no id, so no chain crosses an
agent boundary. Zero's own fallback text is persisted with no response id, so it
never becomes a chain anchor. The original text:

Chain cache diagnostics **across model calls and alarm resumptions**.
Today `previous_message_id`
chains only within a run, so a cross-turn cache break is invisible. With an
append-only log, turn N+1's prefix genuinely extends turn N's: persist the last
response id per conversation and chain it.

Constraint this phase does not remove: the messages-region cache TTL is 5m
(1h for tools and system), so a conversation resumed later gets no message cache
hit however well shaped the log is. The win is "do not re-fetch" across sessions
and "cheap prefix" within one.

## Phase 2 — ScheduleDO and LearningDO shell (DONE)

**2.1 DONE.** Both classes exist with bindings `SCHEDULE_DO` / `LEARNING_DO` and
migration tag `v7` (`new_sqlite_classes`), exported from `src/index.ts`, keyed by
the same Clerk user id, with typed stubs (`ScheduleDO/stub.ts`,
`LearningDO/stub.ts`). Their decision logic lives in DO-free modules
`do/schedule.ts` (deadline set, earliest-first alarm arming, `takeDueDeadlines`,
`touchConversation`, `IDLE_LEARN_MS`) and `do/learning-job.ts` (one active job
plus at most one successor, a `size` request taking over the successor and keeping
its conversation id), both unit-tested. `LearningDO.alarm` deliberately has no
executor yet: it logs `learn_skipped` with `executor_not_enabled` and promotes any
successor, because the per-turn writer is still what consolidates. Nothing calls
`touch` or `requestLearn` yet — that is 2.3 and 2.4.

Add two Durable Object classes, both one instance per user:

- `ScheduleDO` owns every deadline: idle learning, Google onboarding, admin
  tasks and anything scheduled later.
- `LearningDO` owns queued/active learning-job state and its execution alarm.

Add both bindings and one new migration tag (`v7`, `new_sqlite_classes`) in
`wrangler.jsonc`, export both classes, update generated Cloudflare types, and
derive all three DO IDs from the same Clerk user ID. Creating both namespaces in
one migration avoids another schema-only deploy in Phase 3.

**2.2 DONE.** `UserDO.alarm()` is only `runAlarmTurns`. The admin-task and
onboarding branches became the RPCs `runQueuedAdminTask` / `runQueuedOnboarding`,
each a no-op unless its job is queued, dispatched by `ScheduleDO.alarm` via
`ScheduleDO.requestJob(clerkUserId, reason)`. `queueAdminTask` in
`do/admin-task.ts` no longer sets an alarm at all (its storage port lost
`setAlarm`), and `UserDO.queueOnboarding` now takes the Clerk user id so it can
reach that user's schedule. The original text:

`UserDO.alarm()` keeps **only** `runAlarmTurns`. Onboarding and
admin-task deadlines move to ScheduleDO, which triggers their existing UserDO
RPC entry points. Direct lesson from 2026-07-29: a DO has one alarm, and anything
sharing it with turn draining eventually delays a reply. Today `alarm()` runs an
admin task, then turns, then onboarding (`src/UserDO/index.ts:129-155`) — that is
the shape being dismantled.

**2.3 DONE.** `UserDO.enqueueTurn` calls `touchScheduleSafely` after the durable
enqueue and after arming the turn alarm. Both directions of "best-effort" are
in `do/schedule.ts` (`touchScheduleSafely`, `requestLearnSafely`) and unit-tested,
so a schedule that throws never rejects a user's message. The original text:

Each accepted user message calls
`ScheduleDO.touch(conversationId)` to push that conversation's idle deadline to
now+1h. Do this after durable enqueue, not after the model turn, so an LLM failure
does not make an active conversation look idle. ScheduleDO stores all
conversation deadlines and arms its one alarm for the earliest. Wrap the RPC
best-effort: a scheduling failure must never reject `enqueueTurn`.

**2.4 DONE.** `LEARN_SIZE_THRESHOLD_TOKENS` (45,000, provisional) lives in
`store/messages.ts`; `runTurn` compares it against the same estimate it logs as
`context_rendered.total_tokens`, logs `learn_size_requested` and calls the
`onContextTooLarge` hook, which UserDO wires to
`requestLearnSafely(schedule, clerkUserId, "size", conversationId)`. The check
runs before the model call: an oversized conversation is oversized whether or not
the turn succeeds. The original text:

Size trigger is an event, not a poll. UserDO knows rendered size after a
turn, so it calls `ScheduleDO.requestLearn("size", conversationId)`. When either
learning trigger becomes due, ScheduleDO calls `LearningDO.request(...)`; that
short RPC persists/coalesces the job and arms LearningDO's alarm. ScheduleDO
never awaits the learning work.

**Trap, explicitly:** `enqueueTurn` arms the alarm only when none is set
(`if ((await getAlarm()) === null)`, `src/UserDO/index.ts:99`). If a schedule or
learner ever shares UserDO's alarm slot, a queued message waits for it. Keeping
both in different DOs is what makes that impossible; do not "simplify" later by
folding them back.

Both new alarm handlers need start and completion markers. The markers added on
2026-07-29 live in `runAlarmTurns` and cover neither class.

## Phase 3 — Durable learning (DONE)

**3.1 DONE.** Migration `0028` adds `learning_jobs`; the Store gained
`beginLearningJob` (frozen high-water mark, stable on re-attach),
`listUnconsolidatedMessages` (paged, id order) and `completeLearningJob`
(idempotent by job id, never above the mark). `learning/types.ts` is the port,
with adapters `store-port.ts` (local Store) and `remote-port.ts` (UserDO RPC),
both run against one shared suite. `tools/topics.ts` now takes a `TopicToolStore`
whose methods may be sync or async, so the learner uses the same versioned tools
as a turn. UserDO exposes the flat `learn*` RPC surface, with topic writes
returning `TopicWriteResult` data that the remote adapter turns back into a
`KnowledgeConflictError`. The original text:

Implement the remote learning port on UserDO: begin a job at a frozen
high-water message ID, page raw unconsolidated messages, perform versioned topic
reads and writes, complete a job, and compact one conversation. The interface
contains data and invariants, not do-orm types. It uses the same
`knowledgeVersion` contract as the interactive tools; LearningDO gets no
unchecked write interface.

**3.2-3.3 DONE.** `agents/learner.ts` holds the DO-free half: `renderLearningLog`
(raw messages grouped per conversation, tool results kept but capped),
`runLearnerSlice` (the shared `runAgent` over the port's topic tools, bounded by
`LEARN_STEPS_PER_SLICE` = 12, returning `finished` from the finish reason) and
`summarizeConversation` (one tool-free call). `LearningDO` drives them: freeze the
mark, page up to `LEARN_JOB_BUDGET_TOKENS` of rendered input, append each response and each result to
a per-key wire log (`do/learning-log.ts`, one message per key because a DO storage
value is capped at 128 KiB), re-arm while unfinished, compact on a `size` job, then
`completeJob` and promote any successor. Prompts: `learnerSystemPrompt` shares one
`KNOWLEDGE_MAINTAINER_RULES` body with the writer, and `compactionSystemPrompt`
forbids copying topic knowledge into an unversioned summary. Not yet activated:
ScheduleDO dispatch reaches `LearningDO.request`, but the per-turn writer still
runs (3.4). The original text:

Implement LearningDO's checkpoint machine described under “Durable
learning protocol”. Store job state and the learner's append-only wire log in
LearningDO SQLite. Each alarm invocation runs a configured small number of model
steps, persists before every external mutation, and re-arms when unfinished.
There is no `ctx.waitUntil` path.

Bound both the model-step count and the number of topic mutations per alarm
slice. An uncaught unexpected failure gets Cloudflare's alarm retry; a normal
unfinished slice gets an explicit new alarm. Coalesced requests run after the
active frozen range, so messages are never silently added to a job whose prompt
was already built.

**3.3 DONE** (same commit as 3.2; covered by `agents/learner.test.ts`, including a
slice cut off by its bound and a kill after an applied write, which conflicts
instead of appending twice). The original text:

Complete and test the end-to-end learner path while production learning
triggers remain disabled. The learner consolidates raw unconsolidated messages
up to its frozen high-water mark. On a size reason it also compacts the named
conversation up to a frozen boundary. A clean idempotent completion stamps the
covered messages. Topic writes have already advanced `knowledgeVersion`;
completion does not invalidate reads again.

**3.4 DONE.** `agents/writer.ts` (+ its tests), `renderTranscript`,
`MAX_TOOL_RESULT_CHARS`, `MAX_RESEARCH_RESULT_CHARS`, `InterfaceAgentResult.transcript`,
`writerSystemPrompt` and the `writer` gateway label are deleted; the turn ends
when delivery and `turn_completed` finish. The Phase 1.2 backstop is gone:
`applyContextBackstop` and `CONTEXT_BACKSTOP_CHARS` were removed and
`CONTEXT_BACKSTOP_MESSAGES` became `CONTEXT_MESSAGE_PAGE` (500), a query bound
rather than a ceiling — what bounds context now is size-triggered compaction.
`accessed` survives only as the `accessed_count` log field. The original text:

Replace the per-turn writer directly in one activation commit: enable
ScheduleDO's idle/size dispatch to `LearningDO.request`, remove the writer call,
delete the old writer module and its `renderTranscript` handoff/truncation
constants, and remove the Phase 1.2 context backstop now that size compaction is
live. There is no intermediate deploy with dual writers, no
shadow mode, and no proposal-comparison path. The turn ends when final
reply/fallback delivery and explicit turn completion finish. Verification uses
tests and the first production learning jobs; rollback is the previous commit.

Idempotence is an implemented protocol, not an acceptance note: kill tests must
prove that a retry after each persistence point neither duplicates an append nor
skips a message range.

## Review fixes (PR #40, DONE)

Six correctness findings from the review of this branch, all closed before merge.
See `docs/plans/pr40-review-fixes.md` for the reasoning behind each.

1. A response persisted but never sent is now work: the predicate counts
   unclaimed text blocks, and such a conversation is delivered without a model
   call, logging `turn_delivery_recovered`. The fallback and rate-limit replies
   take a claim too. Rows written before claims existed carry no claim either,
   so migration 0029 stamps a per-conversation delivery watermark below which
   the absence of a claim means "sent by the old path" — without it the first
   alarm after the deploy resends the last reply of every conversation, which is
   what happened in production on 2026-07-30.
2. Compaction pages forward from the boundary instead of reading the newest
   rows, so the boundary can never jump over rows no summary covers. A window
   that stops short hands the rest to a successor pass.
3. The boundary may only land after a terminal assistant response, so it cannot
   split a `tool_use` from its `tool_result`. Rendering drops leading orphan
   results as a backstop.
4. A learning job stamps only the messages it was shown, and its input is
   bounded by the rendered size of the learner prompt
   (`LEARN_JOB_BUDGET_TOKENS`, a guess to be moved from `learn_started`) rather
   than the unexplained 400-message count.
5. A failed dispatch in ScheduleDO is rescheduled with backoff instead of being
   dropped; onboarding and admin tasks had no other trigger.
6. An irreversible call whose failure does not prove non-effect keeps its claim
   in flight and reports an unknown outcome. Only `ExternalCallNotSent` from the
   adapter completes the claim.

## Test strategy

- **Phase 0**: existing suites stay green; 0.2 migrates every non-empty legacy
  summary without losing text, rebuilds links for changed bodies, and proves the
  resulting schema has no summary column. 0.3 covers all four write tools,
  stale-version conflicts, sequential returned versions, concurrent calls where
  only one version wins, a bundled-system-topic version bump, create/rename
  collisions, and the existing-empty-topic onboarding regression. 0.4 needs multi-message turns, a persist-before-send
  ordering test that fails if reversed, and a fallback test for a run that ends
  non-`stop` with no text. 0.5 needs order-independent candidate handling,
  token-budget selection, all-over/all-under-budget fallbacks, missing
  `file_size`, over-5MB rejection, and the representative image-quality probe.
- **Phase 1**: replace tail-role tests with protocol-state tests: pending queue,
  terminal assistant, tool result awaiting a model call, and assistant tool use
  with missing results. Prove atomic queue injection survives a reset without
  loss/duplication; a Telegram message arriving during tools is not injected
  until the agent reaches terminal stop; all messages queued by then are
  injected in arrival order and receive the next response; a message racing the
  final empty check arms another alarm. Round-trip mixed text/`tool_use` and
  image blocks byte-identically; resume without re-calling completed tools;
  preserve existing string rows; stub missing/mismatched `knowledgeVersion`
  topic results while retaining every tool pair; prevent a repeated versioned
  append; report a `started` external write uncertain rather than call it again;
  prove a claimed Telegram delivery is not resent. Existing writer transcript
  tests stay until Phase 3 deletes that module.
  Covered by 1.1 already: every protocol-state case of the work rule, queue
  drain order and idempotence, per-block delivery claims, mixed text/`tool_use`
  round-trip, and pre-migration plain-text rows. Still open: everything that
  needs the loop to persist as it runs (resume without re-calling tools,
  mid-tool follow-ups, staleness stubs, external-write uncertainty).
- **Phase 2**: `runAlarmTurns` tests stay; ScheduleDO tracks multiple deadlines
  and arms the earliest; a due deadline queues LearningDO without awaiting it;
  a queued turn is never blocked by either new alarm; a throwing `touch()` does
  not fail enqueue; completion markers appear on success and are absent on an
  uncaught failure.
- **Phase 3**: use an in-memory learning-port adapter to kill and resume after
  every checkpoint. Retrying an applied append gets a version conflict and then
  observes the already-appended text; repeated completion is a no-op; messages
  above the frozen high-water mark stay unconsolidated; a bounded unfinished
  slice re-arms itself; coalesced requests become a successor. After any topic
  writer, a different conversation stubs its old-version read (write this
  invariant first); size learning works for an always-active conversation;
  compaction affects only the requested conversation, never deletes raw learner
  input, and cannot copy a stale topic result into its summary.
- Package-scoped: `pnpm --filter @zero/agent-api run test | lint | typecheck`.
  `gob run bin/ci` cannot run on this box (`workerd` will not start on NixOS).

## Documentation

- `docs/topics.md`: durable Telegram follow-up injection, learning triggers, the
  staleness filter, and the deleted per-turn writer.
- `docs/caching.md`: cross-turn diagnostic chaining; why the staleness filter
  invalidates a prefix and why that is acceptable; why images are never
  rewritten in place.
- `docs/framework.md` or `docs/design.md`: the UserDO/ScheduleDO/LearningDO
  split, the remote learning port, and why deadlines and long agent work are
  separated from turn draining.
- `apps/agent-api/CHANGELOG.md`: 0.4, 0.5 and Phase 3 are user-visible. Load the
  `changelog` skill first.

## Skills to use

- `code` — per phase, to execute it.
- `cloudflare` — before adding the ScheduleDO/LearningDO bindings, migrations,
  alarm handlers and RPC methods.
- `deep-modules` — when defining the remote learning port so transport and
  checkpoint mechanics stay behind one learner interface.
- `tdd` — for the 1.1 awaiting-reply invariant, the Phase 1 store round-trip and
  the 0.4 ordering test.
- `changelog` — before touching `apps/agent-api/CHANGELOG.md`.
- `git-commit` — one commit per numbered item.
- `reproducible-locally` — after each deploy; use Workers Logs `invocations`
  view, not the AI Gateway logs, which lag by minutes.

## Acceptance criteria

- Tests, lint, typecheck pass at every phase boundary.
- After Phase 0: `topic_list_rendered.chars` drops and writer input per run drops
  with it, while `topic_reads_per_turn` does not rise to eat the saving.
- After Phase 1: `topic_reads_avoided` is non-zero and larger than `stale_stubs`
  over a day of real traffic, and every positive `followup_queue_depth` returns
  to zero with a matching `followups_injected` event. Capture the pre-Phase-1
  baseline for topic reads and AI Gateway cost before starting.
- After Phase 2: `turn_queue_delay_ms` stays in the low seconds even when a
  schedule and a LearningDO job are pending; ScheduleDO invocations end after
  queueing and never span learner model calls.
- After Phase 3: `writer_started` no longer appears in turn invocations;
  `learn_slice_completed` proves long jobs advance through bounded slices;
  version-conflict counts can be observed without duplicate topic content; AI
  Gateway cost per turn over a fixed 10-turn session falls against the baseline
  captured before Phase 1; `turn_completed` still appears on every turn.
- Every claim above is checkable from a log query rather than by reasoning about
  the code. If a criterion cannot be checked that way, the logging for that
  phase is incomplete.

## Risks

- **Deleting `reply` changes user-visible behaviour.** Message boundaries shift,
  and a preamble the model used to keep to itself can become a message. Check
  against a real transcript before shipping.
- **Learning still makes long external calls.** LearningDO isolates them from
  turn draining, but one model call can still approach the wall-time ceiling.
  Bound steps per slice, checkpoint before side effects, leave unexpected alarm
  errors uncaught for platform retry, and use the missing completion marker to
  detect a stall.
- **The size threshold is a guess until measured.** Self-correcting only if
  `context_rendered.total_tokens` actually lands with Phase 1. If that logging
  slips to Phase 3, the threshold gets shipped blind and the risk is real.
- **The staleness filter is prompt-visible.** A model that ignores the stub and
  reasons from surrounding context could still answer stale. Mitigated by the
  stub replacing the content entirely, so there is nothing left to reason from.
- **Storage growth.** A persisted log with tool results and images grows without
  the 20-message window. `conversation_size` is the watch; compaction does not
  shrink storage, only context.
- **This plan assumes Zero keeps its own storage.** If the Cloudflare Agents SDK
  Session API or Agent Memory is adopted after a bake-off, Phase 1 overlaps
  most. Not wasted: Session stores wire-format messages too, so migration is
  reading our rows and writing theirs, not redesigning the model.

## Open decisions

- Whether production reread counts eventually justify replacing the one global
  `knowledgeVersion` with finer revisions. Do not add them before the coarse
  counter is measured.
- Whether `research` results should also be stubbed. They are immutable
  findings, so probably not, but they are the largest persisted results.
- How long descriptions may grow before they stop being cheap routing text.
  Decide from `topic_list_rendered.chars` and `topic_reads_per_turn`; do not
  reintroduce a summary field.
