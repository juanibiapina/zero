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
   - `reply(text)` — send a message to the user immediately. Every message the
     user sees must go through `reply()`; the agent is prompted to acknowledge
     first, then answer, so the user sees live progress.
   - `list_topics`, `get_topic`, `create_topic`, `update_topic` — read/write the
     knowledge model. Every topic touched is added to an `accessed` set.
2. **Writer agent** (`agents/writer.ts`, stateless per turn). Given the accessed
   topics and the exchange, it consolidates durable knowledge via a single
   `save_topic` tool: merge new facts into the body, append one `## Log` line,
   and refresh description + summary. It never rewrites or compacts a body. A
   fallback appends a log line to any accessed topic the model skipped, so no
   exchange is silently dropped.

The `TurnOrchestrator` (`agents/orchestrator.ts`) is the runtime-agnostic glue:
load history, run the interface agent, persist replies, then run the writer over
the accessed topics. It knows nothing about alarms, DOs, or Telegram.

## Execution (DO alarm)

The webhook resolves the user, calls `UserDO.enqueueTurn` (dedupe on
`processed_updates`, store the user message, arm the alarm), and returns 200. The
alarm handler drains every thread whose tail is a user message and runs the
orchestrator for each. A concurrent enqueue arms a fresh alarm, so messages that
arrive mid-run are picked up on the next fire. A self-rescheduling `setTimeout`
re-sends the Telegram typing action every 4s while a turn runs; the DO alarm
stays dedicated to turn scheduling.

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
