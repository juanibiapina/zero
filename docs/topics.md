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
the writer keep topics small and granular and connect related subjects (a person
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
consolidated by the writer like any other. The canonical use is a stable
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
writer prompt also tells it not to edit `Zero`/`Changelog`, to avoid a wasted,
always-rejected call. Updating a system topic is a source edit plus deploy (edit
the `Zero` body or `apps/agent-api/CHANGELOG.md`); every user picks up the new content with no
migration and no per-user seeding.

## Two-phase turn

1. **Interface agent** (`agents/interface.ts`, stateless per turn). Given the new
   user message plus recent history, it runs a tool loop and sends replies as it
   works. The history is assembled as a real multi-turn conversation
   (`buildConversationMessages`), not a single flattened prompt: each stored
   user/assistant message becomes a native turn (user turns prefixed with an
   absolute `[YYYY-MM-DD HH:MM]` timestamp, assistant turns verbatim), leading
   assistant messages are dropped, and consecutive same-role turns are coalesced.
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
     the shared `buildTopicTools`, so the writer/research agents cannot delete),
     and the prompt gates it on explicit user confirmation. Deleting a topic
     drops its own outbound link rows; inbound links from other bodies keep
     their `[[Name]]` text and become dangling, re-resolving if a topic of that
     name is recreated. Bodies of other topics are left untouched.
2. **Writer agent** (`agents/writer.ts`, stateless per turn). The interface
   agent's twin: the same `runAgent` machine with the same topic tools
   (`buildTopicTools`: `list_topics`/`get_topic`/`create_topic`/`edit_topic`/`append_topic`/`update_topic_metadata`/`list_backlinks`),
   minus `research`. Its inputs are the **turn transcript** and the list
   of topic names the interface agent accessed this turn. The transcript is a
   serialization of the interface run: the user message, every tool call and its
   (truncated) result, and assistant replies. This matters because durable facts
   often live in tool results (calendar events, email bodies, research), not in
   the user-facing replies, which are lossy. The interface agent builds it from
   the run's generated messages (`renderTranscript`), capping each tool result
   so a large payload cannot blow up the writer's input. The cap is per-tool:
   non-research tools are clipped at ~1.5 KB (1,500 chars), but a `research`
   result gets a generous 8,000-char ceiling because a research report is the
   payload the writer must persist verbatim (every claim and its `Source:` URL),
   not context it samples from. The tradeoff is higher writer token cost and
   latency, bounded by those caps. (The 8,000-char research ceiling is
   code-verified in `interface.ts`; it has not yet been exercised on a real turn
   (see `docs/research.md`).) For each
   accessed topic that gained durable information it reads the body
   (`get_topic`), merges new facts under sensible sections with `edit_topic`,
   appends one `## Log` line with `append_topic`, and uses `update_topic` only to
   refresh the description (or to rename, or to fill a topic it just
   created empty). It never rewrites or compacts a body — and since 2026-07-29
   the tools enforce that rather than only the prompt asking for it. Because it
   has `list_topics` +
   `create_topic`, it is also proactive: it creates a topic for any durable
   subject in the turn with no existing topic. The prompt biases it toward
   recording generously (people, projects, events, trips, gear, house/utilities,
   goals, and any other recurring subject; the list is illustrative). Only
   genuinely trivial turns (pure chit-chat or acks with no durable fact) get no
   tool call.

A third agent gathers material for topics: the **research agent** (spawned by
the interface agent's `research` tool; see `docs/research.md`). It has read-only
topic tools + `web_search` + `read_page` and **no write tools**; it returns a
compact sourced findings report as its tool result rather than writing topics
itself. The writer then persists those findings — it sees the research report in
the turn transcript, and any topic research **read** for context is merged into
the interface agent's `accessed` set so the writer consolidates it like any
other accessed topic. The writer is prompted to **preserve research findings and
their reference URLs verbatim** (fold near-duplicate research topics together
rather than rewriting a body). Preservation is
prompt-enforced; if it degrades in practice, the stronger fix is a mechanically
protected body region.

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
2026-07-29 the writer reached 13,856 output tokens in a single 298s generation,
took 76% of the day's LLM time and 69% of its spend, and the wall time landed on
the *next* message, since turns drain serially per DO. Anchored edits make a
write cost the change. See `docs/plans/writer-latency-investigation.md` for the
measurements. The writer prompt also asks it to split a subject into a new linked
topic once a body passes roughly 8,000 characters, so bodies stop growing without
limit in the first place.

The `TurnOrchestrator` (`agents/orchestrator.ts`) is the runtime-agnostic glue:
load history, run the interface agent, then run the writer. It knows nothing
about alarms, DOs, or Telegram. The writer runs **every** turn (not only when a
topic was accessed) so proactive creation is possible on turns that introduce a
brand-new subject; it is given the turn transcript and the accessed-topic names,
not pre-loaded bodies, and fetches bodies itself via `get_topic`. There is no longer a mechanical
log-append fallback: the `## Log` line is a prompt-driven `append_topic` write,
so a turn the writer judges trivial leaves the model untouched.

Messages are persisted **as they are sent**, not after the turn. Every text
block (and the no-silence fallback) is persisted before `send()` is called. Behind the DO output gate the durable row commits before the Telegram
fetch leaves, so a mid-run eviction leaves the thread tail already `assistant`
and the retry skips it — no duplicate Telegram messages. Trade-off: if an
eviction lands between two replies within one turn (reply 1 persisted, reply 2
not yet sent), the retry skips the thread and reply 2 is lost. This converts a
rare "duplicate message" into a rare "partial turn," which is preferred. On such
a skipped retry the writer consolidation for that turn also does not re-run; live
topic create/update calls already persisted the durable facts, only the writer's
Log-line refresh is lost for that one turn.

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
rethrows so the uncaught throw leaves `alarm()` and triggers that retry. Since
the reply path is persist-before-send, the tail stays `user` and the retry
delivers the real answer exactly once — no premature fallback. After this,
`turn_failed` means only a genuine agent failure.

## Execution (DO alarm)

The webhook resolves the user, calls `UserDO.enqueueTurn` (dedupe on
`processed_updates`, store the user message, arm the alarm), and returns 200. The
alarm handler drains every thread whose tail is a user message and runs the
orchestrator for each. A concurrent enqueue arms a fresh alarm, so messages that
arrive mid-run are picked up on the next fire. A self-rescheduling `setTimeout`
re-sends the Telegram typing action every 4s across the interface phase
(including any research the user genuinely waits on) and stops the moment the
reply (or fallback) is sent, before the writer's consolidation runs, since the
writer is internal topic bookkeeping the user is not waiting on
(`orchestrator.ts` calls `stopTyping` after the interface phase). The DO alarm
stays dedicated to turn scheduling.

**An alarm invocation is killed at a 900-second wall-time ceiling**, reported by
Cloudflare as `outcome: exceededWallTime`. It is not an exception: no `catch` in
`runAlarmTurns` or `runTurn` ever sees it, nothing reaches ZeroErrors, and the
handler's own logs simply stop mid-turn. Because a DO runs one alarm at a time, a
stalled invocation also blocks the next one, so a message that arrives during it
waits out the full 900s before its own alarm is delivered. Observed 2026-07-29:
five consecutive invocations at ~900,000 ms wall against ~50 ms CPU (idle on an
unsettled promise, not computing), each stranding the user's next message for a
quarter of an hour.

Three phase markers exist to localize such a stall, and are useful mainly by
their **absence**: `writer_started` (orchestrator, before the writer runs),
`turn_completed` (orchestrator, once `runTurn` returns — including the handled
failure path, since it means "did not stall", not "succeeded"), and
`alarm_finished` (`do/alarm.ts`, with the turn count and duration). A
`writer_started` with no `writer_completed` puts the stall in the writer's tool
loop; a `turn_completed` with no `alarm_finished` puts it in the drain loop.
Read them alongside the Workers Logs `invocations` view, which carries the
authoritative `outcome`, `wallTimeMs` and `cpuTimeMs`.

If draining throws a **catchable** error (LLM gateway error, network abort),
`do/alarm.ts` self-reschedules the alarm with exponential backoff — but only
while `findThreadsAwaitingReply()` still returns work. Once every thread's tail
is `assistant` it stops, which is the circuit breaker against a runaway paid
alarm loop. It catches and returns rather than rethrowing: rethrowing would break
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
