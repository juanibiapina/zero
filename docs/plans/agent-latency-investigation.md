# Agent latency investigation — Maria's ~15-minute reply

Status: investigation only (no fix). All timestamps UTC unless noted. Date of
incident: 2026-07-27. Investigated live at ~14:38Z, minutes after the incident,
so the AI Gateway logs, ZeroErrors events, and a live `wrangler tail` all still
carried the evidence.

## TL;DR

- **Root cause of the 15-minute wait: Maria's turn spawned a research-agent loop
  that ran ~10+ minutes inline in the DO alarm before her substantive reply.**
  The research loop made ~20+ sequential LLM calls whose context grew to ~92k
  tokens (no compaction), including four single generations of 165s, 155s, 118s,
  and 50s. The user's answer is not sent until the research loop (and then the
  writer) finish.
- **The deploy-churn prior is CONFIRMED as real but RULED OUT as the primary
  cause of this wait.** There were 10 `zero-api` deploys today, aligned 1:1 with
  commit bursts, and most commits touched only non-agent packages
  (cli/ui/dashboard-web/landing/docs) yet still forced a `zero-api` redeploy
  (Workers Builds watch paths = `*`). Four "Durable Object reset because its code
  was updated" events landed in the deploy window. But all four fired at
  `clearBusy` in `runTurn`'s `finally` (after the turn body finished and the
  reply was already persist-before-send delivered), and `findThreadsAwaitingReply`
  ignores `busySince`, so a failed `clearBusy` does not stall later turns. The
  research context grew monotonically 53k→92k with no reset-to-baseline in the
  last ~10 min, proving the loop was not restarted mid-way. Deploy churn cost at
  most a first-attempt restart (~2–5 min) and remains a serious latent risk.

## Who / what

- Maria = Clerk user `user_3Ea4tsHDgKswP3GgO0ITkoJmrKp`, Telegram chat
  `6711171416` (webhook came via Telegram's AMS colo).
- Her message triggered the interface agent's `research` tool on the existing
  topic **"Job Search 2026"** (topic description: "Maria's active job search
  after leaving Sparrow Parts"). Research prompt (from the gateway request body):
  *"Customer Success Manager jobs Berlin or remote Germany 2026, requiring German
  B2-C1 … Prior context: the topic 'Job Search 2026' already covers this
  subject."*

## Measured timeline (AI Gateway logs; times converted GMT+2 → UTC)

Every row is one Anthropic call through the gateway, model `claude-sonnet-4-6`.
"in/out" = context input / generated output tokens; duration is the gateway's
measured latency.

| UTC | in | out | duration | agent (inferred) |
|---|---|---|---|---|
| 14:27:30 | 53,367 | 73 | 2.3s | research (context already large ⇒ loop began earlier, ~14:22–14:24) |
| 14:30:18 | 55,657 | 7,853 | **164.9s** | research (writing a large topic body) |
| 14:30:29 | 63,536 | 377 | 11.2s | research |
| 14:30:32 | 63,939 | 57 | 2.7s | research |
| 14:33:07 | 68,394 | 7,440 | **155.0s** | research (large body write) |
| 14:33:17 | 75,860 | 401 | 9.9s | research |
| 14:33:21 | 76,287 | 75 | 4.2s | research |
| 14:33:34 | 80,760 | 494 | 12.4s | research |
| 14:33:37 | 81,280 | 180 | 3.4s | research |
| 14:33:41 | 81,486 | 160 | 3.6s | research |
| 14:33:47 | 81,672 | 358 | 6.7s | research |
| 14:33:49 | 82,056 | 57 | 1.9s | research |
| 14:35:01 | 3 | 19 | 1.6s | interface (tiny, fully cached) |
| 14:35:04 | 402 | 29 | 3.4s | interface |
| 14:35:08 | 3 | 22 | 1.6s | interface |
| 14:35:10 | 402 | 40 | 2.7s | interface |
| 14:35:47 | 86,511 | 5,803 | **117.5s** | research (large body write) |
| 14:35:58 | 92,340 | 430 | 10.8s | research |
| 14:36:48 | 92,796 | 2,339 | **50.1s** | research |
| 14:36:57 | 2,508 | 453 | 9.5s | interface/writer — **DO reset logged same second** |
| 14:37:22 | 3 | 87 | 3.1s | interface (next turn) |
| 14:37:24 | 469 | 29 | 1.8s | interface |
| 14:37:58 | 3 | 35 | 2.5s | interface (healthy turn, live-tail `interface_completed` 2,554ms) |
| 14:38:00 | 427 | 39 | 2.1s | writer (live-tail `writer_completed` 2,119ms) |

Notes:
- The research context climbs monotonically 53k → 92k across the whole visible
  window with **no reset to a ~4k baseline** ⇒ one continuous research loop, not
  repeated full restarts.
- The four big generations alone = 164.9 + 155.0 + 117.5 + 50.1 = **487.5s
  (~8m8s)**; the ~16 smaller research calls add ~90s ⇒ **~9.5 min of LLM time in
  the visible window alone**, before counting the earlier ramp (context was
  already 53k at 14:27:30).
- Cost for this single turn's visible window ≈ **$3–4** (big calls $0.28–0.34
  each).
- A **healthy** turn for the same user completed at 14:37:55 in **~5s total**
  (interface 2,554ms + writer 2,119ms; DO wallTime 4,817ms) — captured live. So
  the pipeline itself is fast; the 15 min is the research loop, not baseline
  latency, model slowness, or a long interface loop.

## Direct evidence

### 1. Deploy churn (confirmed, but see ranking)

- `wrangler versions list` / `deployments list`: **10 `zero-api` deploys on
  2026-07-27** (UTC): 06:49:23, 08:44:08, 10:52:51, 11:07:45, 12:50:16, 13:23:20,
  13:55:12, 14:09:37, 14:17:18, 14:28:35. Tightest cluster: 13:55 → 14:09 → 14:17
  → 14:28 (four deploys in 33 min).
- `git log origin/main` (committer dates are +02:00; deploys are UTC): each
  deploy trails a commit by ~60–120s. e.g. last commit `114d4315` at
  16:27:05+02:00 = 14:27:05Z → deploy 14:28:35Z.
- Most commits do **not** touch `apps/agent-api`: `114d4315`/`fc6452c4`
  (zerovault-cli), `d6ef9cd7`/`53c7c0a1`/`0500b1fe` (dashboard-web),
  `5ceb9d10`/`28d36707`/`0500b1fe` (packages/ui), `03159599` (landing),
  `30c364f1`/`14b1b5c1` (docs). They still forced a `zero-api` rebuild+redeploy
  because the Workers Builds connector watch paths are `*`.

### 2. DO resets (ZeroErrors project `zero-agent`)

`GET https://api.zeroapps.dev/errors/v1/issues?project=zero-agent` (zv_ key).
The **only** errors in the project are DO code-update resets:

- Issue `bee5d136` — "Durable Object reset because its code was updated." count 2,
  first 14:24:09.992Z, last 14:36:57.976Z.
- Issue `7f8b834f` — same title, count 2, first 14:02:58.292Z, last 14:11:02.114Z.
- (Plus one stale 2026-07-24 event.)

Two separate issues with the **same logical stack** but different bundled line
numbers (52227/39541 vs 64535/39393) — each deploy = a new bundle = a new
fingerprint, itself proof multiple distinct builds hit resets. Every event stack
is identical and reported `site: "alarm_turn"`:

```
Error: Durable Object reset because its code was updated.
  at Database.exec / Database.update
  at DbStore.clearBusy
  at SystemTopicStore.clearBusy
  at runTurn (orchestrator)
  at async UserDO.runTurn
  at async runAlarmTurns
  at async UserDO.alarm
```

The reset surfaces at the **first storage syscall after the isolate was torn
down**, which happened to be `clearBusy` — the `finally` step that runs *after*
`runTurn`'s try body (interface + writer) completed. See
`apps/agent-api/src/agents/orchestrator.ts` `runTurn`: `markBusy` → try {
interface; writer } → `finally { clearBusy }`. Replies are persist-before-send
inside the try, so by the time `clearBusy` runs the user's reply is already
delivered and persisted.

### 3. No gateway faults

AI Gateway `zero` overview: last 24h **359 requests, Errors: 0**. No 5xx / 429 /
rate-limiting. Rules out model/gateway errors, retries/backoff, and rate limits
as contributors.

### 4. Busy flag is not an amplifier

`DbStore.findThreadsAwaitingReply` (apps/agent-api/src/store/db.ts:302) selects
threads purely on `tail.role === "user"`; it never reads `busySince`. So a reset
that skips `clearBusy` leaves `busySince` set but does **not** block draining of
that or any other thread. The busy flag did not stall Maria's or the next turn.

### 5. The runaway knobs

- `AGENT_MAX_STEPS = 200` (`apps/agent-api/src/agents/run.ts:38`), shared by the
  research agent (`tools/research.ts` calls `runAgent` with the default
  `maxSteps`). The loop can run up to 200 sequential LLM calls.
- `MAX_TOKENS = 16000` and `REQUEST_TIMEOUT_MS = 300_000`
  (`apps/agent-api/src/agents/model.ts`): a single generation can legitimately
  run up to 5 minutes; the big writes hit 5,803–7,853 output tokens.
- The research loop runs **inline in the turn's DO alarm** (no separate alarm);
  the interface agent's substantive reply follows the research result, and the
  writer runs after that, every turn.

## Root cause (named)

Maria's interface turn called the `research` tool, which spawned the research
agent (`apps/agent-api/src/tools/research.ts` → `agents/run.ts` `runAgent`,
`maxSteps = AGENT_MAX_STEPS = 200`), running inline inside
`agents/orchestrator.ts` `runTurn` → `UserDO.runTurn` → `alarm`. The loop made
~20+ sequential `claude-sonnet-4-6` calls (`agents/model.ts`, `MAX_TOKENS=16000`,
`REQUEST_TIMEOUT_MS=300_000`) whose context was never compacted and grew to ~92k
tokens, with four generations of 165s/155s/118s/50s writing large topic bodies.
End-to-end the loop ran ~10+ minutes before the reply. That wall time, not any
infrastructure fault, is Maria's ~15-minute wait.

## Contributing factors (ranked)

1. **PRIMARY — unbounded/long research loop inline before the reply.** ~10+ min;
   ~8 min in four generations alone. Context balloons to ~92k tokens (no
   compaction / summarization between steps), 200-step cap, 16k `max_tokens`,
   300s per-call timeout. Cost ~$3–4 for the one turn.
2. **SECONDARY — deploy churn → DO isolate resets.** Confirmed real (10 deploys,
   1:1 with commits, most from non-agent packages; 4 resets in-window). Impact on
   *this* reply was limited because all observed resets landed at `clearBusy`
   (post-body, reply already sent) and busy is not a gate. But it plausibly cost
   a first-attempt restart (a reset at 14:24:09 likely aborted an initial attempt
   before the retry ran the loop from ~14:27:30), it wastes money, and it is a
   serious latent risk: **a reset landing mid-research would discard and restart
   the entire ~10-min loop.**
3. **Model latency proportional to context (amplifier of #1).** The 2–3 min calls
   are a function of 55–92k input + 5–8k output, not gateway slowness (0 gateway
   errors/24h).
4. **Writer runs after replies on every turn (structural tail latency).**
   Negligible here (2.1s) but adds to end-to-end time and re-runs are skipped on
   a reset.

## Notes for the fix stage (not implemented here)

Candidate levers, in rough priority: bound the research loop (step/time/token
budget well below 200/300s/∞; compact or cap accumulated context; cap the number
of `read_page`/`web_search` iterations); make research asynchronous from the
user's reply (ack + deliver when done) so a long loop never blocks the turn; and
separately, stop `zero-api` redeploying on commits that don't touch it (scope the
Workers Builds watch paths) and space out pushes to shrink reset blast radius.

---

# Round 2 — structural causes of research slowness + the error Maria sees

Second pass, same incident (2026-07-27), driven from the actual implementation
plus Workers Logs (observability is enabled: `apps/agent-api/wrangler.jsonc`
`observability.enabled=true`) and AI Gateway logs. Round 1 established *where*
the time went; this pass answers *why the design makes it slow* and *what error
Maria received and why*. All evidence is ground truth (gateway logs, Workers
logs with full stacks, ZeroErrors), not inference.

## PART 1 — why the research agent is structurally slow

### The wall-clock is output generation, and we generate topic bodies in the loop

`claude-sonnet-4-6` emits ~48 output tok/s. The three slow calls are all large
generations, and their duration is exactly their output size / 48:

| gateway ts (UTC) | in | out | dur | out/dur |
|---|---|---|---|---|
| 14:30:18 | 55,657 | 7,853 | 164.9s | 47.6 t/s |
| 14:33:07 | 68,394 | 7,440 | 155.0s | 48.0 t/s |
| 14:35:47 | 86,511 | 5,803 | 117.5s | 49.4 t/s |

Those three generations alone = **437s (7.3 min)** and they are the research
agent writing **full topic-body markdown**. The research agent is given topic
**write** tools and told to use them mid-loop:

- Tools handed to research: `buildTopicTools` (list_topics, get_topic,
  create_topic, **update_topic**) + `web_search` + `read_page`
  (`apps/agent-api/src/tools/research.ts:70-72`).
- The prompt orders it to write the whole body in the loop:
  *"Your findings live in the topic you write, not in your final message"* and
  *"create_topic, then fill it with update_topic"*
  (`apps/agent-api/src/agents/prompts.ts`, `researchSystemPrompt`).

So the loop is not "gather and return findings"; it is "gather, then author a
5–8k-token markdown document, in-loop, on a mid-tier model." That authoring is
the single biggest chunk of the wall clock. A writer agent already runs **every
turn** (`orchestrator.ts` `runTurn` → `runWriterAgent`) and already exists to
consolidate accessed topics — research does not need write tools at all.

**Rank #1 — remove topic-write tools from research; return findings as text.**
File: `tools/research.ts:70-72`, `prompts.ts:researchSystemPrompt`.
Quantified win: deletes the 3 body-writes ≈ **7.3 min** off this turn, the
largest single lever. Research returns a sourced summary; the writer (which runs
anyway) persists it.

### Prompt caching is OFF for the research message region (hard evidence)

Caching is wired, but only for the two static prefixes: `run.ts` marks the last
tool (`markLastTool`, 1h) and the system block (`cachedSystem`, 1h). The
interface agent additionally sets **sliding message-region breakpoints**
(`interface.ts` → `markCacheBreakpoint` on the last two messages). The research
agent passes only a `prompt` and **sets no message-region breakpoint**, and the
loop in `run.ts` never adds one as it appends steps.

Ground truth from the `cache_diagnostic` logs across the whole research loop:

```
every research call: cache_read_tokens = 1727 (constant), cache_write_tokens = 0
while gateway input grows 396 → 92,796
```

`read=1727` is only the system+tools prefix; `write=0` means nothing in the
growing 90k message region is ever promoted to cache, so every step reprocesses
the entire conversation uncached. Contrast the interface agent in the same
window: `read=4086 write=1857/3847` — it caches its message region.

**Rank #2 — add a sliding message-region cache breakpoint to the research
loop** (mirror `interface.ts`). File: `run.ts` (loop) / `research.ts` (caller).
Sum of research input across the loop ≈ ~1.6M tokens, nearly all uncached today.
Win: mostly **cost** (~$4–5 of input per long turn drops to ~0.1x on the stable
prefix) plus a modest TTFT gain; prefill is fast, so this is not the main
latency fix but it is the biggest cost fix.

### The search + read tools are failing and inflating the loop

In the 25-min window: **19 `brave_rate_limited`** + **11 `read_page_failed`**
(e.g. `page fetch failed: no content for https://www.stepstone.de/...`). Brave
is on a **1 request/second** plan; each limited search logs `brave_rate_limited`
and sleeps ~1s before retrying (`apps/agent-api/src/websearch/brave.ts:5-7,49,
92-118`). Half the page reads return empty. The agent, getting thin/empty
results, keeps issuing more searches and reads — lengthening the loop without
converging.

**Rank #3 — fix the tool substrate**: a search plan above 1 req/s (or fan-out),
cap `read_page` retries, and cap the number of search/read iterations. Win:
removes the ~19s+ of retry sleeps and, more importantly, the extra steps the
agent spends chasing failed results.

### Searches are effectively sequential

`run.ts:254` DOES run tool calls within one model response in parallel
(`Promise.all`), but the model emits **one** `web_search` per step, so searches
are serialized one-per-LLM-round-trip. Combined with Brave's 1 req/s cap,
effective throughput ≈ 1 search/sec.

**Rank #4 — batch searches** (prompt for multi-search steps or a fan-out search
tool). Win: collapses N sequential search round-trips into a few parallel ones.

### The caps are sized for a batch job, not an interactive assistant

- `AGENT_MAX_STEPS = 200` (`run.ts:38`) — research uses the default, so up to 200
  sequential LLM calls.
- `MAX_TOKENS = 16000` (`model.ts:52`) — permits the 2.5-min single generations.
- `REQUEST_TIMEOUT_MS = 300_000` (`model.ts:57`), `cpu_ms: 300000`
  (`wrangler.jsonc`).

Defensible interactive settings: research `maxSteps` ~12–20; `max_tokens`
~2,000–3,000 (a 3k cap bounds any single generation to ~60s and by itself kills
the 117–165s writes); per-call timeout ~60–90s. **Rank #5.**

### One model for every agent; no faster model wired

`MODEL_ID = "claude-sonnet-4-6"` (`wrangler.jsonc:43`) is the single id used by
interface, research, and writer (`model.ts` `createModelFactory` reads one
`modelId`). `researchModel` only changes the `cf-aig-metadata` agent tag for
attribution — **same model**. Search-and-summarize is a natural fit for a
faster/cheaper model (e.g. Haiku), which also emits tokens faster, directly
shrinking the output-bound wall clock. Nothing cheaper is wired. **Rank #6.**

### Context assembly bloats with no trimming

Research starts each loop from just the short prompt (`cache_diagnostic` shows
the first call at 396 input tokens), but `read_page` dumps full page markdown and
`get_topic` dumps full bodies into the message region, which accumulates
uncached to ~92k with no compaction or trimming. The "53k before it gets going"
in Round 1 was accumulated prior steps, not an initial corpus dump.
**Rank #7 — cap `read_page` output, drop or summarize old tool results between
steps.**

### No streaming

`model.ts` calls `client.beta.messages.create` (non-streaming). A 7,853-token
generation blocks fully (~165s) before anything returns, and the user's reply
waits for the entire `research` tool to return. **Rank #8 — stream + deliver
incrementally** (also decouple research from the reply: ack, then deliver when
done, so a long loop never blocks the turn).

### Why another research agent is ~5x faster than ours

Not the model. Ours spends ~7 of ~12 minutes **generating 21k tokens of
topic-body markdown inside the loop** — self-imposed by giving research write
tools and instructing it to author full bodies — on a mid-tier model
(~48 tok/s), non-streaming, while **every step reprocesses up to ~91k uncached
tokens** (message-region caching off), its search tool is throttled to
**1 req/s**, and ~half its page reads fail so it keeps retrying. A
minute-or-two research agent returns a short **findings summary** (it does not
rewrite the knowledge base), caps output to a few thousand tokens, caches/trims
its growing context, parallelizes searches on a real search plan, and streams.
Every one of our 5x factors is workload we hand the model, not model latency:
Round 1's healthy non-research turn for the same user finished in ~5s.

### Ranked fix leverage (latency unless noted)

1. Strip write tools from research; return findings text — **~7 min** (`research.ts:70-72`, `prompts.ts`).
2. Cap research `max_tokens` to ~3k — bounds any single generation to ~60s (`model.ts:52`).
3. Faster model for research (Haiku) — cuts the output-bound wall clock (`model.ts`/`wrangler.jsonc:43`).
4. Fix search/read substrate + cap iterations — removes retry sleeps and wasted steps (`brave.ts`, `read-page.ts`).
5. Sliding cache breakpoint in the research loop — **cost** ~$4–5/turn, minor latency (`run.ts`).
6. Streaming + research decoupled from the reply — perceived wait (`model.ts`, `research.ts`).
7. Lower `AGENT_MAX_STEPS` / add a research time budget (`run.ts:38`).

## PART 2 — the error Maria sees (root cause, named, with evidence)

### The message

`FALLBACK_MESSAGE = "Sorry, I couldn't finish that one. Could you try again?"`
(`apps/agent-api/src/agents/interface.ts`). It is sent from the orchestrator's
turn-level catch: `orchestrator.ts:119-140` logs `turn_failed` then
`await send(reply)` with `reply = FALLBACK_MESSAGE` (the `RATE_LIMIT_MESSAGE`
branch only fires on 429/529). The other emitter of the same string is
`decideFinalDelivery` inside the interface agent; that path did **not** fire here.

### It fired twice today, both on Maria's chat

Workers Logs, script `zero-api`, entrypoint `UserDO`, eventType `alarm`:

| UTC | log | chat_id | topic_id |
|---|---|---|---|
| 14:24:09.769Z | `turn_failed` (error) | 6711171416 | 0 |
| 14:36:57.976Z | `turn_failed` (error) | 6711171416 | 0 |

Each is immediately followed by `alarm_turn_failed` and a POST to the ZeroErrors
ingest (issue `bee5d136`, count 2, same two timestamps).

### Trigger: a DO isolate reset landing mid-turn, surfacing at the reply's DB write

The captured `turn_failed` error carries the full stack (identical both times):

```
Error: Durable Object reset because its code was updated.
  at Database.exec / Database.insert
  at DbStore.storeMessage
  at SystemTopicStore.storeMessage
  at persistReply            (index.js:52184)
  at runInterfaceAgent
  at async runTurn → runAlarmTurns → UserDO.alarm
```

A deploy's version rollout reset the isolate mid-turn. The reset surfaced at the
**first SQLite write after the isolate was regenerated**, which was
`persistReply` inside `runInterfaceAgent`'s final delivery — i.e. the interface
agent was trying to persist and send its **final research answer**. Because
`persistReply` runs *before* `send` in the delivery path, the real answer was
never persisted or sent. `runTurn`'s catch caught this, logged `turn_failed`,
and sent `FALLBACK_MESSAGE` over Telegram — a **fetch subrequest, unaffected by
the storage-layer reset**, so it went through. That is the message Maria saw.
The catch's own DB writes and the `finally` `clearBusy` then re-threw the same
reset:

```
alarm_turn_failed stack:
  at Database.exec / Database.update
  at DbStore.clearBusy
  at runTurn (index.js:52227) → runAlarmTurns → UserDO.alarm
```

That `clearBusy` throw is the error propagated to `reportError` and recorded in
ZeroErrors.

### Corrects Round 1

Round 1 concluded the resets all landed at `clearBusy` *after* the reply was
delivered, so "no user-facing error." Ground truth: the reset **first** surfaced
at `persistReply` during the interface agent's final-answer delivery (before the
real answer was persisted/sent). Both stacks come from the same reset —
`turn_failed` at `persistReply`, `alarm_turn_failed` at `clearBusy` — and the
`persistReply` one is exactly why Maria got a fallback instead of her answer.

### Ruled out, with evidence

- **Rate limit / usage cap** (`RATE_LIMIT_MESSAGE`): **0** gateway 429/529 on
  2026-07-27 (checked 550+ logs). The only 429s were 2026-07-24 (7, at
  16:27–16:28Z). `isRateLimitError` → false, so the rate-limit message did not
  fire.
- **LLM error / refusal / max_tokens**: every gateway call in the window is
  `status=200 success=true`; `out=7853 < 16000` (no truncation).
- **Research step-cap exhaustion**: `research_completed` logged normally on both
  turns; the interface `finishReason` fallback path was not the trigger.
- **Telegram send failure**: the FALLBACK send succeeded (Maria received it); the
  failures were SQLite writes on the reset isolate.
- **Alarm giving up**: it did not — it retried. Turn 1's reset at 14:24:09
  immediately re-armed and re-ran (`turn_started` 14:24:13 → `research_started`
  14:24:18), which is the entire second ~10-min research loop.

### Part 1 ↔ Part 2 connection

The reset is a deploy artifact, but the **long research loop is what makes it
hit and hurt, and repeat**. Turn 2 ran research 14:26→14:36; a deploy during
that 10-min window reset the isolate, and the reset only surfaced at 14:36:57
when the turn finally wrote to storage — after burning ~10 min and ~$3. Because
the reset aborts *before* the answer is persisted, the alarm retries the **whole
research loop from scratch** (that is precisely how turn 1's 14:24:09 reset
spawned the second 10-min loop). So: long loop → wide window for a deploy reset →
reset aborts pre-persist → user gets FALLBACK instead of the answer **and** pays
for the loop twice. Shrinking the research loop (Part 1) directly shrinks the
probability and cost of this error (Part 2).

### Obvious fix directions (not implemented here)

- Persist-and-send the interface agent's final answer the same way live replies
  are (persist behind the output gate) so a reset cannot land between "compose"
  and "deliver," and/or make the final delivery idempotent on retry.
- Cut the mid-turn reset window at the source: scope the `zero-api` Workers
  Builds watch paths so non-agent commits don't redeploy it, and space out
  pushes (Round 1 finding).
- Make research asynchronous from the reply and bounded (Part 1), so a 10-min
  loop is neither on the critical path nor a 10-min reset target.

---

# Post-fix measurement: the 2026-07-27 17:51:20Z research turn

Added 2026-07-27, after the four pipeline commits shipped (131a7f0 strip write
tools from research; c9b443a loop-owned sliding message-region cache breakpoint;
69452b1 typing stops when the reply is sent; 00759b8 the 8,000-char research
transcript ceiling). This is the ground-truth speedup number for the no-write
research design, so it has a home in the repo instead of living only in a plan.

**Source.** Cloudflare AI Gateway `zero`, Logs tab, read live at ~20:43Z the
same day (well inside the 24h log window). The turn is 13 gateway calls, all
`claude-sonnet-4-6`, `status=success`, spanning 19:51:24–19:52:49 GMT+2
(= 17:51:24–17:52:49 UTC), bracketed by large idle gaps on both sides (prior
call 16:37:58 GMT+2, next 19:58:03 GMT+2), so the 13 are one turn. Each call's
agent was read from the gateway's `Metadata Value` filter on the
`cf-aig-metadata` agent tag (`interface` = 3, `research` = 6, `writer` = 4); the
research call at 17:52:15 shows the research prompt in its request body ("Where
is 'The Odyssey' (2026 Christopher Nolan film) playing in Berlin…").

The gateway's row timestamp is the call **completion** time, not its start: the
first call (17:51:24, 3,103 ms) then started at ~17:51:20.9Z, which matches the
webhook's 17:51:20Z turn start exactly, and the last call (17:52:49) completes
at 17:52:49Z. Phase spans below are computed on that basis (first call start →
last call completion).

Per-call (times UTC; `in`/`out` = uncached input / generated output tokens;
`cost`/`duration` are the gateway's own figures, cost including cache-write and
cached-read, so it is not proportional to `out`):

| UTC | agent | in | out | cost (USD) | duration |
|---|---|---|---|---|---|
| 17:51:24 | interface | 3 | 68 | 0.03468525 | 3,103 ms |
| 17:51:27 | interface | 1 | 93 | 0.00367365 | 2,469 ms |
| 17:51:30 | research | 3 | 121 | 0.01055700 | 2,639 ms |
| 17:51:34 | research | 1 | 140 | 0.02360685 | 2,716 ms |
| 17:51:41 | research | 1 | 106 | 0.01866645 | 3,468 ms |
| 17:51:48 | research | 1 | 123 | 0.02030205 | 4,830 ms |
| 17:51:53 | research | 1 | 110 | 0.00905640 | 3,944 ms |
| 17:52:15 | research | 1 | **1,115** | 0.02490630 | 21,691 ms |
| 17:52:21 | interface | 1 | 302 | 0.01108230 | 6,122 ms |
| 17:52:23 | writer | 3 | 37 | 0.01544250 | 1,494 ms |
| 17:52:30 | writer | 1 | 140 | 0.02075880 | 6,721 ms |
| 17:52:47 | writer | 1 | 946 | 0.01712835 | 16,798 ms |
| 17:52:49 | writer | 1 | 92 | 0.00739035 | 2,556 ms |

Confirmed figures (all re-pulled from the gateway; none are inferred):

- **Research loop: ~48s over 6 steps.** The 6 `research` calls run 17:51:27.4Z
  (first call start) → 17:52:15.0Z (last call completion) = 47.6s. The final
  step is the report generation (1,115 out, 21.7s).
- **Largest single generation: 1,115 tokens** (the research report, 17:52:15).
  Next largest is the writer's 946-token consolidation.
- **Whole turn: ~88s** (interface + research + writer), 17:51:20.9Z →
  17:52:49.0Z = 88.1s.
- **Turn cost: $0.217** (sum of the 13 rows = $0.21726).

Against the pre-fix baseline from the incident above (research authoring full
topic bodies in-loop: ~10+ min research loop, ~$3–4 for the one turn), the
no-write design cut this research turn to ~88s end to end and ~$0.22.

Not measured here: the 8,000-char research transcript ceiling (00759b8) was
**not** exercised: this report is 1,115 tokens, well under the ceiling, so no
post-fix turn has yet sent a >1,500-char report through it whole. The ceiling is
code-verified only (see `docs/research.md`, `docs/topics.md`).
