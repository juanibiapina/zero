# Research agent

The interface agent has a `research` tool. Calling it instantiates a second
agent (research-prompted, with read-only topic tools + a `web_search` tool),
runs its own tool loop, and returns a short sourced findings report as the tool
result.

Research is for wider investigation across sources. When the user simply hands
over a web address, the interface agent opens it with its own `read_page` tool
instead of spawning research.

The research agent **gathers and reports**: it casts a wide net with web search
(including opinion sources such as Reddit and Hacker News where the subject
warrants it), reads related topics when they help, and returns a sourced report
as its final message, stopping once further searches stop changing the answer.
It has **no write tools** — the learning agent that runs off the turn path
decides what, if anything, the report leaves in the knowledge model: what the
research meant for the user (what they were deciding, what they chose, what they
will do), never the findings themselves, which are public and findable again.
Authoring full topic bodies inside the research loop was the dominant cost
(5-8k output tokens per write, minutes of
wall clock), so removing the write tools is what makes research fast. Measured
on the 2026-07-27 17:51:20Z production research turn, the no-write design ran the
research loop in ~48s over 6 steps (largest single generation 1,115 tokens) and
the whole turn (interface + research, plus the per-turn writer that still ran then) in ~88s for $0.217, against a
pre-fix baseline of ~10+ minutes and $3–4 for the one turn when research authored
bodies in-loop (see `docs/plans/agent-latency-investigation.md` for the sourced
per-call breakdown). The prompt sets no length target — it asks for a short
report and lets the question decide the shape — and the persisted tool result
gives research results a generous 8,000-char ceiling (vs 1,500 chars for every
other tool), so a normal sourced report reaches the interface agent's reply whole
rather than truncated mid-claim. The ceiling was raised to fit the report, not
the report shrunk to fit the ceiling. (The 8,000-char ceiling is code-verified in
`interface.ts`; it has not
yet been observed on a real turn, since the measured report above was only 1,115
tokens.) When the interface passes an existing `topic`, the agent reads it for
context; that topic is merged into the interface's `accessed` set so learning
knows it is relevant.

## Proactive triggering

The interface agent is prompted to call `research` proactively — whenever the
user *mentions* a researchable subject (a company, product, technology, person,
place, or event) or makes a claim worth checking, not only for explicit
questions. It acknowledges first (research adds latency), passes the subject's
existing topic as `topic` when one exists, then references the resulting topic
in a natural reply. A restraint clause bounds triggering (skip chit-chat,
acknowledgements, and anything topics or plain reasoning already cover). The
`research_started` / `research_completed` logs make triggering observable and
tunable; err toward more triggering and tune down from logs.

## The tool contract

- **Input:** `{ prompt, topic? }`. `prompt` is what to research; `topic`
  (optional) names an existing topic the interface already knows is relevant, so
  the agent reads it for context instead of starting cold.
- **Output — a findings report.** The tool returns the agent's final sourced
  report (each claim followed by its inline `Source: <url>`) as the tool result.
  Research writes nothing; after the turn, learning records what the report meant
  for the user, not the report.
- **Accessed.** Topics the research agent **reads** (via `get_topic`) are merged
  into the interface agent's `accessed` set, which is what the turn's
  `accessed_count` log line reports (see `docs/topics.md`).

## One runner, three agents

`apps/agent-api/src/agents/run.ts` is the single agent machine:

```
runAgent({ model, system, prompt, tools, maxSteps }) →
  { text, finishReason, steps, messages, usage, stepUsages }
```

`runAgent` also applies prompt caching: it sends `system` as a text block with a
cache breakpoint and marks the last tool with another, and advances a sliding
breakpoint over the growing message tail before every step, so even the
prompt-only research and learning agents cache their message region within a run
(research previously had none). It returns token counts (`usage`, `stepUsages`).
See [caching.md](./caching.md).

The interface agent, the research agent, and the learning agent are the same
runner with different system prompts and toolsets:

- **Interface agent** (`agents/interface.ts`): tools are the topic tools +
  `research` + `read_page` + Google + attachments. `read_page` is registered here
  too, so a web address the user hands over is opened directly, with no research
  run. There is no `reply` tool: the model's own text blocks are the messages,
  delivered as it writes them. `finishReason` is used only to decide the
  no-silence fallback.
- **Research agent** (spawned by `tools/research.ts`): tools are the read-only
  topic tools (`list_topics`, `get_topic`) + `web_search` + `read_page` (no
  no write tools at all). `web_search` returns snippets;
  `read_page` fetches the full cleaned content of a chosen result's URL on
  demand. It returns a compact sourced findings report as the `research` tool
  result; the tool merges the topics research read into the interface's
  `accessed` set.
- **Learning agent** (`agents/learner.ts`): the topic tools only, run off the
  turn path in LearningDO. See `docs/topics.md`.

The research agent gets its own model from the per-turn factory, tagged
`agent: "research"` in `cf-aig-metadata` (alongside `user_id`), so the AI Gateway
attributes its cost/tokens separately from the interface and learning agents while
keeping per-user attribution. The research loop runs inline in
the turn's DO alarm (no separate alarm). The interface agent uses the shared
step cap `AGENT_MAX_STEPS = 200`; the research agent has its own generous bound
`RESEARCH_MAX_STEPS = 40` (`tools/research.ts`). Both caps are runaway-loop
guards, not expected stopping points: a normal loop finishes in a handful of
steps. Research's bound sits well above the observed 20+ steps of a heavy loop
because hitting the cap returns an empty report; if `finish_reason != "stop"`
with a high step count shows up in logs, revisit it.

The research tool logs `research_started` (`prompt_len`, `has_topic`) and
`research_completed` (`steps`, `finish_reason`, `duration_ms`, `report_len`,
`accessed` — the topics it read, the search rollup below, plus token/cache
counts); the `web_search` tool logs `web_search_completed` and
`web_search_failed`; the `read_page` tool logs `read_page_completed`
(`caller`, `duration_ms`, `content_len`) and `read_page_failed` (`caller`,
`duration_ms`, `error`) the same way. `caller` is `interface` or `research`, so
direct reads and research reads are distinguishable; the address itself is never
logged. No message content is logged (see `log.ts` conventions).

### Search usage

Brave bills per request, and one logical search costs up to 4 of them after
retries, so requests are counted where they are made: **every HTTP attempt to
Brave emits one `brave_request` line**, successes included (`websearch/brave.ts`
is the only code that calls Brave). Fields: `status`, `attempt`, `duration_ms`,
`upstream_ms` (Brave's own `server-timing`), `result_count` on a 200, and Brave's
accounting headers split into their two windows — `rate_limit_sec` /
`rate_limit_month`, `rate_remaining_sec` / `rate_remaining_month`,
`rate_reset_sec` / `rate_reset_month`. A monthly component of `0` means the plan
has no monthly cap, not that it is exhausted. A component is omitted when the
header is missing or unparseable, so no field is ever `NaN`.

`brave_rate_limited` (a retry) and `brave_quota_exhausted` carry the 429 body's
`plan`, `rate_limit`, `rate_current`, `quota_limit`, `quota_current`.
`brave_request_failed` closes a search that gave up, with `attempts` (requests
spent) and `total_duration_ms`.

Per call, `web_search_completed` reports `result_count`, `duration_ms` and
`repeat` (this run already searched this query). Per run, `research_completed`
reports `searches`, `searches_failed`, `searches_empty`, `unique_queries` and
`search_ms_total`. `steps` cannot stand in for these: the loop fans out several
tool calls per step, so steps do not convert into requests.

**No query text is logged.** Every line carries `query_hash` (an 8-hex FNV-1a
digest, `query-hash.ts`) and `query_len` instead, which is enough to spot repeats
and retry storms on a single query without storing content, the same rule
`read_page` follows for addresses.

This exists because on 2026-08-02 the key burned most of a month's credit in a
day and the request count had to be reconstructed by arithmetic from failure logs.
Counting successes is the point.

## Web search port

`apps/agent-api/src/websearch/types.ts` defines the `WebSearch` port and a normalized
`SearchResult` (`{ title, url, snippet }`). Adapters:

- `brave.ts` — `createBraveSearch(apiKey)`, production. Calls the Brave Web
  Search API (`X-Subscription-Token: BRAVE_API_KEY`) and normalizes
  `web.results[]`. The key is on Brave's Search plan at 50 req/s, so a burst of
  `web_search` calls can still trip HTTP 429 (`code: RATE_LIMITED`). The adapter
  retries those transient per-second 429s with bounded backoff driven by
  `x-ratelimit-reset` (Brave sends no `Retry-After`; the header's first CSV
  component is seconds until the per-second window resets, defaulting to ~1s),
  so the model never sees the blip. Only a plan that has a monthly quota can
  exhaust one, and that 429 (`meta.quota_limit > 0 && meta.quota_current >=
  meta.quota_limit`) is not transient and throws immediately; plans with no
  monthly cap report `quota_limit: 0`, which is not exhaustion. Retries are
  capped (`maxRetries`, default 3); a persistent 429 eventually throws and
  `web-search.ts` surfaces it to the model. `sleep`/`maxRetries`/`defaultDelayMs`
  are injectable for tests.
- `memory.ts` — `createMemorySearch(results)`, deterministic canned results for
  tests.

## Page fetch port

`apps/agent-api/src/pagefetch/types.ts` defines the `PageFetcher` port and a
normalized `PageContent` (`{ url, content }`, cleaned markdown). Search stays
snippet-only on Brave; depth is a separate, on-demand `read_page` tool. The
interface agent calls it on an address the user gives; the research agent calls
it for search results it judges important. Adapters:

- `tavily.ts` — `createTavilyFetcher(apiKey, options?)`, production. Normalizes
  the address first (`normalizeWebAddress`): trims it, adds `https://` to
  shorthand like `thing.com/path` and `https:` to `//thing.com/path`, and
  rejects any other scheme or embedded credentials before any HTTP call. Errors
  are generic and never echo the submitted address, which reaches logs. Then
  `POST`s the normalized URL to Tavily's Extract endpoint (`Authorization: Bearer
  TAVILY_API_KEY`) with `extract_depth: "basic"` and `format: "markdown"`,
  normalizes `results[0].raw_content`, and hard-caps the returned content
  (`maxContentChars`, default 8000) with a `…[truncated]` marker so one
  pathological page can't blow the turn's context. An unset key throws
  immediately (no HTTP call); empty results / `failed_results` / non-2xx throw;
  transient 429/5xx get a small bounded retry (`sleep`/`maxRetries`/`delayMs`
  injectable for tests). `read-page.ts` swallows any throw into `{ error }`.
- `memory.ts` — `createMemoryFetcher(byUrl?)`, deterministic canned content for
  tests.

## Upgrade paths

Brave returns snippet descriptions only; `read_page` (Tavily Extract) fills the
gap on demand. The `WebSearch` and `PageFetcher` ports are the swap points:

- Swap to a richer search provider (e.g. Tavily Search) by adding a new
  `WebSearch` adapter; callers depend only on the port.
- Batch page fetch (a list of URLs behind the same `PageFetcher` port) if
  reading several results at once becomes worthwhile.
- `extract_depth: "advanced"` to also pull tables and embedded content, or
  query-reranked chunks (`query` + `chunks_per_source`) to shrink tokens
  further.

## e2e

The e2e mock LLM returns canned text and never issues tool calls, so
`research` never fires in e2e and no real search call is made.
