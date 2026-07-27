# Research agent

The interface agent has a `research` tool. Calling it instantiates a second
agent (research-prompted, with the topic tools + a `web_search` tool), runs its
own tool loop, and returns the topic it wrote plus a sourced summary as the tool
result.

The research agent is topic-capable: it reads related topics for context,
investigates with web search, and writes its findings **directly to a topic**
(new or updated) rather than only returning prose. Writing findings at the
source keeps references verbatim — the producer stores them, so there is no
lossy hop (interface reply, writer consolidation) between production and
persistence. Repeated research on a subject updates one topic instead of
spawning duplicates: the agent reads the existing topic (passed in by the
interface as `topic`, or found via `list_topics`) and merges into it, following
the same read-before-write dedup policy as the writer.

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
  the agent reads and updates it instead of starting cold.
- **Output — always a topic.** The tool returns a handle naming the topic it
  wrote plus the agent's final sourced summary. If the agent finished without
  writing a topic, the tool deterministically creates a fallback topic from
  `prompt` with the agent's final text as the body (a safety net mirroring the
  interface's no-silence fallback).
- **Accessed.** Topics the research agent writes are merged into the interface
  agent's `accessed` set, so the writer consolidates them like any other
  accessed topic (see `docs/topics.md`).

## One runner, three agents

`apps/agent-api/src/agents/run.ts` is the single agent machine:

```
runAgent({ model, system, prompt, tools, maxSteps }) →
  { text, finishReason, steps, messages, usage, stepUsages }
```

`runAgent` also applies prompt caching: it sends `system` as a text block with a
cache breakpoint and marks the last tool with another, and returns token counts
(`usage`, `stepUsages`). See [caching.md](./caching.md).

The interface agent, the research agent, and the writer agent are the same
runner with different system prompts and toolsets:

- **Interface agent** (`agents/interface.ts`): tools are the topic tools +
  `reply` + `research`. Its output is the `{ replies, accessed }` collected by
  the tool closures; the runner's `text` and `finishReason` are used only to
  decide the no-silence fallback (deliver prose the model forgot to `reply`, or
  send a generic fallback when the loop hit the cap without a final answer).
- **Research agent** (spawned by `tools/research.ts`): tools are the topic tools
  + `web_search` + `read_page` (no `reply`). `web_search` returns snippets;
  `read_page` fetches the full cleaned content of a chosen result's URL on
  demand. It writes its findings into a topic and returns
  the topic handle + summary as the `research` tool result. The tool guarantees
  a topic is returned (fallback topic when the agent wrote none) and merges
  written topics into the interface's `accessed` set.
- **Writer agent** (`agents/writer.ts`): the topic tools only. See
  `docs/topics.md`.

The research agent gets its own model from the per-turn factory, tagged
`agent: "research"` in `cf-aig-metadata` (alongside `user_id`), so the AI Gateway
attributes its cost/tokens separately from the interface and writer agents while
keeping per-user attribution. The research loop runs inline in
the turn's DO alarm (no separate alarm). Both agents share one step cap,
`AGENT_MAX_STEPS = 200` (`agents/run.ts`). The cap is a runaway-loop guard, not
an expected stopping point: a normal loop finishes in a handful of steps. 200
gives headroom while bounding pathological loops; if `finish_reason != "stop"`
with a high step count shows up in logs, lower it.

The research tool logs `research_started` (`prompt_len`, `has_topic`) and
`research_completed` (`steps`, `finish_reason`, `duration_ms`, `result_len`,
`topics` — the names it wrote, plus token/cache counts); the `web_search` tool
logs `web_search_failed` (`error`) where search errors are otherwise swallowed
into the tool result; the `read_page` tool logs `read_page_failed` (`error`) the
same way. No message content is logged (see `log.ts` conventions).

## Web search port

`apps/agent-api/src/websearch/types.ts` defines the `WebSearch` port and a normalized
`SearchResult` (`{ title, url, snippet }`). Adapters:

- `brave.ts` — `createBraveSearch(apiKey)`, production. Calls the Brave Web
  Search API (`X-Subscription-Token: BRAVE_API_KEY`) and normalizes
  `web.results[]`. Brave's free tier is 1 req/s, so bursts of `web_search`
  calls trip HTTP 429 (`code: RATE_LIMITED`). The adapter retries those
  transient per-second 429s with bounded backoff driven by `x-ratelimit-reset`
  (Brave sends no `Retry-After`; the header's first CSV component is seconds
  until the 1-req/s window resets, defaulting to ~1s), so the model never sees
  the blip. A 429 from monthly-quota exhaustion (`meta.quota_current >=
  meta.quota_limit`) is not transient and throws immediately. Retries are
  capped (`maxRetries`, default 3); a persistent 429 eventually throws and
  `web-search.ts` surfaces it to the model. `sleep`/`maxRetries`/`defaultDelayMs`
  are injectable for tests.
- `memory.ts` — `createMemorySearch(results)`, deterministic canned results for
  tests.

## Page fetch port

`apps/agent-api/src/pagefetch/types.ts` defines the `PageFetcher` port and a
normalized `PageContent` (`{ url, content }`, cleaned markdown). Search stays
snippet-only on Brave; depth is a separate, on-demand `read_page` tool the
research agent calls for results it judges important. Adapters:

- `tavily.ts` — `createTavilyFetcher(apiKey, options?)`, production. `POST`s a
  single URL to Tavily's Extract endpoint (`Authorization: Bearer
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

The e2e mock Anthropic returns canned text and never issues tool calls, so
`research` never fires in e2e and no real search call is made.
