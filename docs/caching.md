# Prompt caching

Zero caches the stable prefix of every LLM call so the provider bills it at a
fraction of the input price on reads, instead of re-billing the full system
prompt, tool schemas, and history on every tool-loop step and every turn. This
doc explains the three reuse tiers, the breakpoint layout, and the production
playbook that validates each tier.

A misplaced breakpoint is silent: the request still succeeds, you just pay full
price. So caching is only "done" once production telemetry shows the expected
reads for each tier (see [Production validation](#production-validation)).

Zero runs on `gpt-5.6-luna` (OpenAI Responses API) since 2026-08-02, and
everything below was measured on that API. Anthropic's rules differ in two ways
that matter (a hard cap of 4 marked blocks per request, and a TTL per
breakpoint); both live in `agents/model-anthropic.ts` so no shared code carries
them.

Prices on this model family: reads 0.1x the uncached input rate, **writes
1.25x**. Writes were free before GPT-5.6, so pre-5.6 habits are actively
expensive here — an unread write costs more than not caching at all. The AI
Gateway's own `cost` column still bills Luna at its launch price and reads ~5x
too high; `agents/ai-usage.ts` holds the current prices and is authoritative.

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
  breakpoint covers the tool schemas rendered before it) and why an assistant
  message is skipped by `markCacheBreakpoint` in `agents/cache.ts`.
- **A marker is part of the cached bytes.** A prefix written while a block
  carried a marker does not match a later request where that block has none.
  Marks therefore only ever accumulate; removing one invalidates everything
  after it. This is the single most expensive thing to get wrong here, and it is
  why the marking rule is a pure function of the message array.
- **Marker count is not a budget; writes are.** A request may carry any number of
  breakpoints. The service writes at most the **latest four** and treats the rest
  as read-only (they match, they are not re-written), and it considers up to the
  latest 50-80 of them for reads, reading from the longest matching prefix. There
  is no content-block lookback limit.
- **TTL is a single 30m minimum**, set request-wide, and 30m is the only
  supported value. Nothing in the shared cache policy passes a TTL. Anthropic
  takes one per breakpoint, so `agents/model-anthropic.ts` applies its own (1h on
  the system region, the 5m default on messages) on the way out.
- **Routing needs `prompt_cache_key`.** It is combined with the prefix hash to
  route a request to a machine that may hold the entry, and it is required for
  the reliable matching path. Zero sends `zero:<agent>:v1:<shard>` (see
  `promptCacheKey` in `agents/model-openai.ts`): shared across users so the
  cross-user prefix is reusable, namespaced per agent, versioned so a prompt
  change cannot land on a stale route, and sharded because the provider asks for
  roughly <=15 requests/minute per key. Raise `SHARDS` when traffic grows.
- **Min cacheable length:** 1024 tokens. Shorter prefixes silently no-op, which
  is why a toy probe shows zero reads and proves nothing, and why an agent with a
  small system prompt (`admin_task`'s head is ~900 tokens) caches nothing until
  its conversation grows past the minimum.
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
   (web searching, calendar).
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

- **Static system head (cached, cross-user):** instructions only, and no
  volatile value of any kind. It does not mention the current time, the timezone
  or the country at all; `interfaceContext` states them in plain English on the
  latest user message, where they sit after the cached prefix. See
  `interfaceSystemPrompt` in `agents/prompts.ts`.
- **Pinned topics** are per-user, so they are a **separate block** after the
  static instructions, carrying their own breakpoint (`systemTail` in
  `runAgent`, built by `cachedSystem`). The cross-user share is the instructions
  block; a change to one user's pins re-bills only the pinned block, never the
  shared head.
- **Volatile tail (uncached):** the datetime anchor, timezone and the user's
  country code with its country name (`interfaceContext` in `prompts.ts`) are
  prepended to the **current** user message, so they sit after the cached
  history prefix and never invalidate it. The country is stated as "not set"
  when unknown, which is also volatile text and costs the cache nothing.

## The breakpoint layout

In cache order:

1. **Static system head** — instructions only, byte-identical across users, and
   its breakpoint also covers every tool schema (tools are rendered before it and
   cannot carry a marker of their own). Emitted by `cachedSystem` in `runAgent`.
2. **Per-user system tail** — the pinned topics. Per-user, stable across turns
   while the pins do not change.
3. **Every markable message** — `markMessageBreakpoints` in `agents/cache.ts`
   marks the last markable block of every message that can carry one, on a
   per-request snapshot. Assistant messages get nothing.

That is the whole policy, and callers place no breakpoints of their own. Because
the marks are a pure function of the array, the same messages always render the
same bytes, which is what buys both reuse tiers at once:

- **Within a run:** step N+1 carries every mark step N carried, so it reads the
  prefix through step N and writes only the newly appended messages.
- **Across turns:** the persisted log is unmarked and re-marked identically next
  turn, so turn N+1's prefix matches turn N's history byte for byte.

Measured against the live API on 2026-08-03 with `bin/cache-probe.mjs`, which
replays a five-step tool loop under each policy (~3k tokens appended per step,
one `prompt_cache_key` per run). Re-run it after any change to this layout:

```
CLOUDFLARE_API_TOKEN=... node bin/cache-probe.mjs accumulate
CLOUDFLARE_API_TOKEN=... node bin/cache-probe.mjs move
```

Each row is one request: `input` / `cached` / `write`.

| step | `move` (one marker slides) | `accumulate` (this policy) |
|---|---|---|
| 0 | 3094 / 0 / 3083 | 3094 / 0 / 3083 |
| 1 | 6173 / **0** / 6162 | 6174 / **3083** / 3080 |
| 2 | 9252 / **0** / 9241 | 9254 / **6163** / 3080 |
| 3 | 12331 / **0** / 12320 | 12334 / **9243** / 3080 |
| 4 | 15410 / **0** / 15399 | 15414 / **12323** / 3080 |

Moving one marker per step never reads and re-writes the entire prefix every
step; accumulating reads the whole prefix and writes only the delta. Dropping
*any* earlier marker (e.g. keeping only the newest two) collapses back to the
left column: measured `cached=0, write=8402` at step 2. A request carrying 12
markers was accepted and kept the right-hand behaviour, so there is no reason to
economise on markers.

This is what the agent cost before the fix: on 2026-08-02 it wrote 34.4M tokens
to cache and read back 1.19M (3.4%), and cache writes were $8.60 of a $9.04 day.

The historical alternative — one breakpoint on the static head only, nothing on
messages — is the probe's `static` policy (`cached` constant, `write` 0). It avoids
write charges but re-bills the whole growing conversation at full input rate, and
costs ~1.5x the accumulating layout over a 5-step run.

The learner, onboarding and admin-task agents run the same `runAgent` machine and
use the single-`prompt` path with no system tail. The prompt is markable, so
their growing message region caches on exactly the same rule.

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

- `interface_completed`, `learn_slice_completed`,
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

- **Scenario:** a multi-step turn (a message that sends the agent searching the
  web, or a calendar lookup).
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
prefix served from cache with only the new tail billed at full price.

That read came entirely from the *fixed* breakpoints. The same day's logs also
showed the message region reading nothing at all: 34.4M tokens written against
1.19M read, because the message-region marker moved every step (fixed
2026-08-03). The lesson for this playbook: a healthy-looking `cache_read_tokens`
proves only that *some* prefix is warm. **The check that matters is that reads
grow step over step within a run while writes stay near the per-step delta.**
Constant reads next to large writes is the failure signature.

### Regression guard

Watch that full-price `input_tokens` drops for tool-heavy and long-conversation
turns versus the pre-deploy baseline, and that `cache_write_tokens` is not
dominating (which would mean prefixes are churning, i.e. a marker moved or was
dropped). Writes are billed at 1.25x, so a churning prefix is more expensive than
no caching at all — this guard is not a tuning nicety. Record observed before/after numbers below so a future prompt or tool
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
cache tokens showed the write-then-read pattern on every agent. Measured while
searching still ran in a nested `research` agent (removed on 2026-08-02); that
loop's steps now run under `interface`, and the pattern is the same:

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
