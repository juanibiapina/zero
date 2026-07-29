# Agent latency investigation #2 — Maria's wait is now the writer

Status: investigation only (no fix). Date of incident: 2026-07-29, investigated
same day ~14:30Z. All timestamps UTC. Follow-up to
`docs/plans/agent-latency-investigation.md` (2026-07-27), whose root cause
(research authoring topic bodies in-loop) is **fixed and confirmed fixed**. The
wait moved to a different agent.

## TL;DR

- **Root cause: the writer agent rewrites whole topic bodies every turn, its
  output grows with the body, and it runs inline in the DO alarm before the next
  queued turn can start.** Today the writer produced up to 13,856 output tokens
  in a single 298s generation; the writer tail after a reply grew monotonically
  through the day 5s → 125s → 211s → 252s → **308s**.
- Maria's own reply is fast. Interface + research took 2-26s on most turns,
  107s worst case. What she experiences as a 10-minute wait is her **next**
  message sitting in the queue behind the previous turn's writer.
- **Search is not throttling.** Zero and the local `websearch` CLI use the same
  Brave key and the same provider; Brave's monthly quota is 59% unused and the
  research loop's total non-LLM (tool) time all day was 78s, median 1.8s per
  call. Ruled out.
- **No errors of any kind.** 208 gateway calls today, all HTTP 200. ZeroErrors
  `zero-agent` has no event newer than 2026-07-27.
- **The writer is also where the money goes:** $4.58 of today's $6.68 (69%), and
  2,540s of 3,323s of total LLM time (76%).

## Evidence

All numbers from AI Gateway logs, gateway `zero`, account
`4e04b64af4013414441c59014392bea0`:
`GET /accounts/{acct}/ai-gateway/gateways/zero/logs?per_page=50&page=N&order_by=created_at`
(`per_page` max is 50; 100 returns an error, not an empty page). `created_at` is
the request **end** time — verified by chaining: the 298s writer call logged at
13:41:18 starts at 13:36:20, which is when the preceding writer call ended.
`metadata.agent` tags every call interface / research / writer, so no agent is
inferred.

All 208 calls today are Maria (`user_3Ea4tsHDgKswP3GgO0ITkoJmrKp`):
writer 106, interface 53, research 49.

### 1. The writer's output grows monotonically, and so does its wall time

Every writer generation over 4k output tokens today:

| UTC | output tokens | duration |
|---|---|---|
| 09:23:39 | 5,983 | 117s |
| 10:40:24 | 6,529 | 126s |
| 12:49:32 | 7,133 | 146s |
| 12:58:20 | 7,488 | 153s |
| 13:07:13 | 9,427 | 201s |
| 13:22:09 | 10,088 | 220s |
| 13:26:23 | 10,646 | 229s |
| 13:30:44 | 11,271 | 242s |
| 13:41:18 | 13,856 | **298s** |

This is a topic body being re-emitted in full, a bit larger each turn. (That it
is *one* body is inference, not measurement: there is no topic-inspection route,
so no body size was ever read. An admin task listing each topic's body length
would settle it.) The writer's transcript is **not** the cause and was checked:
`runAgent` returns only the messages generated in that run (`agents/run.ts`
returns `generated`, never the caller's history), and the writer's first call of
each run measured 2,089-6,997 input tokens, mean 3,093, flat across all 31 runs
of the day while its output more than doubled. Conversation length is not a
factor; body size is.
`MAX_TOKENS` is 16,000 (`agents/model.ts`), so 13,856 is within ~2k of the cap;
past it the body is silently truncated mid-document.

### 2. Per-turn split: reply is fast, writer tail is not

"reply after" = interface start to last interface/research call end (what Maria
waits for). "writer tail" = reply to last writer call end (what the *next*
message waits for).

| turn start | reply after | writer tail | cost |
|---|---|---|---|
| 12:46:45 | 20s | 151s | $0.277 |
| 12:55:28 | 12s | 165s | $0.264 |
| 13:02:03 | 107s | 211s | $0.573 |
| 13:18:06 | 14s | 235s | $0.330 |
| 13:22:16 | 11s | 241s | $0.340 |
| 13:26:29 | 9s | 252s | $0.354 |
| 13:34:35 | 103s | **308s** | $0.686 |
| 13:41:26 | 100s | 5s | $0.330 |

### 3. The queueing is visible

At 13:22:16, 13:26:29 and 13:41:26 the next turn's first interface call starts
in the same second the previous turn's last writer call ends — the message was
already waiting. Maria's worst observed round trip: her reply landed 13:36:18,
her follow-up could not start until 13:41:26 (writer), and answered 13:43:06 —
**6m48s of which 5m8s was writer tail she had no visibility into**. Three
consecutive turns 13:18 → 13:22 → 13:26 → 13:30 sat ~4 minutes apart for the
same reason.

Why queueing happens: `runAlarmTurns` drains threads with a serial
`await runTurn(...)` (`apps/agent-api/src/do/alarm.ts:58`), and one DO runs one
alarm at a time, so a new message enqueued during a turn waits for that turn —
writer included — to finish.

### 4. Search: same provider, same key, not throttling

- Zero searches with Brave (`apps/agent-api/src/websearch/brave.ts`) and fetches
  pages with Tavily (`apps/agent-api/src/pagefetch/tavily.ts`). The local
  `websearch` CLI defaults to Brave too, and its `extract` is local (no API).
  Same provider, not different ones.
- The keys are **byte-identical**: the vault values `zero-api/production`
  `BRAVE_API_KEY` and `TAVILY_API_KEY` both equal the shell env vars on the dev
  box. So local CLI use does share Zero's Brave 1-req/s window, but see below.
- Live Brave headers on that key: `x-ratelimit-limit: 1, 2000`,
  `x-ratelimit-remaining: 0, 819` — the per-second bucket, and 819 of 2,000
  monthly requests left. Not quota-exhausted.
- Measured tool time between consecutive research LLM calls today: 43 gaps,
  **78.1s total**, median 1.8s, max 5.1s. A 429 retry sleeps ≥1s
  (`brave.ts` `resetDelayMs`), so at most a handful happened; it is noise against
  a 308s writer.

### 5. No faults

208/208 calls HTTP 200. ZeroErrors project `zero-agent`: three issues, all
"Durable Object reset because its code was updated", newest event
2026-07-27T14:36:57Z — nothing today. Prompt caching is working (69% of input
tokens served from cache), though every big writer call also writes 10-27k
tokens of fresh cache because the rewritten body invalidates the prefix.

## Root cause (named)

`writerSystemPrompt` (`apps/agent-api/src/agents/prompts.ts:241`) instructs the
writer to read a topic, merge new facts, append a Log line, and "never rewrite or
compact the whole document", then write it back with `update_topic`. But
`update_topic` (`apps/agent-api/src/tools/topics.ts:82`, `body` = full markdown)
has no partial/append mode: preserving the document means **re-emitting every
byte of it as generated tokens on every turn that touches it**. Output tokens and
latency therefore grow linearly with topic size, without bound, forever. It is
run unconditionally on every turn by `runTurn`
(`apps/agent-api/src/agents/orchestrator.ts:122`), inline in the DO alarm, and
turns drain serially at `apps/agent-api/src/do/alarm.ts:58`, so that growing wall
time becomes the next message's queue delay.

The 2026-07-27 fix removed the write tools from the research agent, which
correctly took ~10 minutes out of the reply path. It did not remove the
full-body-rewrite cost, it relocated it to the writer — and the writer now also
persists research findings "verbatim, keeping each claim with its source URL",
which is what makes the body grow so fast.

## Contributing factors (ranked)

1. **PRIMARY — full-body rewrite per turn in the writer.** 5,983 → 13,856 output
   tokens over one day, 117s → 298s. Unbounded: it gets worse every turn.
2. **Writer runs inline before the next turn can start.** Turns are serial per
   DO, so writer tail is invisible latency charged to the *next* message. The
   user sees no typing indicator during it (`stopTyping` fires before the
   writer), so it reads as the bot ignoring her.
3. **Approaching `MAX_TOKENS`.** 13,856 of 16,000. Correctness risk (truncated
   body), not just latency.
4. **Cache churn.** A rewritten body invalidates the cached prefix, so each big
   writer call re-writes 10-27k cache tokens at 1.25x.
5. **Not causes:** search throttling, gateway/model errors, deploy churn (no DO
   resets today), key mismatch between Zero and the CLI.

## Cost split (modelled at list prices, reproduces the gateway total to the cent)

| line | tokens | cost |
|---|---|---|
| cache write | 631,724 | $2.37 (52%) |
| output | 127,834 | $1.92 (42%) |
| cache read | 949,470 | $0.28 (6%) |
| fresh input | 168 | $0.00 |

Cache write leading is the same bug seen from another angle: a full-body write
changes the message list, so the next step re-writes the whole grown prefix into
cache. Incremental writes shrink that line too. Reads are 6%, so optimising
`get_topic` (an outline instead of the whole body) would be optimising the
cheapest line — deliberately left alone.

## Candidate levers (for `plan`, not decided here)

Move the writer off the reply/queue path (own alarm, or skip when a message is
already waiting); give topics an append/patch write so the Log line costs a Log
line; cap body size and split or archive at a threshold; cap writer output well
below 16k; stop persisting research reports verbatim into the main body.
