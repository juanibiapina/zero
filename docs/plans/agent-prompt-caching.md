# Plan — prompt-caching fix for the Zero agent

Status: plan only (no code changes). Model in production: `claude-sonnet-4-6`
(`apps/agent-api/wrangler.jsonc` `MODEL_ID`). Read against `main` at commit
`131a7f0` (research is now gather-and-report: write tools removed, new
`researchSystemPrompt`).

## Goal

Every LLM call inside a turn should re-process as few full-price input tokens as
possible by reading its stable prefix from Anthropic's prompt cache. The user's
stated requirement is that the three agents (interface, research, writer) share
**one** cached prompt prefix so a research call, the return to the interface
agent, and the writer's consolidation all reuse it.

This plan investigates whether that shared-prefix design is achievable, and if
not, delivers the design that actually removes the measured waste. **Verdict up
front: one shared prefix across the three agents is not achievable and is not
where the cost is. The real, measured waste is inside the research loop, whose
growing message region is never cached, so every step re-bills the entire
accumulated context at full price.** The fix is a sliding message-region cache
breakpoint applied inside the runner's tool loop for all agents.

## Anthropic prompt-caching rules (the constraints)

All from Anthropic's official doc, *Prompt caching*
(`https://docs.claude.com/en/docs/build-with-claude/prompt-caching`, fetched
2026-07-27; quotes are from that page).

1. **The cache is an exact prefix hash over `tools` → `system` → `messages`, in
   that order.** "Prompt caching references the entire prompt — `tools`,
   `system`, and `messages` (in that order) up to and including the block
   designated with `cache_control`." "Cache prefixes are created in the following
   order: `tools`, `system`, then `messages`. This order forms a hierarchy where
   each level builds upon the previous ones."

2. **Writes happen only at a breakpoint, over the cumulative prefix.** "Marking a
   block with `cache_control` writes exactly one cache entry: a hash of the
   prefix ending at that block… Because the hash is cumulative, covering
   everything up to and including the breakpoint, changing any block at or before
   the breakpoint produces a different hash on the next request." So a
   byte-identical `system` block that sits behind a **different** `tools` array
   hashes differently and does **not** share a cache entry.

3. **What invalidates:** "Changes at each level invalidate that level and all
   subsequent levels." The invalidation table: **modifying tool definitions
   (names, descriptions, parameters) invalidates the entire cache** (tools,
   system, and messages). A changed `system` invalidates system + messages.

4. **Max 4 breakpoints.** "You can define up to 4 cache breakpoints." Exceeding 4
   explicit block-level breakpoints returns a 400.

5. **20-block lookback window (this is central to the fix).** With one breakpoint
   the system "checks at most 20 positions per breakpoint… If the system finds no
   matching entry in that window, checking stops." Worked example: a breakpoint
   35 blocks into a conversation cannot reach an entry written at block 15 (one
   position outside the 20-block window), so **a growing conversation loses its
   cache unless a breakpoint sits within 20 blocks of the accumulated tail**.
   "If a growing conversation pushes your breakpoint 20 or more blocks past the
   last write, the lookback window misses it. Add a second breakpoint closer to
   that position from the start so a write accumulates there before you need it."

6. **Automatic caching option.** "Add a single `cache_control` field at the top
   level of your request. The system automatically applies the cache breakpoint
   to the last cacheable block and moves it forward as conversations grow." It
   "uses one of the 4 available breakpoint slots." This is the built-in form of a
   sliding breakpoint for a growing message list.

7. **Minimum cacheable prefix: 1,024 tokens for Sonnet 4.6.** Shorter prompts are
   processed uncached with no error; both `cache_creation_input_tokens` and
   `cache_read_input_tokens` come back 0. Zero's tools+system head exceeds this.

8. **TTL: 5 minutes default, 1 hour optional.** "By default, the cache has a
   5-minute lifetime… Anthropic also offers a 1-hour cache duration at additional
   cost" via `{ "cache_control": { "type": "ephemeral", "ttl": "1h" } }`. Only
   these two durations exist ("ephemeral is the only supported cache type"). Each
   hit refreshes the TTL at no cost.

9. **Pricing (Sonnet 4-class multipliers, from the doc):** cache **read** =
   0.1× base input; 5-minute **write** = 1.25× base input; 1-hour **write** = 2×
   base input. A net win requires reuse; a churning breakpoint (write every
   request, never read) costs 1.25–2× and is worse than no caching.

10. **Token accounting for verification.** `input_tokens` in the response is
    "only the tokens that come after the last cache breakpoint," and
    `total = cache_read_input_tokens + cache_creation_input_tokens +
    input_tokens`. So a working message-region cache shows a **small** residual
    `input_tokens` and a large `cache_read_input_tokens`; the broken case (today's
    research) shows a large `input_tokens` and a tiny constant read.

11. **Thinking blocks and tool-result appends (Sonnet 4.6 is safe).** "On Opus
    4.5+ and Sonnet 4.6+, thinking blocks are preserved by default even when
    non-tool-result user content is added, so the cache remains valid." Appending
    tool results (the tool loop's normal move) does not invalidate the message
    cache on our model.

12. **Cross-user scope.** Cache is keyed on the Anthropic org/key. Zero runs BYOK
    through one gateway key, and `cf-aig-metadata` is a header (not request body),
    so a byte-identical prefix is shared across all users (per
    `docs/caching.md`). This is why per-user bytes must never enter `tools` or the
    static `system`.

**Direct consequence for the user's proposal (rules 1–3):** because `tools`
precede `system` in the hash and the three agents carry **different tool sets**,
a byte-identical `system` prompt across them still produces **three different
cache entries**. A shared system prompt alone cannot make them share a cache.
Sharing would additionally require identical `tools` **and** identical `system`
text across all three agents. See the verdict below.

## Measured baseline (production)

The measurement already exists: `docs/plans/agent-latency-investigation.md`
(incident 2026-07-27, live AI Gateway + Workers logs + `cache_diagnostic`
lines). That investigation predates commit `131a7f0`, so its research loop still
authored topic bodies; the **caching defect it recorded is unchanged by
`131a7f0`** (research still uses the single-`prompt` path with no message-region
breakpoint — see `apps/agent-api/src/tools/research.ts` calling `runAgent` with
`prompt`, and `apps/agent-api/src/agents/run.ts` which never adds a message
breakpoint in the loop).

Per-agent, from the `cache_diagnostic` log (the log line in
`apps/agent-api/src/agents/model.ts` carries `agent`, `state`,
`cache_read_tokens`, `cache_write_tokens`):

- **research (BROKEN):** across the whole loop, `cache_read_tokens = 1727`
  **constant**, `cache_write_tokens = 0`, while gateway `input` grows 396 →
  **92,796** over ~20 sequential calls. The 1,727 read is only the
  system+tools head (tiers 1–2); nothing in the growing 90k message region is
  ever promoted to cache, so **every step reprocesses the entire accumulated
  conversation uncached**. Sum of research input across the loop ≈ ~1.6M tokens,
  nearly all full-price.
- **interface (WORKING):** in the same window, `cache_read ≈ 4086`,
  `cache_write ≈ 1857/3847` — it caches its message region because
  `interface.ts` sets sliding message-region breakpoints (`markCacheBreakpoint`
  on the last two messages) that research lacks.
- **writer (HEAD ONLY):** recorded baseline in `docs/caching.md` shows the
  writer's 1h system+tools head (~1,626 tokens) reads across turns with
  `write=0`, but its **message region is uncached** (single-`prompt` path, same
  as research). It is usually 1–2 steps, so the waste is small today; a
  multi-topic consolidation that runs many `get_topic`/`update_topic` steps hits
  the same growing-context re-bill as research.

`docs/caching.md` also records a pre-incident tier-1 "PASS" for research (read
18,980 across 14 steps). That number is the ~1,460-token head read back ~13
times, **not** the growing conversation — the same head-only illusion, consistent
with the constant-read defect above.

**Named cause:** `apps/agent-api/src/agents/run.ts` `runAgent` places cache
breakpoints only on `tools` (`markLastTool`) and `system` (`cachedSystem`). The
message-region sliding window is set by the **caller** (`interface.ts`) and only
the interface agent does it; research and writer pass a single `prompt` and set
no message breakpoint, and the loop in `run.ts` never adds or advances one as it
appends steps. With no breakpoint within 20 blocks of the growing tail (rule 5),
the research loop's accumulated context is re-billed in full on every step.

## Is the system prompt unstable between calls? (checked — no)

Reported symptom: the system prompt appears to change between calls in the
Anthropic console, which would defeat caching. Investigated by reading how each
agent assembles its system text (`apps/agent-api/src/agents/prompts.ts`) and
where per-turn/volatile values live:

- **research / writer / onboarding / admin:** `researchSystemPrompt()`,
  `writerSystemPrompt()`, `onboardingSystemPrompt()`, `adminTaskSystemPrompt()`
  are **pure constant strings** — no timestamp, date, user state, name, or topic
  list interpolated. Byte-identical on every call and across users.
- **interface:** `interfaceSystemPrompt(pinned)`. The only per-user variable is
  `pinned` (the pinned-topic bodies folded onto the **tail** of the static
  instructions). `runInterfaceAgent` computes `pinned` **once per turn** before
  the loop (`const pinned = renderPinnedTopics(...)`), so it is byte-stable across
  every step of the interface run and changes only when the user's pinned set
  changes (not per call, not generally per turn).
- **The clock is not in `system`.** `interfaceContext(now, timezone)` (current
  time + timezone) is prepended to the **current user message**, not the system
  prompt — this is the existing stable-head/volatile-tail split in
  `docs/caching.md`. No date/time interpolation exists in any system prompt.

**Conclusion:** within any single agent's run the system prompt is byte-stable.
What the console shows changing is the **three different agents' system prompts**
(interface vs research vs writer are entirely different text) — expected, not a
defect. The `cache_diagnostic` chain is in-run only, so no `system_changed` can
arise from the system text within a run. **There is no system-prompt instability
to fix**, and no instruction content needs to move out of `system` (see Risks —
moving instructions to a user message would risk behavior drift for zero caching
benefit here).

## Verdict: is one shared prefix across the three agents achievable?

**No, and it should not be pursued.**

- **Blocked by rules 1–3.** `tools` precede `system` in the cache hash, the three
  agents carry different tool sets (interface: reply + topic tools + `research` +
  timezone + Google + attachments; research: read-only `list_topics`/`get_topic`
  + `web_search` + `read_page`; writer: topic read/write tools), and any tool
  difference invalidates the entire downstream cache. A shared `system` string
  behind different `tools` lands in **three separate cache entries**. The agents
  also have entirely different `system` **text** today, so unifying tools alone
  would not suffice.
- **Making the prefix truly shared would require giving all three agents the same
  tool set and the same system text.** That is harmful: research would gain write
  tools and the `research` tool itself (recursion risk) and Google/attachment
  tools it must not use; the writer would gain `reply`. It also defeats the point
  of separate agents.
- **It is not where the cost is.** The shared head is ~1,727 tokens. Even a
  perfect cross-agent share saves re-writing ~1.7k tokens at most twice per turn
  (~3.4k tokens). The measured waste is **~1.5M full-price input tokens per long
  research turn**. Optimizing the 1.7k head while ignoring the 1.5M is the wrong
  target.

**Best achievable structure (and it already mostly holds):**

1. Each agent keeps its **own** `tools` + static `system` head at 1h TTL. This
   head is already shared cross-user and cross-turn (tier 2 / writer-head
   baseline PASS in `docs/caching.md`). Nothing to change.
2. Each agent gets a **sliding message-region breakpoint inside the runner's tool
   loop**, so the growing conversation caches within the run (tier 1). This is
   the fix; research is the agent broken today.
3. No cross-agent shared prefix. The "return to the interface agent after
   research" already reuses the **interface's own** cached prefix (its head +
   history + the loop's sliding breakpoint); it does not and should not share
   research's cache.

## Design

Move the sliding-window breakpoint from the interface caller **into the runner's
loop** (`apps/agent-api/src/agents/run.ts` `runAgent`), so every agent — research
and writer included — caches its growing message region. Keep each agent's own
tools+system head exactly as is.

Breakpoint budget per request stays ≤ 4:

- `tools` (1, 1h) — unchanged (`markLastTool`).
- `system` (1, 1h) — unchanged (`cachedSystem`).
- **anchor** message breakpoint (≤ 1, 5m) — the end of the caller-provided
  stable prefix. Interface supplies this on its **last stable history message**
  (the cross-turn read; keep interface's existing anchor). Research/writer supply
  none (their single prompt is the anchor implicitly).
- **sliding** message breakpoint (1, 5m) — owned by the loop: before each
  `generate`, mark the **last block of the current messages array** on a
  per-request snapshot, without mutating the persisted messages. This keeps a
  cache write within 20 blocks of the growing tail on every step (rule 5), so
  step N reads everything through step N−1 and writes only step N−1's delta.

Mechanics:

- `run.ts` already snapshots `messages: [...messages]` per request. Apply
  `markCacheBreakpoint` (from `cache.ts`) to the **snapshot's** last message so
  the persisted array and the model's verbatim round-tripped blocks stay clean
  (no accumulating breakpoints across steps — that would blow the 4-slot budget
  and 400). Exactly one sliding breakpoint exists at a time, at the tail.
- **Interface loses its current-message breakpoint.** Today `interface.ts` marks
  both the last-stable message and the current message. Once the loop owns the
  sliding breakpoint, interface keeps only the last-stable **anchor**; the loop's
  sliding breakpoint covers the current message on step 0 and every appended tool
  turn after. Net breakpoints for interface: tools + system + anchor + sliding =
  4. For research/writer: tools + system + sliding = 3.
- Gate it on the existing `cache` flag (default on) so the plain-shape tests that
  pass `cache: false` are unaffected.

Alternative considered: **Anthropic automatic caching** (rule 6) — a single
top-level `cache_control` that the API auto-slides to the last cacheable block.
It is less code and is the doc's canonical growing-conversation tool. Rejected as
primary because Zero's design keeps `cache_control` explicit on the block it
means (testable via request-byte assertions in `run.test.ts`), and the explicit
sliding breakpoint reuses the existing `markCacheBreakpoint` helper and mirrors
the proven interface layout. Keep automatic caching as a fallback if the explicit
form proves awkward.

`markCacheBreakpoint` needs no generalization itself — it already marks the last
content block of a message. The generalization is **where it is called**: move
the per-step call from `interface.ts` into `run.ts`'s loop so all three agents
get it, and reduce `interface.ts` to setting only its cross-turn anchor.

## Ordered steps

1. **`run.ts` — loop owns the sliding breakpoint.** In `runAgent`, when `cache`
   is on, build the per-request `messages` snapshot with `markCacheBreakpoint`
   applied to the last message (5m TTL). Do not mutate the persisted `messages`
   array or the model's round-tripped blocks. Preserve any caller anchor
   breakpoint already present earlier in the array.
2. **`interface.ts` — drop the current-message breakpoint.** Keep only the
   last-stable-history anchor (`convo[lastIdx - 1] = markCacheBreakpoint(...)`);
   remove the `convo[lastIdx] = markCacheBreakpoint(...)` line, since the loop now
   marks the tail. Confirm total breakpoints ≤ 4 in the first request.
3. **Tests (`run.test.ts`, `cache.test.ts`, `interface.test.ts`).** Assert on the
   captured request bytes (the mock model records `requests[]`): (a) research/
   writer requests now carry a `cache_control` on the last message block of every
   step; (b) the marked block advances to the new tail each step and no more than
   one sliding message breakpoint is present per request; (c) total block-level
   breakpoints per request ≤ 4 for the interface agent; (d) `cache: false` still
   yields the plain shape. Prompt caching itself cannot be unit-tested (mocks
   have no real cache) — see `docs/caching.md`.
4. **Docs.** Update `docs/caching.md`: state that the sliding message-region
   breakpoint is owned by `runAgent` and applies to **all** agents (not just
   interface), and correct the "research/writer have no messages-region
   breakpoints" line. Record the new production baseline once measured.
5. **Changelog.** Purely internal (cost/perf, no user-visible behavior change) —
   **no changelog entry** per the repo's changelog rule.
6. **Validate in production** by reading `cache_diagnostic` / `research_completed`
   token fields (acceptance criteria below), then record before/after in
   `docs/caching.md`.

## Quantified expected win

Per long research turn, Sonnet 4.6 input pricing from the doc (base input
$3/MTok; 5-minute write 1.25× = $3.75/MTok; read 0.1× = $0.30/MTok):

- **Today (broken):** sum of research input across the loop ≈ **1.6M tokens**,
  nearly all full-price → ≈ **$4.8** of input per long turn; `cache_read` pinned
  at 1,727, `cache_write` 0.
- **After (sliding breakpoint):** each context token enters once (written at
  ~1.25×) and is read from cache (~0.1×) on every later step. With a peak context
  of ~92k tokens: writes ≈ 92k × $3.75/M ≈ **$0.35**; reads ≈ (1.6M − 92k) ×
  $0.30/M ≈ **$0.45**. Total ≈ **$0.80** of input per long turn.
- **Win ≈ $4 per long research turn, ~5–6× less input cost.** Full-price
  `input_tokens` summed across the research loop drops from ~1.6M to roughly the
  peak-context size (~90–150k). Post-`131a7f0` research no longer authors 5–8k
  topic bodies, so the absolute peak context is smaller and the absolute dollar
  figures shrink, but the **ratio holds** on any multi-step research turn that
  accumulates `read_page`/`search` output. Latency effect is modest (prefill is a
  small fraction of the output-bound wall clock); this is primarily a **cost** fix
  (it is Rank #5 / "Rank #2 caching" in the latency investigation, not the
  latency headline).
- Writer: same mechanism benefits multi-step consolidations; single-step writer
  turns are unaffected (nothing to cache beyond the head they already read).

## Acceptance criteria (numbers from production cache diagnostics)

Objectively checkable, from the logged token fields (`cache_diagnostic`,
`research_completed`, `interface_step_usage`), not "we added breakpoints":

1. **Research message region caches.** On a multi-step research turn,
   `cache_write_tokens > 0` on early steps and `cache_read_tokens` grows
   step-over-step, reaching the order of the accumulated context by the final
   step — instead of the current constant `read = 1727, write = 0`.
2. **Full-price input collapses.** Summed `input_tokens` across the research loop
   drops from the ~1.6M baseline to roughly the peak-context size (target: at
   least a 5× reduction on a comparable long research turn).
3. **Per-step pattern.** Step N's `cache_read_tokens` ≈ accumulated context
   through step N−1; step N's `cache_write_tokens` ≈ the delta added by step N−1
   (the write-then-read pattern the docs describe).
4. **Interface unregressed.** Interface still shows its cross-turn head+history
   read on a turn's first step (existing tier-3 numbers in `docs/caching.md`
   hold), and no request exceeds 4 block-level breakpoints (no 400s in gateway
   logs).
5. **Head reuse intact.** The 1h system+tools head still reads with `write=0`
   across turns/users (tier-2 / writer-head behavior unchanged).

## Risks and mitigations

- **Moving instructions out of `system` (the user's implied restructuring).**
  Anthropic recommends static instructions in `system`, and models are tuned to
  treat the system role as authoritative; relocating agent-specific instructions
  into a first user message risks behavior drift and changes prompt-injection
  posture. Because the shared-prefix goal is unachievable anyway, **do not move
  instructions**. Each agent keeps its instructions in `system`. This removes the
  quality-regression risk entirely. Detection if ever attempted: compare reply/
  research/writer output on a fixed transcript set before/after.
- **20-block lookback miss (rule 5).** If a single step emits ~20+ parallel tool
  calls, the sliding breakpoint's lookback could overshoot the prior write.
  Zero's agents almost always emit one tool call per step; note the bound and
  watch for a step whose `cache_read` unexpectedly drops to the head size.
- **Breakpoint budget / 400s.** The sliding breakpoint must never accumulate
  across steps and interface must drop its current-message breakpoint, or a
  request could carry 5 breakpoints and 400. Covered by acceptance criterion 4
  and the unit tests asserting ≤ 4 and exactly one sliding breakpoint per request.
- **Thinking blocks.** Safe on Sonnet 4.6 (rule 11): tool-result appends keep the
  message cache valid. Re-check if `MODEL_ID` ever moves to an older/Haiku model.
- **Write premium if a loop never reuses.** A single-step turn writes the tail at
  1.25× and never reads it. Negligible (small tails) and already the case for the
  head; keep message-region TTL at 5m (not 1h) so unreused tails do not pay the
  2× premium.

## Skills to use during implementation

- `tdd` — drive the `run.ts` loop change and the interface breakpoint removal
  from the request-byte assertions in `run.test.ts` first.
- `reproducible-locally` — for the production validation step (the cache itself
  is only observable in production; prove the token-field acceptance criteria on
  a real research turn).
- `git-commit` — when committing.

## Key files

- `apps/agent-api/src/agents/run.ts` — `runAgent` loop; add the loop-owned
  sliding breakpoint.
- `apps/agent-api/src/agents/cache.ts` — `markCacheBreakpoint` (reused as-is).
- `apps/agent-api/src/agents/interface.ts` — drop the current-message breakpoint;
  keep the last-stable anchor.
- `apps/agent-api/src/tools/research.ts`, `apps/agent-api/src/agents/writer.ts` —
  no change needed (they benefit automatically once the loop owns the breakpoint).
- `apps/agent-api/src/agents/model.ts` — `cache_diagnostic` logging (verification
  source; no change unless adopting automatic caching's top-level param).
- `docs/caching.md`, `docs/plans/agent-latency-investigation.md` — background and
  the recorded baseline.
