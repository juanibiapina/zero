# Topic model and the two-phase meta-agent

Zero handles each Telegram turn with two stateless agents that run inside the
per-user `UserDO` Durable Object. Between turns, the only durable state is the
SQLite in the DO: topics, conversations, and messages. There is no container and
no per-user filesystem.

## Topics

A **topic** is a living knowledge document about a subject (a project, a person,
an ongoing thread). Columns (see `apps/api/src/UserDO/db/schema.ts`):

- `name` — human label the agent addresses (unique). A surrogate integer `id` is
  the internal key, so a rename is a one-field `name` update.
- `description` — short routing blurb: what belongs in this topic.
- `summary` — running state-of-the-topic.
- `body` — the knowledge document (markdown).
- `createdAt`, `lastActiveAt`, `messageCount` — activity tracking.

Topics are the agent's long-term memory. They are addressed by name through the
tools below; the interface agent discovers them itself (no separate routing
pass).

## Two-phase turn

1. **Interface agent** (`agents/interface.ts`, stateless per turn). Given the new
   user message plus recent history, it runs a tool loop and sends replies as it
   works. Tools (`tools/topics.ts`):
   - `reply(text)` — send a message to the user immediately. The agent is
     prompted to acknowledge first, then answer, so the user sees live progress.
     As a safety net, on a clean finish the model's final message is always
     delivered (unless empty, or an exact echo of the reply just sent). The
     model routinely puts the substantive answer in its final text rather than a
     `reply()` call — notably after a `research` tool call that followed an
     acknowledgement reply — so suppressing that text whenever any earlier reply
     (even a bare "Searching now..." ack) had gone out silently dropped the real
     answer. Delivering the final message keeps ack-then-answer intact; the echo
     guard prevents re-sending text already delivered.
   - `list_topics`, `get_topic`, `create_topic`, `update_topic` — read/write the
     knowledge model. Every topic touched is added to an `accessed` set.
2. **Writer agent** (`agents/writer.ts`, stateless per turn). The interface
   agent's twin: the same `runAgent` machine with the same topic tools
   (`buildTopicTools`: `list_topics`/`get_topic`/`create_topic`/`update_topic`),
   minus `reply`/`research`. Its only extra input is the list of topic names the
   interface agent accessed this turn. For each accessed topic that gained
   durable information it reads the body (`get_topic`), merges new facts under
   sensible sections, appends one `## Log` line, and writes back via
   `update_topic`, refreshing summary and description. It never rewrites or
   compacts a body. Because it has `list_topics` + `create_topic`, it is also
   proactive: it creates a topic for any durable subject in the exchange with no
   existing topic. Trivial exchanges (chit-chat, acks) get no tool call.

A third agent also writes topics: the **research agent** (spawned by the
interface agent's `research` tool; see `docs/research.md`). It has the topic
tools + `web_search` and writes its findings directly into a topic (new or
updated), which is what keeps source references verbatim — the producer stores
them, with no lossy interface/writer hop between production and persistence. The
topics it writes are merged into the interface agent's `accessed` set, so the
writer consolidates them like any other accessed topic. The writer is prompted
to **preserve research findings and their reference URLs verbatim** (refresh the
summary rather than rewriting the body, and fold near-duplicate research topics
together). Preservation is prompt-enforced; if it degrades in practice, the
stronger fix is a mechanically protected body region or excluding research
topics from the writer.

The topic tools are shared: `update_topic` is a partial patch — provide only the
fields to change (`body`, `description`, `summary`, `newName`); omitted fields
keep their current value. The interface agent's usual body-only revision leaves
summary/description untouched; the writer uses the full patch and rename. All
writes go through `store.saveTopic`.

The `TurnOrchestrator` (`agents/orchestrator.ts`) is the runtime-agnostic glue:
load history, run the interface agent, then run the writer. It knows nothing
about alarms, DOs, or Telegram. The writer runs **every** turn (not only when a
topic was accessed) so proactive creation is possible on turns that introduce a
brand-new subject; it is given the accessed-topic names, not pre-loaded bodies,
and fetches bodies itself via `get_topic`. There is no longer a mechanical
log-append fallback: the `## Log` line is a prompt-driven `update_topic` write,
so a turn the writer judges trivial leaves the model untouched.

Replies are persisted **as they are sent**, not after the turn. The `reply` tool
(and both no-silence fallbacks) persist the assistant message before calling
`send()`. Behind the DO output gate the durable row commits before the Telegram
fetch leaves, so a mid-run eviction leaves the thread tail already `assistant`
and the retry skips it — no duplicate Telegram messages. Trade-off: if an
eviction lands between two replies within one turn (reply 1 persisted, reply 2
not yet sent), the retry skips the thread and reply 2 is lost. This converts a
rare "duplicate message" into a rare "partial turn," which is preferred. On such
a skipped retry the writer consolidation for that turn also does not re-run; live
topic create/update calls already persisted the durable facts, only the writer's
Log-line/summary refresh is lost for that one turn.

A `reply` whose `send()` fails is a related case. The AI SDK swallows a thrown
tool `execute` (it becomes a tool-error fed back to the model, not a rejected
`generateText`), so the interface agent captures the first send failure and
re-raises it after the tool loop. That routes to the orchestrator boundary
below: `turn_failed` is logged and the user gets the fallback. The undelivered
reply row was already persisted (persist-before-send), so it stays in history
alongside the fallback — the same "partial turn" tradeoff, now visible instead
of silent. Every Telegram failure is also logged at the transport
(`telegram_send_failed`) before it propagates.

The orchestrator is the turn's error boundary. If the agent path throws, it logs
`turn_failed`, sends the user a fallback message, and persists that fallback as
an assistant message so the thread stops awaiting reply, then returns without
rethrowing. This trades the DO alarm's blanket auto-retry for guaranteed user
feedback plus a logged error: a poison turn that would loop on retry instead
tells the user once and can be resent. The interface agent applies the same
no-silence rule when the model's tool loop hits the step cap without a final
answer (`finishReason !== "stop"`): it sends the fallback and logs
`turn_incomplete`.

## Execution (DO alarm)

The webhook resolves the user, calls `UserDO.enqueueTurn` (dedupe on
`processed_updates`, store the user message, arm the alarm), and returns 200. The
alarm handler drains every thread whose tail is a user message and runs the
orchestrator for each. A concurrent enqueue arms a fresh alarm, so messages that
arrive mid-run are picked up on the next fire. A self-rescheduling `setTimeout`
re-sends the Telegram typing action every 4s while a turn runs; the DO alarm
stays dedicated to turn scheduling.

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

Both agents get their model from `agents/model.ts`, which builds an
`@ai-sdk/anthropic` provider pointed at the Cloudflare AI Gateway
(`cf-aig-authorization` for the gateway, `cf-aig-metadata` for per-user
attribution). BYOK Anthropic billing and per-user spend limits live in the
gateway; the gateway also logs per-request tokens and USD cost per user.
