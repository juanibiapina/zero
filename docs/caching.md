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
  premium; no beta header needed). Refreshed on every hit. The response splits
  writes by tier in `cache_creation.ephemeral_5m/1h_input_tokens`, so a TTL-tier
  check does not need separate requests.
- **Placement.** Zero sets `cache_control` on the exact block it means: the last
  tool definition, the system text block, and a message's last content block.
  The API also accepts a top-level `cache_control` request param that
  auto-marks the last cacheable block; that is one breakpoint at the end of the
  prompt, not a substitute for Zero's four.
- **Min cacheable length:** 1024 tokens for Sonnet 4.x. Our system+tools exceed
  this comfortably; shorter prefixes silently no-op.
- **Thinking blocks cannot carry a breakpoint.** Anthropic rejects
  `cache_control` on a `thinking` or `redacted_thinking` block; they are cached
  implicitly with the prefix around them and are billed as input when read back.
  `markCacheBreakpoint` therefore leaves a message ending on one unmarked (a
  response cut off mid-thinking is exactly that shape).
- **The thinking configuration and the resolved effort are rendered into the
  prompt.** Changing either starts a new cache prefix. Measured 2026-08-01: a
  request sending no `effort` and one sending `effort: "high"` both read the same
  1,443-token cached prefix, while `effort: "medium"` rewrote all of it. That is
  also the proof that omitting `effort` *is* `high`.
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
   Marked by `markLastTool` in `runAgent`, which sets `cache_control` directly
   on the last tool definition.
2. **Static system head (pinned folded onto its tail)** — `ttl: '1h'`.
   Instructions shared across users; pinned tail makes the block per-user,
   cross-turn while unchanged. Injected by `cachedSystem` in `runAgent`, which
   sends `system` as a text block carrying `cache_control`.
3. **Cross-turn anchor: last stable history message** — default 5m. The previous
   turn's final block; byte-identical next turn, so this is the write that
   produces the cross-turn history read. Set by `interface.ts`; omitted when
   history is empty.
4. **Loop-owned sliding tail** — default 5m. Owned by `runAgent`, not the
   caller: before every step it marks the **last message of a per-request
   snapshot** (`slideMessageBreakpoint` in `cache.ts`), advancing the breakpoint
   to the new tail as the tool loop appends steps. This keeps a cache write
   within Anthropic's 20-block lookback of the growing tail, so step N reads
   everything through step N-1 and writes only the delta. The persisted messages
   are never mutated, so no breakpoints accumulate.

Breakpoints 3 and 4 form a **sliding window**. The cross-turn win requires a
write at a byte-stable end-of-history boundary. A single breakpoint on the
current message does not do this: that block carries the volatile context and
mutates every turn (the anchor is stripped when the message becomes history), so
it is never re-read. The stable-message anchor is what yields the cross-turn
read; the loop's sliding tail keeps the newest turn (and every appended tool
step) warm for the within-run loop.

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

The research, learning, and onboarding agents run the same `runAgent` machine, so
they get tiers 1-2 (cached system + tools) for free. They use the single-`prompt`
path with no caller anchor, but the loop's sliding tail breakpoint (tier 4) now
caches their growing message region too: on a multi-step research turn each step
reads the accumulated context from cache and writes only its delta, instead of
re-billing the whole conversation at full price every step (the pre-fix defect
was `cache_read` pinned at the ~1.7k head with `cache_write = 0` across the loop).
A prompt-only agent thus spends tools + system + one sliding breakpoint (3 of 4);
the interface agent spends all 4 (tools + system + anchor + sliding).

## Cache diagnostics

Every request carries the `cache-diagnosis-2026-04-07` beta, and every request
names a previous response with `diagnostics.previous_message_id`: within a run
the run's own previous response, and on a run's first request the response this
conversation last received, read from the persisted log
(`messages.responseId`). The response reports how this request's
prefix diverged from that one. `agents/model.ts` logs a content-free
`cache_diagnostic` line per response: `agent`, `step` (the zero-based loop
index), `state`, `chain_crossed_turn` (true only on the first request of a run,
when the comparison reaches back to an earlier turn), `cache_missed_input_tokens`
(when the state carries one), plus
this response's own `input_tokens` (uncached, full-price), `cache_read_tokens`,
and `cache_write_tokens`. On a working message-region cache, `cache_read_tokens`
grows step-over-step while `input_tokens` stays small; the broken case shows a
large constant `input_tokens` and a tiny constant read.

**A miss reason is chain-relative, not a cache miss.** It answers "how does this
request's prefix differ from the request I named", never "was the cache used".
A live probe reported `system_changed` with `cache_missed_input_tokens: 940`
while reading 1466 tokens from cache and writing none. That is why the log line
carries the read/write counts: they are the cache signal, the state is the
divergence signal.

States (`state` in the log line):

- `initial`: Zero passed `previous_message_id: null` (first request of a run).
  The wire returns `diagnostics: null` here, exactly as it does for "no
  divergence"; the two are told apart locally by what Zero sent.
- `no_divergence`: a previous id was sent and the prefix matched it.
- `pending`: the response was serialized before the background comparison
  finished (`cache_miss_reason: null`).
- `model_changed`, `system_changed`, `tools_changed`, `messages_changed`: each
  carries `cache_missed_input_tokens`.
- `previous_message_not_found`, `unavailable`: no token count.

Small requests still get a miss reason: a tiny request with no system block
reported `system_changed` with a count of 0. Do not read `initial` as "small
request".

**Across turns, per conversation.** Now that the conversation is an append-only
log, turn N+1's prefix genuinely extends turn N's, so the interface agent opens
its chain on the conversation's last persisted response id and the line says so
with `chain_crossed_turn: true`. Research and learning pass no previous id of
their own, so nothing leaks across an agent boundary.

Read a cross-turn line with its known confounders in mind rather than as a fault:
fingerprints expire well inside the gap between many turns
(`previous_message_not_found`), and Zero prepends volatile context (the clock) to
the current user message, so `messages_changed` on a first request is expected by
construction. What the flag buys is the ability to separate those from an
in-run divergence, and to notice a conversation whose prefix changes between
turns for a reason that is **not** the volatile context — a rewritten history row,
a staleness stub landing, a reordered block. Expect late-step `messages_changed`
within a run too; that is the loop appending tool results, which is normal.

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

**Every baseline below predates adaptive thinking** (enabled for every agent on
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
