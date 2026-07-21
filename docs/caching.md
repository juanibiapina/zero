# Prompt caching

Zero caches the stable prefix of every LLM call so Anthropic bills it at ~0.1x
on reads instead of re-billing the full system prompt, tool schemas, and history
on every tool-loop step and every turn. This doc explains the three reuse tiers,
the breakpoint layout, and the production playbook that validates each tier.

A misplaced breakpoint is silent: the request still succeeds, you just pay full
price. So caching is only "done" once production telemetry shows the expected
reads for each tier (see [Production validation](#production-validation)).

## How Anthropic prompt caching works

- **Prefix-based.** Up to **4 `cache_control` breakpoints** per request. Each
  marks the end of a cacheable segment; a later request sharing the
  byte-identical prefix up to that marker reads it from cache. Any change earlier
  in the prefix invalidates everything after it.
- **Cache order is `tools` -> `system` -> `messages`.** Anthropic caches over
  that serialized prefix, so volatile content early (e.g. in `system`) kills
  caching of everything after it.
- **TTL:** 5 minutes default, 1 hour optional (`ttl: '1h'`, higher write
  premium). Refreshed on every hit.
- **Min cacheable length:** 1024 tokens for Sonnet 4.x. Our system+tools exceed
  this comfortably; shorter prefixes silently no-op.
- **Scope:** keyed on the Anthropic org/key. We run BYOK through one gateway key,
  so an identical prefix is **shared across all users**. Per-user attribution
  lives in `cf-aig-metadata` headers, which do not affect the request body, so
  cross-user prefix sharing is intact.

Cache writes cost 1.25x (5m) or 2x (1h) of input price; reads cost ~0.1x. A net
win requires reuse. Keep the AI Gateway's own **response caching off** — our
requests are never byte-identical (history grows, tools run), and stale full
responses would be wrong. Prompt caching is the right layer.

## The three reuse tiers

1. **Within one run (tool loop).** System, tools, and the initial messages are
   fixed across the loop's steps; only assistant/tool messages append. Every step
   after the first reads the prefix from cache. Biggest win on tool-heavy turns
   (research, calendar).
2. **Across users.** `tools` + the static part of every agent's `system` are
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
- **Pinned topics** are per-user, so they are folded onto the **tail** of the
  static system text (instructions first, pinned last). The one system breakpoint
  covers both; the cross-user share is the instructions prefix, and the pinned
  tail re-bills only when pins change. The 4-breakpoint budget leaves no
  dedicated breakpoint for pinned.
- **Volatile tail (uncached):** the datetime anchor and timezone
  (`interfaceContext` in `prompts.ts`) are prepended to the **current** user
  message, so they sit after the cached history prefix and never invalidate it.

## The 4-breakpoint layout (interface agent)

In cache order:

1. **Last tool** — `ttl: '1h'`. Caches all tool schemas; shared across users.
   Marked by `markLastTool` in `runAgent`.
2. **Static system head (pinned folded onto its tail)** — `ttl: '1h'`.
   Instructions shared across users; pinned tail makes the block per-user,
   cross-turn while unchanged. Injected by `cachedSystemMessage` in `runAgent`.
3. **Last stable history message** — default 5m. The previous turn's final
   block; byte-identical next turn, so this is the write that produces the
   cross-turn history read. Omitted when history is empty.
4. **Current user message** (carries the volatile context) — default 5m. Extends
   the write to cover the new turn for the within-run loop; **not** relied on for
   cross-turn reuse.

Breakpoints 3 and 4 form a **sliding window** (`interface.ts`). The cross-turn
win requires a write at a byte-stable end-of-history boundary. A single
breakpoint on the current message does not do this: that block carries the
volatile context and mutates every turn (the anchor is stripped when the message
becomes history), so it is never re-read. The stable-message breakpoint is what
yields the cross-turn read; the current-message breakpoint keeps the newest turn
warm for the loop.

Empirically verified (live, BYOK key, `claude-sonnet-4-6`, two-turn
conversation):

- Breakpoint **on the volatile current message**: turn 1 write=1613 read=0; turn
  2 write=4823 read=0. Zero cross-turn reuse.
- Breakpoint **on the last stable block** (this layout): turn 1 write=1611
  read=0; turn 2 write=10 read=1611. Full cross-turn hit.

TTL rationale: 1h on the shared static head is cheap because cross-user traffic
keeps it warm and the 2x write premium amortizes over huge read volume; 5m on the
per-user history segments matches burst cadence and avoids the 1h write premium
on prefixes that often won't be reused.

The research, writer, and onboarding agents run the same `runAgent` machine, so
they get tiers 1-2 (cached system + tools) for free. They use the single-`prompt`
path, so they have no messages-region breakpoints.

## Cross-user sharing invariant

Nothing per-user may appear in `tools` or the static `system`, or tier 2 breaks
silently. Concretely:

- The `view_attachment` tool is registered **unconditionally** so its schema is
  byte-identical across users (a conditional tool would differ per user/turn).
- Tool descriptions/schemas carry no user values (the Google calendar tools close
  over `timezone` only in their `execute` bodies, not descriptions).

## Reading cache tokens from logs

`runAgent` returns `usage` (whole-run aggregate) and `stepUsages` (per step).
Each agent's completion log carries token fields via `usageLogFields`:

- `interface_completed`, `research_completed`, `writer_completed`,
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
fields. Anthropic returns aggregate read/write for the whole request (not
per-breakpoint), so each tier is validated by a scenario where only that tier's
segment can be warm.

Tail logs with `gob add pnpm --dir apps/agent-api exec wrangler tail`, filter to
`*_completed` lines, and read `cache_read_tokens` / `cache_write_tokens`.
Cross-check against the AI Gateway dashboard token breakdown (split by the
`agent` metadata tag).

### Tier 1 — within one run

- **Scenario:** a multi-step turn (a message that fires `research` or a calendar
  lookup).
- **Pass:** the first step logs `cache_write_tokens > 0`; later steps
  (`interface_step_usage`) log `cache_read_tokens` on the order of the
  system+tools token count.

### Tier 2 — across users

- **Scenario:** with the static head warm from any traffic, a **different** user
  sends their **first** message of the day.
- **Pass:** that first turn logs `cache_read_tokens` ~ the static-head token
  count even though the user's own history/pinned segments are cold. Zero means a
  per-user byte polluted the shared prefix.

### Tier 3 — across turns

- **Scenario:** one user sends a message, waits under the 5-min TTL, sends a
  second.
- **Pass:** the second turn's first step logs `cache_read_tokens` covering system
  + tools + the full prior history (much larger than the static head), with only
  the new tail written; it grows turn over turn. A message after the TTL expires
  shows the history segment written again (expected expiry).

### Regression guard

Watch that full-price `input_tokens` drops for tool-heavy and long-conversation
turns versus the pre-deploy baseline, and that `cache_write_tokens` is not
dominating (which would mean prefixes are churning, i.e. a breakpoint is
misplaced). Record observed before/after numbers below so a future prompt or tool
change that silently breaks a breakpoint is caught.

## Recorded baselines

Fill in after each production validation run.

| tier | scenario | cache_read_tokens | cache_write_tokens | input_tokens | date |
| --- | --- | --- | --- | --- | --- |
| 1 | multi-step (research) | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
| 2 | new user first turn | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
| 3 | second turn under TTL | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
