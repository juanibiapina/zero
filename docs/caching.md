# Prompt caching

Zero caches the stable prefix of every LLM call so the provider bills it at a
fraction of the input price on reads, instead of re-billing the full system
prompt, tool schemas, and history on every tool-loop step and every turn.

**Caching is managed by Pi Durable and pi-ai, not hand-marked by Zero.** Two
request options decide it:

- **`sessionId`**: each Pi conversation has its own persisted UUID (the
  `pi.provider` document), forwarded to pi-ai as `sessionId`. On OpenAI
  Responses it becomes `prompt_cache_key`, so every request of one chat routes
  to the same cache. It survives restarts, retries, compaction and `/new`.
- **`cacheRetention: "long"`** (Zero's `settings.stream`, see
  `assistant/harness.ts`) → OpenAI `prompt_cache_retention: "24h"` (and, on the
  Anthropic wire, `cache_control.ttl: "1h"`).

`gpt-6-luna` uses **implicit** prompt caching: pi-ai sends no explicit cache
mode and places no per-block `cache_control` breakpoints.

## What keeps the prefix stable

- **History is the model's own transcript.** Pi stores each response and tool
  result verbatim and sends them back unchanged, so turn N's request is a byte
  prefix of turn N+1's.
- **The volatile line rides on the newest message.** The current time,
  timezone and country are prepended to the newest user message of each request
  only (`beforeRequest` in `assistant/harness.ts`); user messages carry their
  timestamp from the moment they were composed.
- **System prompt changes are positional.** Pi renders the system prompt from
  the selected extension's sections (static instructions, then pinned topics)
  before each request and records a change as a `pi.system` entry where it
  happened. On models that support mid-conversation system changes only the
  change is sent, so a pinned-topic edit does not invalidate the history before
  it.
- **Tool schemas are the same for every user.** The file, schedule and mail
  tools are registered unconditionally, and descriptions carry no user values.

Staleness stubs and compaction rewrite older content, so a turn that stubs a
stale topic read, or the first turn after a compaction, writes a new prefix.

## Reading cache tokens

Every model response writes one point to the `AI_USAGE` Analytics Engine
dataset with `input` (full-price), `cacheRead`, `cacheWrite` (5m and 1h) and
output tokens, attributed to the agent and the conversation. The AI Gateway
logs carry the same per request, split by the `agent` field of
`cf-aig-metadata`.

## Production validation

Prompt caching cannot be validated in unit or e2e tests: the mocks implement no
real cache. Validate in production with the AI Gateway logs and the `AI_USAGE`
dataset:

- **Within one run:** a multi-step turn (a search, a calendar lookup). Pass: the
  first request writes the cache; later requests read roughly the prefix size
  with small full-price `input`.
- **Across turns:** the next turn in the same chat reads the prefix on its first
  request.
