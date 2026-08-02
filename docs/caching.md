# Prompt caching

Zero caches the stable prefix of every LLM call so the provider bills it at a
fraction of the input price on reads, instead of re-billing the full system
prompt, tool schemas, and history on every tool-loop step and every turn. This
doc explains the three reuse tiers, the breakpoint layout, and the production
playbook that validates each tier.

A misplaced breakpoint is silent: the request still succeeds, you just pay full
price. So caching is only "done" once production telemetry shows the expected
reads for each tier (see [Production validation](#production-validation)).

Zero runs on `gpt-5.6-luna` (OpenAI Responses API) since 2026-08-02. Everything
below describes that API. Sections dated before then were measured on
`claude-sonnet-4-6` and are kept as history, marked where they are no longer
literally true.

## How prompt caching works here

- **Prefix-based.** A cached entry is a prompt prefix ending at a **breakpoint**.
  A later request sharing the byte-identical prefix up to that marker reads it
  from cache. Any change earlier in the prefix invalidates everything after it.
- **Cache order is `tools` -> `instructions`/system -> `input`.** Volatile
  content early in that order kills caching of everything after it.
- **Breakpoints are explicit.** Zero sends `prompt_cache_options: { mode:
  "explicit" }`, which disables the implicit breakpoint the service would
  otherwise place on the latest message, and marks its own with
  `prompt_cache_breakpoint: { mode: "explicit" }`. Implicit mode would pay a
  cache write on the volatile tail of every single step, for bytes no later
  request can reuse.
- **Only an input block can carry a breakpoint** — `input_text`, `input_image`,
  `input_file`. Never a tool definition, an assistant message, a function call,
  or a reasoning item. This is why tools carry no marker (the system block's
  breakpoint covers the tool schemas rendered before it) and why the cross-turn
  anchor walks back past the previous assistant reply onto the last user message
  (`anchorIndex` in `agents/interface.ts`, `markCacheBreakpoint` in
  `agents/cache.ts`).
- **Budget: 4 cache writes per request.** Breakpoints from earlier turns are
  read-only — they can match, but the request does not rewrite them. Up to the
  latest 50 breakpoints in a conversation are considered for reads, and the
  service reads from the longest matching prefix.
- **TTL is a single 30m minimum**, set request-wide. There is no per-breakpoint
  TTL choice, so the `"1h"` argument Zero still passes through `cachedSystem` is
  inert on this provider (it survives so a rollback to Anthropic keeps its 1h
  head).
- **Routing needs `prompt_cache_key`.** It is combined with the prefix hash to
  route a request to a machine that may hold the entry, and it is required for
  the reliable matching path. Zero sends `zero:<agent>:v1:<shard>` (see
  `promptCacheKey` in `agents/model-openai.ts`): shared across users so the
  cross-user prefix is reusable, namespaced per agent, versioned so a prompt
  change cannot land on a stale route, and sharded because the provider asks for
  roughly <=15 requests/minute per key. Raise `SHARDS` when traffic grows.
- **Min cacheable length:** 1024 tokens. Shorter prefixes silently no-op, which
  is why a toy probe shows zero reads and proves nothing.
- **Scope:** keyed on the provider account. Zero runs one BYOK key through one
  gateway, so an identical prefix is **shared across all users**. Per-user
  attribution lives in `cf-aig-metadata` headers, which are not part of the
  request body, so cross-user prefix sharing is intact.

Cache writes cost 1.25x the uncached input rate; reads cost 0.1x. A net win
requires reuse. Keep the AI Gateway's own **response caching off** — our requests
are never byte-identical (history grows, tools run), and stale full responses
would be wrong. Prompt caching is the right layer.

## The three reuse tiers

1. **Within one run (tool loop).** System, tools, and the initial messages are
   fixed across the loop's steps; only assistant/tool messages append. Every step
   after the first reads the prefix from cache. Biggest win on tool-heavy turns
   (research, calendar).
2. **Across users.** `tools` + the static head of every agent's `system` are
   byte-identical for all users, so high traffic keeps this shared prefix warm
   and nearly every call reads it.
3. **Across turns for one user.** Conversation history is an append-only,
   byte-stable prefix: user messages carry absolute timestamps (never
   recomputed) and assistant text is verbatim, so turn N's history is a prefix of
   turn N+1's. A breakpoint at the end of history caches the whole conversation
   across turns, within TTL.

## The stable-head / volatile-tail rule

The interface prompt used to embed volatile values (current time, timezone,
pinned topics) inside the system text. Because `system` precedes `messages`, the
per-minute time alone invalidated the history cache every turn, and the timezone
blocked cross-user sharing. So we split stable from volatile:

- **Static system head (cached, cross-user):** instructions only, generic
  wording. It refers to the current time and timezone as "given with the latest
  user message" rather than embedding them. See `interfaceSystemPrompt` in
  `agents/prompts.ts`.
- **Pinned topics** are per-user, so they are a **separate block** after the
  static instructions, carrying their own breakpoint (`systemTail` in
  `runAgent`, built by `cachedSystem`). The cross-user share is the instructions
  block; a change to one user's pins re-bills only the pinned block, never the
  shared head. Freeing tools from a breakpoint is what paid for this: the budget
  is still four.
- **Volatile tail (uncached):** the datetime anchor, timezone and the user's
  country code with its country name (`interfaceContext` in `prompts.ts`) are
  prepended to the **current** user message, so they sit after the cached
  history prefix and never invalidate it. The country is stated as "not set"
  when unknown, which is also volatile text and costs the cache nothing.

## The 4-breakpoint layout (interface agent)

In cache order:

1. **Static system head** — instructions only, byte-identical across users, and
   its breakpoint also covers every tool schema (tools are rendered before it and
   cannot carry a marker of their own). Emitted by `cachedSystem` in `runAgent`.
2. **Per-user system tail** — the pinned topics. Per-user, stable across turns
   while the pins do not change.
3. **Cross-turn anchor: last stable history message** — the last message before
   the current one that can carry a marker, which in a normal turn is the
   previous **user** message (the assistant reply in between cannot carry one).
   It is byte-identical next turn, so this is the write that produces the
   cross-turn history read. Set by `interface.ts`; omitted when history is empty.
4. **Loop-owned sliding tail** — owned by `runAgent`, not the caller: before
   every step it marks the tail of a per-request snapshot
   (`slideMessageBreakpoint` in `cache.ts`), advancing to the new tail as the
   tool loop appends steps, and walking back if the tail is an assistant message
   (a resumed run). Step N therefore reads everything through step N-1 and writes
   only the delta. The persisted messages are never mutated, so no breakpoints
   accumulate.

Breakpoints 3 and 4 form a **sliding window**. The cross-turn win requires a
write at a byte-stable end-of-history boundary. A single breakpoint on the
current message does not do this: that block carries the volatile context and
mutates every turn (the anchor is stripped when the message becomes history), so
it is never re-read. The stable-message anchor is what yields the cross-turn
read; the loop's sliding tail keeps the newest turn (and every appended tool
step) warm for the within-run loop.

Measured on Anthropic in 2026-07, and the reason the layout is shaped this way
(the mechanism is prefix matching on both providers):

- Breakpoint **on the volatile current message**: turn 1 write=1613 read=0; turn
  2 write=4823 read=0. Zero cross-turn reuse.
- Breakpoint **on the last stable block** (this layout): turn 1 write=1611
  read=0; turn 2 write=10 read=1611. Full cross-turn hit.

The research, learning, and onboarding agents run the same `runAgent` machine, so
they get tiers 1-2 (cached system + tools) for free. They use the single-`prompt`
path with no caller anchor and no system tail, but the loop's sliding tail
breakpoint caches their growing message region too: on a multi-step research turn
each step reads the accumulated context from cache and writes only its delta.

## Cache statistics

`agents/model-openai.ts` logs a content-free `cache_stats` line per model call:
`agent`, `step` (the zero-based loop index), `input_tokens` (uncached,
full-price), `cache_read_tokens`, `cache_write_tokens`, and `thinking_tokens`
(reasoning spend, which is inside `output_tokens` and invisible otherwise).

Read it per agent per step. On a working message-region cache,
`cache_read_tokens` grows step over step within a run while `input_tokens` stays
small; the broken case is a large constant `input_tokens` with a tiny constant
read.

Note that the API's reported `input_tokens` **includes** the cached tokens. Zero
subtracts them (`toUsage` in `agents/openai-wire.ts`) so `input_tokens` in the
log and in cost accounting means what it says: the part billed at full price.

There is no divergence diagnostic on this API. The Anthropic-only
`cache_diagnostic` line (which reported *how* a request's prefix differed from a
named earlier response) was removed with the provider switch, along with the
`previous_message_id` chain it needed. The provider's response id is still
persisted on each assistant row (`messages.responseId`) for tracing a turn back
to a provider log line.

## Cross-user sharing invariant

Nothing per-user may appear in `tools` or the static `system`, or tier 2 breaks
silently. Concretely:

- The file tools (`get_file`, `list_files`, `view_image`, the legacy
  `view_attachment` alias, `read_pdf`, `send_file`, and `delete_file`) are
  registered **unconditionally** so their schemas are byte-identical across
  users.
- Tool descriptions/schemas carry no user values (the Google calendar tools close
  over `timezone` only in their `execute` bodies, not descriptions).

## Reading cache tokens from logs

`runAgent` returns `usage` (whole-run aggregate) and `stepUsages` (per step).
Each agent's completion log carries token fields via `usageLogFields`:

- `interface_completed`, `research_completed`, `learn_slice_completed`,
  `onboarding_completed`: `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_write_tokens`, and a derived `cache_hit_ratio` =
  `cache_read / (cache_read + cache_write + input)`.
- `interface_step_usage` (multi-step turns only): per-step `cache_read`,
  `cache_write`, `input` arrays, exposing the tier-1 write-then-read pattern the
  aggregate hides.

`result.usage` is the sum across every tool-loop step, so on a multi-step turn the
read term counts the prefix once per step; read `cache_hit_ratio` as a turn-level
signal and use `interface_step_usage` for the within-run check.

## Production validation

Prompt caching cannot be validated in unit or e2e tests: the mocks implement no
real cache. Validation happens in production by reading the logged cache-token
fields. The API returns aggregate read/write for the whole request (not
per-breakpoint), so each tier is validated by a scenario where only that tier's
segment can be warm.

Read `cache_stats` and the `*_completed` lines in Workers Logs (the dashboard's
Observability tab, or the telemetry query in the root `AGENTS.md`) and look at
`cache_read_tokens` / `cache_write_tokens`. Cross-check against the AI Gateway
logs, which break tokens and cost down by the `agent` metadata tag.

### Tier 1 — within one run

- **Scenario:** a multi-step turn (a message that fires `research` or a calendar
  lookup).
- **Pass:** the first step logs `cache_write_tokens > 0`; later steps
  (`interface_step_usage`, or the per-step `cache_stats` lines) log
  `cache_read_tokens` on the order of the system+tools token count.

### Tier 2 — across users

- **Scenario:** with the static head warm from any traffic, a **different** user
  sends their **first** message of the day.
- **Pass:** that first turn logs `cache_read_tokens` ~ the static-head token
  count even though the user's own history/pinned segments are cold. Zero means a
  per-user byte polluted the shared prefix.

### Tier 3 — across turns

- **Scenario:** one user sends a message, waits under the 30-min TTL, sends a
  second.
- **Pass:** the second turn's first step logs `cache_read_tokens` covering system
  + tools + the full prior history (much larger than the static head), with only
  the new tail written; it grows turn over turn. A message after the TTL expires
  shows the history segment written again (expected expiry).

**Confirmed on OpenAI (2026-08-02, version `dd9afd0c`, first production hours):**
an interface run's step 1 logged `cache_read_tokens: 6088` against
`input_tokens: 1628`, i.e. the system head, tools, pinned tail, and history
prefix all served from cache with only the new tail billed at full price. The
explicit-breakpoint layout works as designed on this provider.

### Regression guard

Watch that full-price `input_tokens` drops for tool-heavy and long-conversation
turns versus the pre-deploy baseline, and that `cache_write_tokens` is not
dominating (which would mean prefixes are churning, i.e. a breakpoint is
misplaced). Record observed before/after numbers below so a future prompt or tool
change that silently breaks a breakpoint is caught.

## Recorded baselines

**Every baseline below was measured on `claude-sonnet-4-6`**, before the
2026-08-02 switch to `gpt-5.6-luna`. They are kept because they establish the
layout's mechanism and the shapes to expect, not because the absolute numbers
still hold: prompts render differently per provider, so every prefix size moved.

**They also predate adaptive thinking** (enabled for every agent on
2026-08-01). Two things changed with it, so do not compare across that line
without accounting for them:

- The first request after that deploy misses every prefix, because the thinking
  configuration is part of the rendered prompt. A one-off write spike is
  expected; a persistent one is not.
- Retained thinking from earlier assistant turns is billed as input on every
  later request in the conversation, so input and cache-read totals rise even
  when nothing else changed.

Measured in production (`claude-sonnet-4-6`, version `f0ed8d06`).

### Tier 1 — within one run (2026-07-21) — PASS

A single "research X" message drove a multi-step turn. Per-step and per-agent
cache tokens showed the write-then-read pattern on every agent:

| agent | steps | write | read | notes |
| --- | --- | --- | --- | --- |
| interface | 2 | 6037 (step 1) | 6037 (step 2) | full system+tools+history prefix read on step 2 |
| research | 14 | 1460 | 18980 | ~1460-token system+tools prefix written once, read back ~13x across the search loop |
| writer | multi | 1626 | 6504 | same pattern |

`interface_step_usage`: `cache_write=[6037, 0]`, `cache_read=[0, 6037]`.

### Tier 3 — across turns (2026-07-21) — PASS

Two single-step reply turns from one user, seconds apart:

| turn | agent | steps | read | write | input |
| --- | --- | --- | --- | --- | --- |
| 2 | interface | 1 | 4015 | 2090 | 6108 |
| 3 | interface | 1 | 4015 | 1751 | 5769 |

A 4015-token read on a turn's **first (only) step** can only come from a prior
turn's write: system + tools + the stable history prefix served from cache, with
only the new ~1.7-2k tail written. Cross-turn caching confirmed.

### Writer cross-turn head — PASS

The writer is single-prompt (its prompt body — the turn transcript — is unique
every turn, so it never caches cross-turn), but its static system+tools head
(1h TTL) is cached across turns:

| turn | read | write | input |
| --- | --- | --- | --- |
| 1 (big consolidation, multi-step) | 6504 | 1626 | 62447 |
| 2 | 1626 | 0 | 2064 |
| 3 | 1626 | 0 | 2051 |

The head was measured at 1626 tokens; turns 2-3 read all 1626 with **write=0** — reused from an
earlier turn's write, not rewritten. This also demonstrates the shared-head reuse
mechanism that tier 2 relies on.

**2026-07-28 correction:** 1,626 is a pre-SDK-wire baseline, not the current
writer-head size. A version-matched probe measured 1,952 tokens; see
`docs/plans/writer-cache-prefix-verify.md`.

### Tier 2 — across users — _tbd_

Direct check still needs a *different* user's first turn to read the shared
`tools` + static `system` head. Strong indirect evidence already: the writer head
reads with `write=0` across separate requests (see above), and the interface
first-step reads (tier 3) include the same shared head. Watch organic
cross-user traffic to confirm directly.
