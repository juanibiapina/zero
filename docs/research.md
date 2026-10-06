# Web research

The interface agent investigates the web in its own tool loop. Two tools:
`web_search(query)` returns title/url/snippet results, and `read_page(url)`
returns one page as cleaned markdown. There is no separate research agent: until
2026-08-02 a `research` tool spawned a second, research-prompted agent whose
final message came back as the tool result. That hop bought a different prompt
and a read-only toolset, and cost a nested loop, a second step cap, a separate
gateway tag, an opaque single tool result, and a hop of latency before the user
saw anything.

Searching in the turn's own loop means the model can say it is looking, search,
open what it finds, and answer, all as text blocks of one run — the user sees
progress instead of silence. The investigation rules the research prompt used to
carry (cast a wide net, stop once further searches stop changing the answer,
corroborate and prefer primary sources, put a source URL right after each claim,
say what is uncertain) now live in the interface prompt, which is the only place
left that can carry them.

The agent is prompted to search proactively — whenever the user *mentions* a
researchable subject (a company, product, technology, person, place, or event)
or makes a claim worth checking, not only for explicit questions — bounded by a
restraint clause (skip chit-chat and anything topics or plain reasoning already
cover). The `searches` rollup on `interface_completed` makes triggering
observable and tunable; err toward more searching and tune down from logs.

## Cost of the flat loop

Search results and page contents are persisted tool results in the conversation
log, so they are re-sent on every later turn of that conversation until
compaction. The nested agent used to absorb that: only its findings report
reached the log. The backstops are the size-triggered compaction threshold and
the history page cap (`docs/topics.md`); watch `context_rendered.total_tokens`
if conversations start compacting noticeably sooner.

The learner sees those raw results instead of a report, bounded at 2,000 chars
each in its rendered log. Its prompt already tells it to record what the
searching meant for the user, never the findings themselves, which are public
and findable again.

## The agents

Every agent is a Pi Durable session in AssistantDO with its own prompt and tool
set (see [harness.md](./harness.md)):

- **Interface agent** (`zero-interface`): the topic tools + `web_search` +
  `read_page` + Google + files + schedules + mail watch. There is no `reply`
  tool: the model's own text blocks are the messages, delivered as each response
  is committed. A run that passes 200 tool rounds has its further calls blocked,
  a runaway-loop guard rather than an expected stopping point; a searching turn
  normally finishes in a handful of steps.
- **Learning agent** (`zero-learner`): the topic tools only, run off the turn
  path. See `docs/topics.md`.
- **Onboarding agent** (`zero-onboarding`): topic tools + read-only Gmail. See
  `docs/onboarding.md`.

## Observability

`interface_completed` carries the turn's search rollup (`searches`,
`searches_failed`, `searches_empty`, `unique_queries`, `search_ms_total`)
alongside `status`, `reason` and `duration_ms`. Token and cache counts are in
the `AI_USAGE` dataset and the AI Gateway logs.
The `web_search` tool logs `web_search_completed` and `web_search_failed` per
call; `read_page` logs `read_page_completed` (`duration_ms`, `content_len`) and
`read_page_failed` (`duration_ms`, `error`) the same way. The address itself is
never logged, and no message content is logged (see `log.ts` conventions).

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
`repeat` (this turn already searched this query). Per turn,
`interface_completed` reports `searches`, `searches_failed`, `searches_empty`,
`unique_queries` and `search_ms_total`. `steps` cannot stand in for these: the
loop fans out several
tool calls per step, so steps do not convert into requests.

**No query text is logged.** Every line carries `query_hash` (an 8-hex FNV-1a
digest, `query-hash.ts`) and `query_len` instead, which is enough to spot repeats
and retry storms on a single query without storing content, the same rule
`read_page` follows for addresses.

**Paid-key canary and the `cohort` tag.** The paid Brave key is rolled out per
user, gated by the `braveKeyPaid` flag on `user_settings` (see
`docs/plans/brave-paid-canary.md`). AssistantDO picks the key with
`selectBraveKey` (`websearch/brave-key.ts`) and passes a `cohort` of `"paid"` or
`"free"`, which rides on `queryFields` and so tags every Brave log line
(`brave_request`, `brave_rate_limited`, `brave_request_failed`,
`brave_quota_exhausted`). The paid cohort's spend is then a filtered version of
the success count above: count `cohort: "paid"` with `status: 200`. An admin
flips a user's flag live with `PUT /api/admin/users/{userId}/brave-plan`
(`{ "paid": true|false }`), no redeploy; the flag is also shown in the
`GET /api/admin/users/{userId}` detail. A flagged user whose paid key is somehow
missing falls back to the free key, tagged `cohort: "free"`.

This exists because on 2026-08-02 the key burned most of a month's credit in a
day and the request count had to be reconstructed by arithmetic from failure logs.
Counting successes is the point.

## Web search port

`apps/zero-api/src/websearch/types.ts` defines the `WebSearch` port and a normalized
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

`apps/zero-api/src/pagefetch/types.ts` defines the `PageFetcher` port and a
normalized `PageContent` (`{ url, content }`, cleaned markdown). Search stays
snippet-only on Brave; depth is a separate, on-demand `read_page` tool. The
interface agent calls it on an address the user gives and on the search results
it judges important. Adapters:

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
`web_search` never fires in e2e and no real search call is made.
