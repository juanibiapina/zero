# Topic model and the two-phase meta-agent

Zero handles each Telegram turn with two stateless agents that run inside the
per-user `UserDO` Durable Object. Between turns, the only durable state is the
SQLite in the DO: topics, conversations, and messages. There is no container and
no per-user filesystem.

## Topics

A **topic** is a living knowledge document about a subject (a project, a person,
an ongoing thread). Columns (see `apps/agent-api/src/UserDO/db/schema.ts`):

- `name` — human label the agent addresses (unique). A surrogate integer `id` is
  the internal key, so a rename is a one-field `name` update.
- `description` — short routing blurb: what belongs in this topic. It is the
  only field `list_topics` returns besides the name, so it is routing text, not
  a second knowledge document.
- `body` — the knowledge document (markdown).
- `createdAt`, `lastActiveAt`, `messageCount` — activity tracking.

Topics are the agent's long-term memory. They are addressed by name through the
tools below; the interface agent discovers them itself (no separate routing
pass).

### Links between topics

Topic bodies link to each other with Obsidian-style `[[Topic Name]]` tokens, so
the knowledge model is a graph, not a flat list. A link is the target topic's
exact `name` wrapped in double brackets; it resolves to that topic. This lets
the learner keep topics small and granular and connect related subjects (a person
links `[[Trip to Japan]]`, a project links `[[Deadline]]`) instead of copying
facts between bodies.

Links are first-class rows in `topic_links` (see `schema.ts`, migration
`0018_topic_links.sql`): one row per (source topic, target name), with a
`targetId` foreign key resolved when a topic of that name exists (else null, a
dangling link). The `Store` maintains one invariant: a topic's outbound rows are
always exactly the `[[Name]]` tokens in its current body. `syncOutboundLinks`
re-derives them on every `saveTopic`/`updateTopicBody`, so rows never drift from
the text. Creating a topic resolves any dangling links that were waiting for that
name. A rename rewrites `[[old]]` -> `[[new]]` in every other body and re-derives
their rows, so bodies and links move together and never break. This logic lives
in both Store adapters and is covered by `store/store-contract.test.ts`; the
`[[Name]]` parsing/rewriting helpers are the pure functions in `store/links.ts`.

Agents see the graph through the topic tools: `get_topic` returns a topic's
`outboundLinks` and `backlinks` alongside its body, and `list_backlinks` lists
what references a topic (used before renaming or merging).

### Pinned topics

A topic can be **pinned** (`pinned` column, migration `0019_topic_pinned.sql`).
Pinned topics are always rendered into the interface agent's system prompt under
a "Pinned topics (always in your context)" block, so their current bodies are
available every turn without a `get_topic` lookup. Pinning is a Store operation
(`setPinned(name, pinned)` / `getPinnedTopics()`), not an agent tool; a pinned
topic is otherwise an ordinary topic reachable by the normal tools and
consolidated by learning like any other. The canonical use is a stable
`User` topic seeded at Google onboarding (see `docs/onboarding.md`).

Each pinned body is capped (~1.5 KB) when rendered into the prompt so a topic
that keeps growing can't blow up the prompt; the full body is still reachable
via `get_topic`. Pinning survives a `saveTopic` rename. The tradeoff is a
slightly higher token cost every turn in exchange for always-on identity.

### System topics

Some topics are **read-only reference documents bundled with the Worker**, the
same for every user and versioned with the code. They live in no user's SQLite.
There are two: `Zero` (the assistant's own identity and how it communicates,
pinned so it is always in context) and `Changelog` (Zero's user-facing changelog,
unpinned but discoverable via `list_topics`, its body sourced from
`apps/agent-api/CHANGELOG.md`). Their definitions are `SYSTEM_TOPICS` in
`store/system-topics.ts`; the `Zero` body is authored inline and the `Changelog`
body is a text import of `apps/agent-api/CHANGELOG.md` (bundled via the wrangler
`Text` rule for `**/*.md`, mirrored for vitest by the `text-imports` plugin in
`vitest.config.ts`).

They are not seeded into the database. `SystemTopicStore` (same file) decorates
the `Store`: it overlays the bundled topics onto every read
(`getTopic`/`listTopics`/`getPinnedTopics`/`getTopicsWithBodies`/`getOutboundLinks`,
with `system: true` set on the returned rows) and rejects every write to a
system name (`createTopic`/`saveTopic`/`updateTopicBody`/`deleteTopic`/`setPinned`
throw `topic is read-only`). `getBacklinks` delegates unchanged, so a user topic
linking `[[Zero]]` still resolves. The `UserDO` wraps its `DbStore` in this
decorator once at construction, so every consumer (DO RPC methods, the
orchestrator, all three agents) sees the same overlay. Read-only is thus enforced
structurally at the store boundary, not by a prompt or a soft tool check; the
`update_topic`/`delete_topic` tools surface the thrown error as a tool error. The
learner prompt also tells it not to edit `Zero`/`Changelog`, to avoid a wasted,
always-rejected call. Updating a system topic is a source edit plus deploy (edit
the `Zero` body or `apps/agent-api/CHANGELOG.md`); every user picks up the new content with no
migration and no per-user seeding.

## The turn, and what happens after it

1. **Interface agent** (`agents/interface.ts`, stateless per turn). Given the new
   user message plus recent history, it runs a tool loop and sends replies as it
   works. The history is assembled as a real multi-turn conversation
   (`buildConversationMessages`), not a single flattened prompt: each stored row
   becomes a native turn — a user message as text with an absolute
   `[YYYY-MM-DD HH:MM]` timestamp, a model response with its content blocks
   verbatim (tool calls included), a tool-result row as the `user` turn the wire
   format expects. Sending back the same bytes the model produced is what makes
   the prefix cacheable across turns. Leading assistant messages are dropped, and
   consecutive same-role turns are coalesced.
   Instructions, the datetime anchor, and pinned topics stay in the system
   prompt; only the dialogue is in the messages array. Tools (`tools/topics.ts`):
   There is **no `reply` tool**. The assistant's own text blocks are the
   messages: the runner delivers each one (persist, then send) as the model
   produces it, before that step's tools run, so a turn that acknowledges and
   then answers is just a model that wrote text on two steps. A run that ends
   without a terminal stop reason, or that never sent anything, gets the
   no-silence fallback. Tools (`tools/topics.ts`):
   - `list_topics`, `get_topic`, `create_topic`, `edit_topic`, `append_topic`,
     `update_topic_metadata`, `list_backlinks` — read/write the knowledge model and its
     `[[Name]]` link graph. Every topic touched is added to an `accessed` set.
   - `read_page(url)` — open a web address and return its cleaned markdown.
     Registered here as well as on the research agent, so a link the user hands
     over is read directly instead of spawning a research run. Full URLs and
     shorthand (`thing.com/path`) both work; the adapter normalizes them.
   - `delete_topic` — permanently remove a topic. Interface-agent only (not in
     the shared `buildTopicTools`, so the learner and research agents cannot
     delete),
     and the prompt gates it on explicit user confirmation. Deleting a topic
     drops its own outbound link rows; inbound links from other bodies keep
     their `[[Name]]` text and become dangling, re-resolving if a topic of that
     name is recreated. Bodies of other topics are left untouched.
2. **Learning agent** (`agents/learner.ts`), which does **not** run on the turn
   path. It is the same `runAgent` machine with the same shared topic tools
   (`buildTopicTools`), reading the raw message log since the last consolidation
   across all of the user's conversations, and it runs in LearningDO on its own
   alarm (see "How a learning job runs"). Durable facts often live in tool
   results — calendar events, email bodies, research reports — so it reads the
   persisted results, not a summary of the turn. For each topic that gained
   durable information it reads the body (`get_topic`), merges new facts under
   sensible sections with `edit_topic`, appends one `## Log` line with
   `append_topic`, and uses `update_topic_metadata` only to refresh the
   description or rename. It never rewrites or compacts a body — the tools
   enforce that, not only the prompt. With `list_topics` + `create_topic` it is
   also proactive: it creates a topic for any durable subject with none. The
   prompt biases it toward recording generously (people, projects, events, trips,
   gear, house/utilities, goals, and any other recurring subject; the list is
   illustrative).

A third agent gathers material for topics: the **research agent** (spawned by
the interface agent's `research` tool; see `docs/research.md`). It has read-only
topic tools + `web_search` + `read_page` and **no write tools**; it returns a
compact sourced findings report as its tool result rather than writing topics
itself. Learning persists those findings later: the report is a persisted tool
result in the conversation log, so the learner reads the real thing rather than a
truncated copy. It is prompted to **preserve research findings and their
reference URLs verbatim** (fold near-duplicate research topics together rather
than rewriting a body). Preservation is prompt-enforced; if it degrades in
practice, the stronger fix is a mechanically protected body region.

The topic tools are shared, and **no tool replaces a complete body**:

- `create_topic(expectedVersion, name, description, body)` — create a topic
  whole. An empty body and an existing name are tool errors.
- `update_topic_metadata(expectedVersion, name, description?, newName?)` —
  routing description and rename only; it never accepts body text.

Revising an existing body goes through the incremental writes:

- `edit_topic(name, oldText, newText)` — replace an exact snippet of the body.
  `oldText` must match exactly once; zero matches and multiple matches are tool
  errors that tell the model which case it hit, so it can re-anchor.
- `append_topic(name, text)` — add to the end of the body, separated by a blank
  line.

Both write through `store.updateTopicBody`, which re-derives the `[[Name]]` link
rows, and both check `getTopic` themselves before writing: `DbStore.updateTopicBody`
silently no-ops on an unknown topic while `MemoryStore.updateTopicBody` throws, so
a store-level check would pass tests and lose writes in production.

## Conversation context

What the model sees for a conversation is `summary + messages after the
compaction boundary`, not a fixed window of recent messages. Compaction is
non-destructive: `conversations.compactedThroughMessageId` moves and
`conversations.summary` holds the prose covering everything up to it, while every
raw row stays in storage, because learning reads the raw log. A conversation that
has never been compacted has neither, which renders as the whole log.

Two mechanical filters run at render time, both in `store/messages.ts`:

- **Backstop ceiling** (`CONTEXT_BACKSTOP_MESSAGES`, `CONTEXT_BACKSTOP_CHARS`).
  Nothing moves the boundary in production yet, so this is what keeps context
  bounded in the meantime: at most 60 messages, then the oldest are dropped until
  the rendered characters fit. The newest message is always kept. Both constants
  go away when size-triggered compaction is switched on.
- **Staleness stubs.** A persisted topic read carries the knowledge version it
  was taken at (see below). If that differs from the current version, the
  `tool_result` content is replaced by
  `[stale: topic knowledge changed; reread before using or writing]`. It is
  replaced, never removed: the wire format requires every `tool_use` to keep its
  matching result. There is no LLM call and no per-topic bookkeeping.

`context_rendered` logs the estimated total tokens, the summary tokens, how many
messages survived the boundary, and how many results were stubbed. The compaction
threshold is derived from that line, not guessed.

## Learning triggers

Learning is asked for in two ways, and both are events rather than polls:

- **Idle.** Every accepted user message pushes that conversation's deadline to
  now + 1h in ScheduleDO. When it comes due with no newer message, the schedule
  asks LearningDO to consolidate.
- **Size.** When a turn renders a context at or above
  `LEARN_SIZE_THRESHOLD_TOKENS` (45,000, provisional — it is the starting point
  from PLAN.md, to be moved using real `context_rendered.total_tokens`), the turn
  asks for learning on that conversation immediately, logging
  `learn_size_requested`. This is what covers a conversation that never goes
  idle; without it an always-active user would grow context without bound.

Both requests are best-effort from the turn's point of view: a schedule that
cannot be reached is logged and ignored, never allowed to fail a message or a
reply.

## How a learning job runs

A job is one active run per user with at most one successor queued behind it. A
request that arrives while a job is running is coalesced into that successor,
because the active job froze its input range when it started: messages that
arrive later belong to the next job, never to a prompt that was already built.

At the first slice the job asks UserDO for a high-water message id and pages the
unconsolidated messages up to it. That id is frozen and idempotent by job id, so
a restart never widens the range. The page is bounded by the rendered size of the
learner's prompt, not by a message count, because that is the resource the input
actually consumes; a job that fills the budget stamps only the messages it was
shown and hands the rest to a successor. Then, per alarm:

- a bounded number of model steps run (`LEARN_STEPS_PER_SLICE`);
- each response is appended to the learner's durable wire log before its tools
  run, and the tool results before the next model call;
- an unfinished slice arms an immediate alarm and returns normally;
- an unexpected failure is left uncaught, so Cloudflare's at-least-once alarm
  retry runs.

The bound is not belt-and-braces: a DO alarm invocation is killed at 900s wall
time with no exception and no log, so a job that cannot make progress in slices
would simply vanish. A slice that dies mid-flight replays its last response, and
a topic write that had already been applied conflicts on its expected version
instead of appending twice — which is why the version contract, not an operation
marker, is what makes learning safe to retry.

When the learner stops cleanly, a `size` job also compacts the named
conversation, then UserDO stamps the messages the learner read as consolidated
(idempotent by job id, never past what was read, and it does not touch the
knowledge version — the topic writes already did). Only then is a queued
successor started.

Compaction summarizes the conversation up to a boundary, keeping the newest
exchanges raw. It reads **forward from the current boundary**, one window at a
time, and a window that does not reach the tail hands the rest to a successor
pass. Reading the newest messages instead and then moving the boundary to the end
of that window would jump the boundary over everything in between, and no summary
would ever cover those rows.

The boundary may only land **after a terminal assistant response**, so what
survives it starts on a user message. A cut by row count can fall between an
assistant tool call and its result, and the rendered context would then open on a
result whose call is missing, which the API rejects. Rendering applies the same
rule defensively: a window truncated by the read limit drops its leading orphan
results.

The summary must never carry topic knowledge: it is unversioned, so anything
copied into it could never be detected as stale. The prompt says to name topics
as `[[Topic Name]]` and reread them instead.

## Knowledge versions

Every topic read (`list_topics`, `get_topic`, `list_backlinks`) returns the
user's `version`: one integer covering every topic body, the catalog and the
link graph. Every write states the `expectedVersion` it was based on, and the
store compares it to the current value before applying anything. A mismatch
writes nothing and returns a recoverable tool error telling the model to reread;
a success returns the new version, so a chain of writes can use each result as
the next `expectedVersion`. Two conversations that read the same version cannot
both write: the second one is told to reread. Conflicts are logged as
`topic_write_conflict` (tool plus expected/current version, never a name or
content), which is how the cost of the single global counter is measured.

The counter is deliberately coarse. An edit to one topic invalidates reads of
every topic, in exchange for one correctness rule covering bodies, the catalog
and links. The bundled system topics (Zero, Changelog) live in no user's SQLite,
so their content is fingerprinted at build time and compared on each UserDO
init: a deploy that changes their text bumps the version once, which is what
makes a persisted read of them stale.

This exists for cost, not ergonomics. `update_topic`'s full-document `body` meant
that preserving a topic while adding one line to it cost the model the entire
document in generated tokens, growing with the topic without bound: on
2026-07-29 the per-turn writer reached 13,856 output tokens in a single 298s generation,
took 76% of the day's LLM time and 69% of its spend, and the wall time landed on
the *next* message, since turns drain serially per DO. Anchored edits make a
write cost the change. See `docs/plans/writer-latency-investigation.md` for the
measurements. The learner prompt also asks it to split a subject into a new linked
topic once a body passes roughly 8,000 characters, so bodies stop growing without
limit in the first place.

The `TurnOrchestrator` (`agents/orchestrator.ts`) is the runtime-agnostic glue:
render the conversation, run the interface agent, done. It knows nothing about
alarms, DOs, or Telegram, and nothing consolidates knowledge after the reply —
that moved off the turn path entirely (see "Learning triggers"). Until
2026-07-30 a writer agent ran on every turn, which is what put 20-40s of topic
consolidation in front of the user's *next* message. There is no mechanical
log-append fallback: the `## Log` line is a prompt-driven `append_topic` write,
so material the learner judges trivial leaves the model untouched.

## The loop writes into the log as it runs

The conversation is the model's own message log, and it is written while the loop
runs, not after it:

- each model response is persisted **verbatim** (text, tool calls, whatever block
  types the model produced) before any of its tools run and before any of its
  text is sent;
- that step's ordered tool results are persisted before the next model call.

So a turn that dies anywhere has a log that says exactly where it got to, and the
retry continues from there instead of replaying it. Two things follow.

**Delivery is claim-then-send.** The response row is already durable, so what a
resumed run needs is at-most-once sending, not re-persisting: each text block is
claimed in `deliveries` (keyed by row id plus block index) before the Telegram
fetch leaves. A resumed run skips claimed blocks (`delivery_skipped`) and sends
the blocks a reset left undelivered, so an interrupted turn neither repeats itself
nor swallows a message. The residual trade-off is unchanged and deliberate: a
reset between the claim and Telegram loses that one message.

An unclaimed block is therefore **work**, even when the response that holds it is
terminal. A reset between persisting a response and claiming its first block
leaves a finished reply nobody read, and if "the tail is a finished response"
counted as idle, neither the thread scan nor the turn would ever look at it
again. Such a conversation is picked up and delivered without calling the model:
the answer already exists, and re-running it would answer the same message twice.
It logs `turn_delivery_recovered`, because it is the one path that sends a
message and calls no model, so nothing else would record it. The fallback and
rate-limit replies take the same claim, so they cannot be sent twice either.

That rule needs a floor. The `deliveries` table shipped empty, so every reply
written before claims existed has none, and "no claim" would read as "never
sent": on 2026-07-30 the first alarm after the deploy resent the last reply of
existing conversations. Migration 0029 stamps each conversation's newest message
at that moment as a **delivery watermark**, and rows at or below it are treated
as delivered. Rows above it are governed by claims, which is what keeps a real
lost reply recoverable.

**Unfinished tool calls are re-run on resume.** A reset between a response and its
results leaves an assistant tail whose `tool_use` blocks have no `tool_result`,
which is not a valid request, so the resuming run executes those calls and stores
their results before calling the model. Re-running is safe by construction for
the two ordinary classes: read tools are pure, and a topic write replays with the
knowledge version it was based on, so an already-applied write comes back as a
conflict rather than a duplicate append.

**Irreversible calls are claimed, not replayed.** `gmail_send` and
`calendar_create_event` are marked `externalWrite`, and the runner takes a durable
row in `external_calls` keyed by the model's own `tool_use` id **before** the
request leaves, then records the serialized result when it returns. A replay after
a reset therefore lands on that row: a completed call hands its recorded result
straight back without calling Google again, and a call still marked `started`
comes back as an error result saying the outcome is unknown, must not be retried,
and the user should check Gmail or Calendar. That is at-most-once by choice —
neither API offers exactly-once — and it is the same trade made for Telegram
delivery: a possible "did that send?" instead of a possible duplicate.

A *failure* of such a call is classified, not assumed. An exception proves the
tool returned nothing, never that the provider did nothing: a fetch that dies
while reading the response looks identical to one that never arrived, and the
mail may already be sent. Only the adapter can tell, so it raises
`ExternalCallNotSent` when the request provably had no effect (Google not
connected, or a rejection status that is not a timeout or a throttle). That case
completes the claim and the model may try again. Every other failure leaves the
claim `started`, so this call and any replay of its id report the unknown-outcome
error instead of inviting a duplicate send.

**Follow-ups are injected where the loop would stop.** A Telegram message that
arrives mid-run waits in `pending_messages`; when the model asks for no more
tools, the queue is drained into the same loop as a user message and answered by
the next response. A follow-up therefore never cuts into a tool sequence, and a
message sent while Zero is working does not have to wait for a fresh turn.
`followups_injected` records how many were taken and how long the oldest waited.

Trade-off of persisting as it goes: if an eviction lands between two replies
within one turn (reply 1 sent, reply 2 not), the retry resumes and only the
missing part is produced. Nothing about consolidation is lost either way — the
messages are in the durable log, and learning reads that log later.

A failed `send()` is a related case. It happens inside the runner's delivery
hook, not inside a tool, so it is not swallowed into a `tool_result` the model
would retry: it propagates out of the run to the orchestrator boundary below,
where `turn_failed` is logged and the user gets the fallback. The undelivered
message was already persisted (persist-before-send), so it stays in history
alongside the fallback — the same "partial turn" tradeoff, visible instead of
silent. Every Telegram failure is also logged at the transport
(`telegram_send_failed`) before it propagates.

The orchestrator is the turn's error boundary. If the agent path throws a genuine
agent failure, it logs `turn_failed`, sends the user a fallback message, and
persists that fallback as an assistant message so the thread stops awaiting
reply, then returns without rethrowing. This trades the DO alarm's blanket
auto-retry for guaranteed user feedback plus a logged error: a poison turn that
would loop on retry instead tells the user once and can be resent. The interface
agent applies the same no-silence rule when the model's tool loop hits the step
cap without a final answer (`finishReason !== "stop"`): it sends the fallback and
logs `turn_incomplete`.

One error class is exempt: a **DO isolate reset** (`isDurableObjectReset`, a new
Worker version deployed mid-turn). It is not an agent failure — the platform's
at-least-once alarm retry re-runs the turn on a fresh isolate. On a reset the
orchestrator sends nothing, persists nothing, logs `turn_reset_retrying`, and
rethrows so the uncaught throw leaves `alarm()` and triggers that retry. The log
already holds everything the dead run reached, and delivery claims say what got
out, so the retry resumes and the user's answer arrives exactly once — no
premature fallback and no repeated message. After this,
`turn_failed` means only a genuine agent failure.

## Execution (DO alarm)

The webhook resolves the user, calls `UserDO.enqueueTurn` (dedupe on
`processed_updates`, queue the user message in `pending_messages`, arm the
alarm), and returns 200. A queued message is not in the transcript yet: the turn
takes it, moving every queued message for that conversation to the transcript
tail in one transaction, in arrival order, so a burst becomes one turn and a
reset can neither lose a message nor inject it twice.

The alarm handler drains every conversation that still owes work and runs the
orchestrator for each, **and does nothing else**. An admin task and Google
onboarding used to share that one alarm slot; on 2026-07-29 they left a queued
user message waiting a quarter of an hour. Their deadlines live in ScheduleDO
now, which calls `UserDO.runQueuedAdminTask` / `runQueuedOnboarding` when due. "Owes work" is read from the protocol, not from the tail's
role: a conversation has work when messages are queued, when the tail is a user
message or a tool result awaiting a model response, or when the last assistant
response stopped for a non-terminal reason (`tool_use`, `pause_turn`, or none
recorded). An assistant response with a terminal stop reason and an empty queue
is idle. A concurrent enqueue arms a fresh alarm, so messages that
arrive mid-run are picked up on the next fire. A self-rescheduling `setTimeout`
re-sends the Telegram typing action every 4s across the interface phase
(including any research the user genuinely waits on) and stops the moment the
reply (or fallback) is sent (`orchestrator.ts` calls `stopTyping` right after the
interface phase, which is now the end of the turn). The DO alarm stays dedicated
to turn scheduling.

**An alarm invocation is killed at a 900-second wall-time ceiling**, reported by
Cloudflare as `outcome: exceededWallTime`. It is not an exception: no `catch` in
`runAlarmTurns` or `runTurn` ever sees it, nothing reaches ZeroErrors, and the
handler's own logs simply stop mid-turn. Because a DO runs one alarm at a time, a
stalled invocation also blocks the next one, so a message that arrives during it
waits out the full 900s before its own alarm is delivered. Observed 2026-07-29:
five consecutive invocations at ~900,000 ms wall against ~50 ms CPU (idle on an
unsettled promise, not computing), each stranding the user's next message for a
quarter of an hour.

Phase markers exist to localize such a stall, and are useful mainly by their
**absence**: `interface_completed` (once the agent loop returns),
`turn_completed` (orchestrator, once `runTurn` returns — including the handled
failure path, since it means "did not stall", not "succeeded"), and
`alarm_finished` (`do/alarm.ts`, with the turn count and duration). The same
rule covers the other two objects: `schedule_finished` for ScheduleDO, and
`learn_slice_completed` / `learn_completed` for LearningDO. A `turn_started`
with no `interface_completed` puts the stall in the agent loop; a
`turn_completed` with no `alarm_finished` puts it in the drain loop.
Read them alongside the Workers Logs `invocations` view, which carries the
authoritative `outcome`, `wallTimeMs` and `cpuTimeMs`.

If draining throws a **catchable** error (LLM gateway error, network abort),
`do/alarm.ts` self-reschedules the alarm with exponential backoff — but only
while `findConversationsWithWork()` still returns work. Once every conversation
has an empty queue and a finished assistant response it stops, which is the
circuit breaker against a runaway paid alarm loop. It catches and returns rather than rethrowing: rethrowing would break
the DO output gate and discard the reschedule write, falling back to CF's
built-in retry (capped at 6). Backoff grows from a storage-backed attempt counter
(`alarmAttempts`), not `alarmInfo.retryCount`, which resets on the catch-return
path. This does **not** cover a DO isolate reset ("code was updated"): that tears
the isolate down before the catch runs, so it relies on CF's built-in
at-least-once retry plus the next user message re-arming the alarm.

## Storage seam

The orchestrator and agents depend on the `Store` port (`store/types.ts`), not on
do-orm. Two adapters implement it: `DbStore` (do-orm over DO SQLite, production)
and `MemoryStore` (in-memory, tests). The shared contract test
(`store/store-contract.test.ts`) keeps the two in sync, which is what makes the
agent and orchestrator unit tests (MemoryStore + a scripted mock model)
trustworthy.

## LLM access

Both agents get their model from `agents/model.ts`, the only module that
touches the official `@anthropic-ai/sdk`. It builds a client pointed at the
Cloudflare AI Gateway
(`cf-aig-authorization` for the gateway, `cf-aig-metadata` for per-user
attribution). BYOK Anthropic billing and per-user spend limits live in the
gateway; the gateway also logs per-request tokens and USD cost per user.
