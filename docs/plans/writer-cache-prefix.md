# Plan — make the writer share the interface agent's cache prefix

Status: **DROPPED BY THE USER on 2026-07-28.** No code change proposed.

Read against `main` at `4869e83`. Production model: `claude-sonnet-4-6`
(`apps/agent-api/wrangler.jsonc` `MODEL_ID`).

## Goal

The queued task asks that the writer agent's LLM calls read the same cached
prompt prefix as the interface agent's calls, so the writer stops paying to
re-process a prefix the interface already warmed.

This plan answers three questions in order, and stops at the first one that
settles the matter:

1. **How much money is actually on the table?** Computed from the recorded
   per-call table for the verified 2026-07-27 17:51:20Z production turn.
2. **Is a shared prefix reachable at all** given Anthropic's cache contract and
   the two agents' real toolsets?
3. **Would reaching it cost safety?**

**Answer up front: the maximum theoretical saving is $0.00195 on a $0.21726
turn (0.9%), the realistic saving is $0.00, the only way to a longer shared
prefix is to give the writer the interface's `reply`, `research`, Google and
attachment tools, and whatever cross-agent tool sharing the API permits is
already structurally in place today with no code change. Drop the task.**

## Artifacts this plan is grounded in

Every number below comes from one of these. Nothing is estimated except where
explicitly flagged, and one number is called out as not existing anywhere.

- `docs/plans/agent-latency-investigation.md`, section "Post-fix measurement:
  the 2026-07-27 17:51:20Z research turn". 13 AI Gateway rows, per-call agent
  tag, uncached-input tokens, output tokens, gateway cost, duration.
- `docs/caching.md`, section "Recorded baselines" → "Writer cross-turn head".
  Writer head = **1626 tokens**, read with `write=0` on turns 2 and 3.
- Anthropic's *Prompt caching* doc, fetched from source at
  `https://docs.claude.com/en/docs/build-with-claude/prompt-caching` on
  2026-07-28, and the pricing page at
  `https://docs.claude.com/en/docs/about-claude/pricing`.
- Code: `apps/agent-api/src/agents/{run,cache,interface,writer,prompts}.ts`,
  `apps/agent-api/src/tools/{topics,research,google,timezone,attachments}.ts`.
- `docs/topics.md` (two-phase agent contract and the writer's tool policy),
  `docs/research.md`, prior plan `docs/plans/agent-prompt-caching.md` (the
  commit `c9b443a` work).

## The Anthropic cache contract, verified at source

Fetched 2026-07-28 from the live doc, not from this repo's summary. The facts
that decide this task:

1. **Cumulative prefix hash, in the order `tools` → `system` → `messages`.**
   "Cache prefixes are created in the following order: `tools`, `system`, then
   `messages`. This order forms a hierarchy where each level builds upon the
   previous ones." And: "Marking a block with `cache_control` writes exactly one
   cache entry: a hash of the prefix ending at that block… Because the hash is
   cumulative, covering everything up to and including the breakpoint, changing
   any block at or before the breakpoint produces a different hash on the next
   request."
   Consequence: identical `system` text behind different `tools` arrays hashes
   differently. The repo's summary of this is correct.

2. **Invalidation table.** "Modifying tool definitions (names, descriptions,
   parameters) invalidates the entire cache" (tools, system and messages).
   A `system` change invalidates system and messages.

3. **Reads walk backward, writes happen only at breakpoints.** "On each request
   the system computes the prefix hash at your breakpoint and checks for a
   matching cache entry. If none exists, it walks backward one block at a time…
   It is looking for prior writes, not for stable content."

4. **Lookback window is 20 blocks.** "The system checks at most 20 positions per
   breakpoint, counting the breakpoint itself as the first."
   Tool definitions are explicitly listed under "What can be cached" ("Tools:
   Tool definitions in the `tools` array"), so they are blocks the backward walk
   traverses.

5. **Four breakpoints maximum.** "You can define up to 4 cache breakpoints."
   Breakpoints themselves are free; you pay only for what is written and read.

6. **Minimum cacheable prefix for Sonnet 4.6 is 1,024 tokens.** From the "Cache
   limitations" table: "1,024 tokens for Claude Opus 4.8, Claude Sonnet 5,
   Claude Sonnet 4.6, …". Below it, "requests to cache fewer than this number of
   tokens will be processed without caching, and **no error is returned**".
   This matters here: see Risk R2.

7. **Sonnet 4.6 pricing** (pricing page, fetched 2026-07-28): base input
   **$3 / MTok**, 5-minute cache write **$3.75 / MTok** (1.25x), 1-hour cache
   write **$6 / MTok** (2x), cache read **$0.30 / MTok** (0.1x), output
   **$15 / MTok**.

## Measurement: what a shared prefix could possibly save

### The writer's share of the measured turn

From the recorded per-call table (`docs/plans/agent-latency-investigation.md`),
the writer's 4 calls:

| UTC | in | out | cost (USD) |
|---|---|---|---|
| 17:52:23 | 3 | 37 | 0.01544250 |
| 17:52:30 | 1 | 140 | 0.02075880 |
| 17:52:47 | 1 | 946 | 0.01712835 |
| 17:52:49 | 1 | 92 | 0.00739035 |
| **total** | **6** | **1,215** | **0.06072000** |

Writer phase = **$0.06072** of the turn's **$0.21726**, i.e. **27.9%** of turn
cost. Uncached full-price input across all four calls is **6 tokens** total
(the head is already served from cache), worth $0.000018.

### The head, priced

`docs/caching.md` records the writer's static `tools` + `system` head at
**1,626 tokens**, read at 0.1x with `write=0` on two consecutive measured turns.

- Head read, per call: 1,626 × $0.30/MTok = **$0.00048780**
- Head read, 4 calls (this turn): 6,504 tokens = **$0.00195120**
- That is **3.2%** of the writer phase and **0.90%** of the turn.

### The ceiling on any shared-prefix scheme

The absolute ceiling assumes something impossible: that the writer's **entire**
head (tools *and* system) becomes free on **every** call.

- Turn cost today: **$0.21726**
- Turn cost at the ceiling: **$0.21531**
- Saving: **$0.00195 per turn, 0.90%**, i.e. **one fifth of a cent**. Rounded to
  cents, the turn costs $0.22 either way.

The realistic saving is smaller than the ceiling for two independent reasons:

- **Sharing does not remove read charges.** A shared prefix is still billed at
  $0.30/MTok when read. Sharing only changes *who writes it and how often*. The
  $0.00195 above is read cost, and it survives sharing untouched.
- **The writer already pays $0 in head writes on warm turns.** The recorded
  baseline is `read=1626, write=0` on turns 2 and 3. The head is 1h TTL and
  shared across all users, so it is warm almost always. The only avoidable cost
  is one cold 1-hour write: 1,626 × $6/MTok = **$0.00976**, incurred at most
  once per hour across the entire user base, and a shared prefix would not
  remove it either, it would just move it to whichever agent ran first.

**Realistic saving: $0.00 per turn. Ceiling: $0.00195 per turn.**

### Where the writer's money actually is

Decomposing the $0.06072 with the verified prices:

- Output: 1,215 tokens × $15/MTok = **$0.018225** (30.0% of the writer phase)
- Uncached input: 6 tokens × $3/MTok = $0.000018 (0.03%)
- Head reads: **$0.001951** (3.2%)
- Residual: **$0.040526** (66.7%)

The residual is cache write plus cache read over the writer's **own message
region**: the turn transcript (which carries the 1,115-token research report
under the 8,000-char ceiling) plus the tool-loop tail that the sliding
breakpoint writes each step. At the 5-minute write price, $0.040526 corresponds
to ~10.8k tokens if it were entirely writes.

**That derivation is a bound, not a measurement.** The AI Gateway row exposes a
single `cost` figure and does not break out cache-read versus cache-write
tokens per call, so **the exact read/write split for these four calls does not
exist in any artifact.** The Workers `writer_completed` log line carries those
fields (`usageLogFields` in `run.ts`), but no such line was captured for this
turn. Do not quote a split without capturing one.

Two thirds of the writer's cost is a per-turn transcript that is unique to that
turn by construction and therefore unshareable with anything. The head that this
task targets is 3.2%.

## Feasibility: is a shared prefix reachable?

### The task's stated premise is factually wrong

The task brief says "the writer agent needs topic-WRITE tools that the interface
agent deliberately lacks". The code says the opposite. `buildTopicTools` in
`apps/agent-api/src/tools/topics.ts` contains `list_topics`, `get_topic`,
`list_backlinks`, `create_topic`, `update_topic`. Both agents get all five:

- **Writer** (`agents/writer.ts`): exactly `buildTopicTools`, **5 tools**.
- **Interface** (`agents/interface.ts`): `buildInterfaceTools` (which spreads
  `buildTopicTools` first, then adds `delete_topic` and `reply`), then the
  research, timezone, Google and attachment tools. **16 tools**, in this wire
  order (`toToolDefinitions` maps `Object.entries`, so declaration order is wire
  order):

  `list_topics, get_topic, list_backlinks, create_topic, update_topic,
  delete_topic, reply, research, set_timezone, gmail_search, gmail_thread,
  gmail_send, calendar_list_calendars, calendar_list_events,
  calendar_create_event, view_attachment`

The interface already has full topic write access. The asymmetry runs the other
way: the **writer's tool array is a strict, byte-identical prefix of the
interface's**, and the interface holds 11 tools the writer deliberately lacks.
`docs/topics.md` states the intent explicitly for one of them: `delete_topic` is
"Interface-agent only (not in the shared `buildTopicTools`, so the
writer/research agents cannot delete)".

### The consequence: the shared tool prefix already exists, for free

Because the writer's 5 tools are already a byte-identical prefix of the
interface's 16, the tools-level sharing this task asks for is already
structurally available with **no code change**:

- The writer sets its breakpoint on its last tool, `update_topic`
  (`markLastTool` in `run.ts`, 1h TTL). That **writes** an entry hashed at
  `[tools 1..5]`.
- The interface sets its breakpoint on its last tool, `view_attachment`, hashing
  `[tools 1..16]`. Per contract fact 3, on a miss the interface's request walks
  backward one block at a time looking for prior writes. `[tools 1..5]` is 11
  positions back from `[tools 1..16]`, inside the 20-block window (fact 4).

So an interface call can already read the writer's 5-tool prefix. The sharing is
one-directional (interface reads what the writer wrote, never the reverse, since
the walk only goes backward), and it is worth a fraction of a head that is worth
0.9% of a turn. **There is nothing to implement here.**

### Extending the shared prefix past `tools` is impossible without merging the agents

Per contract facts 1 and 2, `system` is the next level. `interfaceSystemPrompt`
and `writerSystemPrompt` (`agents/prompts.ts`) are entirely different text with
different contracts: one is a conversational assistant with a pinned-topics
tail, the other is a consolidation policy. Sharing past `tools` requires one
system text for both, which means one agent, which deletes the two-phase design
described in `docs/topics.md`. That is a different (and much larger) task, and
it is not justified by $0.002.

Past `system` there is nothing at all: the interface sends the conversation
history, the writer sends a single prompt containing the turn transcript. No
shared bytes exist, by construction.

### Alternatives considered and rejected

- **Reorder tools so more of the interface's array is shared.** Already maximal.
  The writer's array is already the interface's exact leading prefix. No
  reordering can extend a 5-tool overlap into a 16-tool one.
- **Give the writer the 11 interface tools but instruct it never to call them.**
  See Safety below. Also useless: it buys only the tools segment, whose size is
  unknown (see R2), and `system` still diverges immediately after.
- **Trim the interface to the writer's 5 tools.** Removes `reply`. The interface
  agent could not speak to the user. Non-starter.
- **Spend an extra interface breakpoint at the `update_topic` boundary** so the
  interface also *writes* there. The interface already spends all 4 breakpoints
  (tools, system, cross-turn anchor, loop-owned sliding tail, per
  `docs/caching.md`). The only droppable one is the cross-turn anchor, whose
  measured value is a **4,015-token cross-turn read every turn**
  (`docs/caching.md`, tier 3). Trading a 4,015-token/turn read for a
  ≤1,626-token one is a net loss of roughly 2.4k read tokens per turn. Rejected
  on arithmetic.

## Safety: what byte-identical tool arrays would actually cost

To make the two arrays byte-identical you must add the interface's 11 tools to
the writer (the reverse direction guts the interface). Each addition is a real
regression:

- **`reply`** lets the writer send Telegram messages. The writer runs *after*
  the user's reply has been delivered (`orchestrator.ts` `runTurn`,
  `docs/topics.md`). A writer `reply` call is a user-visible stray message from
  a phase the user is not waiting on, and it bypasses the interface's
  persist-before-send delivery contract and the `replies`/`decideFinalDelivery`
  logic entirely.
- **`research`** lets the consolidation pass spawn a nested research agent with
  a 40-step cap and web search. The entire point of `131a7f0` and `00759b8` was
  bounding research cost and latency; putting it in the post-reply tail
  reintroduces the unbounded case in the phase with no user-facing timer.
- **`gmail_search` / `gmail_thread` / `gmail_send`** give the writer read access
  to the user's mail and, worse, the ability to send mail from a consolidation
  pass whose input is an LLM-generated transcript.
- **`calendar_create_event`** lets the writer mutate the user's calendar.
- **`set_timezone`** lets the writer mutate user settings.
- **`view_attachment`** pulls base64 image payloads into the writer's context,
  which the transcript renderer deliberately redacts today
  (`renderToolResult` in `interface.ts`).
- **`delete_topic`** is documented as interface-only precisely so the writer
  cannot delete (`docs/topics.md`).

"Present but never called" is not a mitigation. Tool presence is what the model
sees and what it chooses from, and several of these descriptions actively
solicit use (`research`: "Use proactively whenever the user mentions a
researchable subject"). The only enforceable guarantee that the writer cannot
send a Telegram message or an email is that those tools are absent from its
array. Removing that guarantee for a $0.002/turn ceiling is a bad trade at any
plausible traffic level.

## RECOMMENDATION: drop the task

Three independent reasons, any one of which is sufficient:

1. **Arithmetic.** Ceiling saving $0.00195 on a $0.21726 turn (0.90%); realistic
   saving $0.00, because the head is already read at 0.1x with `write=0` and
   sharing does not make reads free.
2. **Already done.** The writer's tool array is already a byte-identical prefix
   of the interface's, so whatever tools-level sharing Anthropic's backward
   lookback permits is already available with zero code.
3. **Safety.** The only way to a longer shared prefix hands the writer `reply`,
   `research`, Gmail send and calendar write, and the only way past `tools`
   merges the two system prompts and therefore the two agents.

This confirms and refines the earlier finding recorded in
`docs/plans/agent-prompt-caching.md` (commit `c9b443a`). That plan rejected the
shared prefix on the tools-hash argument and a ~1,727-token head. This plan adds
the two facts that were missing: the head is **already cached at read price with
no writes**, so the shared prefix would save nothing even if it were free to
build; and the toolset asymmetry runs opposite to what the task assumed, so the
safety cost lands on the writer, not the interface.

**Actions to take: none in code.** Optionally, add a line to `docs/caching.md`
pointing at this file, so the next person who has this idea finds the arithmetic
instead of re-deriving it. That is a one-line docs edit, no changelog entry
(purely internal, no user-visible behavior).

## What would change this answer

Record these so a future revisit is cheap:

- **Writer traffic grows by ~1000x.** At the ceiling, the saving is $0.00195 per
  turn. It reaches $1/day only at ~500 turns/day, and that is the unreachable
  ceiling, not the realistic $0.00.
- **The writer's head grows a lot** (many more tools, or a much longer
  `writerSystemPrompt`). At 1,626 tokens the head is 3.2% of the writer phase.
  It would need to be an order of magnitude larger to matter, and even then the
  fix would be trimming it, not sharing it.
- **Anthropic changes read pricing to something near base input.** Today reads
  are 0.1x, which is what makes the head cheap enough to ignore.
- **Someone wants writer cost down for real.** Then target the 96.8% this task
  does not touch: 30% is output (the 946-token consolidation), 67% is the
  transcript and tool-loop message region. The existing levers are
  `MAX_TOOL_RESULT_CHARS` / `MAX_RESEARCH_RESULT_CHARS` in `interface.ts`, and
  skipping the writer on trivial turns. That is a different task, and it needs a
  captured `writer_completed` log line first (see the missing read/write split
  above).

## Risks (recorded in case someone implements this anyway)

- **R1 — losing the cross-turn anchor.** Any scheme that needs a fourth
  interface breakpoint must drop one, and the only candidate is the cross-turn
  history anchor worth a measured 4,015-token read per turn. Net loss.
- **R2 — the tools-only segment may be below the 1,024-token minimum.** The
  1,626-token figure in `docs/caching.md` is `tools` + `system` combined; **the
  tools-only token count does not exist in any artifact in this repo.** If the
  tools segment alone is under 1,024 tokens, any tools-only shared cache entry
  is silently not cached at all, with no error (contract fact 6). A shared-prefix
  scheme could therefore deliver exactly zero and look like it worked. Anyone
  revisiting this must measure the tools-only size first.
- **R3 — a tool-definition edit invalidates everything.** Per contract fact 2,
  any change to a tool name, description or schema invalidates tools, system and
  messages for every agent. A design that couples the two agents' arrays turns
  every interface tool tweak into a writer cache flush too.

## Verification

No code change, so nothing to verify. If the optional `docs/caching.md`
cross-reference is made, it is a docs-only edit.

For the record on how this repo verifies agent-api changes: this box cannot run
`workerd` (see `AGENTS.md`), so `gob run bin/ci` and `bin/e2e-test` cannot run
whole-repo. Per-package checks are the fallback:

```
pnpm --filter @zero/agent-api run test
pnpm --filter @zero/agent-api run lint
pnpm --filter @zero/agent-api run typecheck
```

Prompt caching itself is not observable in unit or e2e tests (the mocks
implement no cache); it is validated in production from the `cache_diagnostic`
and `*_completed` log fields, as `docs/caching.md` describes.

## Skills to use

- None for implementation, since the recommendation is to implement nothing.
- `git-commit` if the optional `docs/caching.md` cross-reference and this plan
  are committed.
