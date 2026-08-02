# Plan: make Brave search usage observable

## Why

On 2026-08-02 the Brave key hit 50% then 75% of the plan's $5 monthly credit
within a day of going live, and **nothing in the codebase could answer "how many
searches did we make"**. The number had to be reconstructed from failure logs and
arithmetic:

- `brave.ts` logs only `brave_rate_limited` (a retry) and `brave_quota_exhausted`.
  A successful search writes no log at all.
- `web-search.ts` logs only `web_search_failed`.
- `research_completed` logs `steps`, which is model steps, not tool calls. The
  research agent fires 5-8 tool calls per step, so steps cannot be converted into
  request counts.

What the reconstruction produced for 2026-08-02: 799 retry requests, 333 searches
that hit at least one 429, 46 searches that died after 4 attempts, 19 research
runs, 603 research page reads. Brave's dashboard said 885 requests. Cross-checking
those numbers is what proved Brave bills 200s only and that ~885 successful
searches were issued, i.e. ~46 per research run. None of that should require
arithmetic; it should be one log query.

Facts worth keeping from that incident, because they shape the fields below:

- Brave's own accounting is returned on **every response** in
  `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` and
  `x-ratelimit-policy`. Each is a two-component CSV: per-second window first,
  monthly window second. On the paid Search plan the monthly component is `0`
  (no cap): `x-ratelimit-limit: 50, 0`, `x-ratelimit-policy: 50;w=1, 0;w=2678400`.
  On the old free plan the second component was the real 2000/month counter.
  Logging `remaining` gives Brave's own count instead of ours.
- Responses also carry `server-timing: search-roundtrip;dur=549.911`, Brave's own
  upstream latency, separable from our wall clock.
- There is no request id header.
- Brave enforces 50 req/s on the Search plan. Bursts of parallel `web_search`
  calls in one research step still trip 429 (`code: RATE_LIMITED`), which the
  adapter retries up to 3 times, so one logical search can cost 4 requests.
- All Brave traffic comes from the research agent. The interface agent has
  `read_page` but not `web_search`, and `read_page` goes to Tavily, not Brave.

This plan adds observability only. It changes no retry, budget or step-limit
behaviour; capping search volume is a separate change and should be decided from
the data this one produces.

## Constraint: no query text in logs

`apps/agent-api/src/log.ts` states the convention: "no message content, tool
results, or request bodies in fields". `read-page.ts` follows it explicitly
("Neither the address nor the page content is logged"). A search query is derived
from the user's message and can carry personal detail, so **the raw query must not
be logged**.

Log instead a **`query_hash`**: a short, stable, non-reversible digest (e.g. FNV-1a
over the lowercased trimmed query, rendered as 8 hex chars, computed
synchronously — `crypto.subtle` is async and not worth the await here). That
supports every question that matters (repeat queries, retry storms on one query,
per-run duplication) without storing content. Also log `query_len`.

## What to change

### 1. `apps/agent-api/src/websearch/brave.ts` — transport facts

Log **one line per HTTP attempt**, success included. This is the only place that
talks to Brave, so it is the single source of request counts.

`brave_request` (level info, on every response, including 429s):

- `status`
- `attempt` (0-based, matches the existing `brave_rate_limited` field)
- `duration_ms` — our wall clock around `fetch`
- `upstream_ms` — parsed from `server-timing` `search-roundtrip;dur=`
- `rate_limit_sec`, `rate_limit_month` — from `x-ratelimit-limit`
- `rate_remaining_sec`, `rate_remaining_month` — from `x-ratelimit-remaining`
- `rate_reset_sec`, `rate_reset_month` — from `x-ratelimit-reset`
- `result_count` — on 200 only, number of `web.results` entries after mapping
- `query_hash`, `query_len`

`result_count: 0` is the "search worked but found nothing" case, today invisible
and a plausible driver of the model re-searching in a loop.

Extend the existing lines rather than adding parallel ones:

- `brave_rate_limited` — add `query_hash`, and the 429 body's `meta` fields
  (`plan`, `rate_limit`, `rate_current`, `quota_limit`, `quota_current`). The
  paid plan reports `quota_limit: 0`, which is exactly the value that caused the
  quota-guard bug fixed in 275cbea; logging it makes a repeat visible.
- `brave_quota_exhausted` — add `query_hash`.

Add `brave_request_failed` (level error) on the terminal throw, carrying
`query_hash`, `attempts` (total requests spent), `total_duration_ms`, `status`.
Today a search that burns 4 requests and returns nothing is only visible as a
generic `web_search_failed` string in the tool.

Parsing helpers: one function that splits a two-component CSV header into
`{ sec, month }` numbers, reused for limit/remaining/reset, returning `undefined`
components when the header is missing or unparseable. `resetDelayMs` already
parses the first component and should be expressed in terms of that helper rather
than duplicating the split.

Do not log the timestamp. Workers Logs stamps every event; a hand-rolled field
would only disagree with it.

### 2. `apps/agent-api/src/tools/web-search.ts` — per-call, per-run facts

The adapter cannot see which research run a request belongs to (the `WebSearch`
port is `search(query)` and should stay that way — it is a true-external seam,
see the header comment in `websearch/types.ts`). The tool wrapper can.

- Accept an optional **stats collector** in `WebSearchToolDeps`, following the
  existing `accessed: Set<string>` idiom that `buildTopicTools` already uses for
  topic reads. Shape: `{ calls, failed, empty, durationMs, queries: Set<string> }`
  of query hashes.
- Log `web_search_completed` per call: `query_hash`, `query_len`, `result_count`,
  `duration_ms`, `repeat` (boolean: this hash was already searched in this run).
- Keep `web_search_failed`, adding `query_hash` and `duration_ms`.

`repeat` is the cheapest possible detector of the pathology suspected in the
incident: a loop re-issuing near-identical queries until the step cap.

### 3. `apps/agent-api/src/tools/research.ts` — the per-run rollup

Create the stats collector next to the existing `read` set, pass it into
`buildWebSearchTool`, and extend `research_completed` with:

- `searches` — total `web_search` tool calls
- `searches_failed`
- `searches_empty` — calls that returned zero results
- `unique_queries` — `queries.size`
- `search_ms_total`

This is the line that answers "how many Brave queries did this run cost", which
is what the incident actually needed. `steps` alone cannot answer it and should
stay as it is.

Consider the same rollup for page reads (`read_page` count per run) while the
collector idiom is being added; the incident showed 603 research page reads in a
day with 213 failures, equally invisible per run. Optional, and only if it does
not grow the change much.

## What this makes answerable

Each with a single Workers Logs query (`POST
/accounts/{account}/workers/observability/telemetry/query`, filter on
`$metadata.message`):

- **How many Brave requests today, and how many were billable?** count
  `brave_request`, split by `status`.
- **How much did retries cost?** `brave_request` where `attempt > 0`.
- **Is throttling happening, and how close to the limit are we?**
  `rate_remaining_sec` distribution, and `brave_rate_limited` over time.
- **Is the monthly window being consumed?** `rate_remaining_month` (non-zero only
  on a plan that has a cap; `0` means unlimited, not exhausted).
- **What does one research run cost?** `searches` on `research_completed`.
- **Is the agent searching in circles?** `unique_queries` vs `searches`, and
  `repeat` on `web_search_completed`.
- **Do searches return nothing?** `searches_empty` / `result_count: 0`.
- **Is Brave slow or are we slow?** `upstream_ms` vs `duration_ms`.

Workers Logs retention is short, so add nothing that depends on reading months of
history. For long-run trend, Brave's own dashboard remains the authority; these
logs explain *why* its number moves.

## Tests

`apps/agent-api/src/websearch/brave.test.ts` (extend, it already builds real 200
and 429 fixtures including the paid-plan `quota_limit: 0` body):

- 200 emits one `brave_request` with the parsed rate-limit components, the
  `server-timing` value, and `result_count`.
- A response with missing or malformed rate-limit headers still logs, with those
  fields absent (no `NaN`).
- 429 then 200 emits two `brave_request` lines with `attempt` 0 and 1.
- Terminal failure emits `brave_request_failed` with `attempts` equal to the
  number of fetches performed.
- The same query logged twice produces the same `query_hash`, and a different
  query a different one; no log line contains the query text (assert on the
  serialized fields).

Assert via `vi.spyOn(console, "log" / "error")`, matching how existing tests in
the package capture log lines.

`apps/agent-api/src/tools/research.test.ts`: a run with N searches reports
`searches: N` and `unique_queries` counting distinct queries, using the in-memory
`WebSearch` adapter.

## Docs

- `docs/research.md`: add an Observability section listing the log lines and what
  each answers. It already documents `research_started` / `research_completed` as
  the tuning signal, so this extends that section rather than starting a new
  page.
- `AGENTS.md` "Production Logs" mentions Workers Logs and AI Gateway; add one
  line that Brave search volume is countable from `brave_request`.
- No changelog entry: purely internal observability, nothing a user observes.

## Skills to use

- `tdd` — for the adapter changes; the header-parsing edge cases are exactly what
  a red test should pin first.
- `testing` — deciding what to assert on log lines without over-coupling to field
  order.
- `deep-modules` — keep `WebSearch` at `search(query)`; run context belongs to the
  tool wrapper, not the port.
- `git-commit` — when committing.

## Acceptance criteria

- Every Brave HTTP attempt produces exactly one `brave_request` log line,
  successes included, and no line contains query text.
- `research_completed` reports the run's search count, failures, empties and
  unique queries.
- A single Workers Logs query returns the day's Brave request count, and that
  count is within a few percent of Brave's dashboard for the same window.
- `pnpm --filter @zero/agent-api run test`, `lint` and `typecheck` pass.

## Risks

- **Log volume.** One line per Brave request, ~900/day at the observed peak, is
  negligible against the existing per-turn logging, and `observability` runs at
  full sampling (no `head_sampling_rate` set in `apps/agent-api/wrangler.jsonc`).
- **Hash collisions** are irrelevant at these volumes; an 8-hex FNV-1a digest is
  for grouping, not identity.
- **Scope creep.** Do not add a search budget, change `RESEARCH_MAX_STEPS`, or
  touch retry policy here. Those are behaviour changes and should be justified by
  the data this plan produces, in `docs/plans/` of their own.
