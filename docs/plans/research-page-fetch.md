# Plan: on-demand page fetch for the research agent

## Goal

Give the research agent **targeted depth on demand** without paying for it on
every search. Web search keeps returning cheap **snippets** by default (breadth),
and a new, separate **page-fetch tool** lets the agent pull the full cleaned
content of a specific result **only when that result matters**. The agent decides
what is worth reading; cost scales with judgement, not with search volume.

This is the design the user decided on. It **supersedes** the two earlier Tavily
plans, both of which folded full-page content into `web_search` itself (either by
switching the search provider to Tavily or by turning on `include_raw_content` on
every search). Those pushed page bodies into every result across a multi-step
loop — expensive and unbounded. This plan keeps search shallow and makes depth an
explicit, per-URL action.

- Search provider stays **Brave**. `web_search` is unchanged (snippets only).
- Depth comes from a **new tool** backed by Tavily's **Extract** endpoint.
- Both capabilities live only on the **research agent**, where `web_search`
  already lives.

## Background (verified against the codebase, 2026-07-22)

- **Web search port** — `apps/agent-api/src/websearch/types.ts`: one interface
  `WebSearch { search(query): Promise<SearchResult[]> }`, `SearchResult =
  { title, url, snippet }`. Production adapter `websearch/brave.ts`
  (`createBraveSearch(apiKey, options?)`), test adapter `websearch/memory.ts`
  (`createMemorySearch(results)`).
- **web_search tool** — `apps/agent-api/src/tools/web-search.ts`:
  `buildWebSearchTool({ search })`, input `{ query }`, returns the `SearchResult[]`
  array straight to the model; catches errors and returns `{ error }` (never
  throws into the loop). This tool is correct as-is and needs no logic change.
- **Research runner** — `apps/agent-api/src/tools/research.ts`:
  `buildResearchTool({ model, store, search, accessed })` assembles the research
  agent's toolset as `{ ...buildTopicTools(...), ...buildWebSearchTool({ search }) }`
  and runs it with `researchSystemPrompt()`. **This is the only place
  `web_search` is registered.** The interface agent (`agents/interface.ts`) does
  **not** get `web_search`; it gets the `research` tool, which spawns this agent.
- **Threading of `search`** — the dependency flows:
  `UserDO.runTurn` (`createBraveSearch(this.env.BRAVE_API_KEY)`,
  `UserDO/index.ts:231`) → `orchestrator.runTurn` (`TurnInput.search`) →
  `interface.ts` (`InterfaceAgentInput.search`) → `buildResearchTool({ search })`.
  Note the DO imports the orchestrator entry via an alias — `import { runTurn as
  orchestrateTurn }` (`UserDO/index.ts:17`) — and calls `orchestrateTurn({...})`
  at line 250; the orchestrator exports it as `runTurn`. The new fetcher
  dependency must be threaded along **exactly this path**.
- **`search` and `google` are REQUIRED, not optional** — on `ResearchToolDeps`
  (`search: WebSearch`), `InterfaceAgentInput` (`search`, `google`), and
  `TurnInput` (`search`, `google`) all three are non-optional fields, and every
  test passes them explicitly (no defaulting). The new `fetcher` follows this
  precedent: **required** on all three interfaces, supplied at every call site.
- **Prompt** — `apps/agent-api/src/agents/prompts.ts`, `researchSystemPrompt()`.
  Its opening line lists the tools ("You have the topic tools (...) and
  web_search.") and its "Investigate:" section drives search behaviour. Both need
  a short edit.
- **Secret plumbing** — `BRAVE_API_KEY` is declared in
  `apps/agent-api/worker-configuration.d.ts` on `Cloudflare.Env` (line 15) and in
  the `ProcessEnv` `Pick<...>` list (line 42). It is **not** in `wrangler.jsonc`
  `vars` (that block holds only non-secret config), so it is a **secret** supplied
  via ZeroVault → `.dev.vars` locally and uploaded to Cloudflare in production.
  `bin/fetch-secrets` downloads the whole `zero-api` project as JSON (no per-key
  edit needed); only the ZeroVault project needs the new key added.
  **`worker-configuration.d.ts` is generated** by `wrangler types`; both the
  `Env` and `ProcessEnv` entries for `BRAVE_API_KEY` were produced by the
  generator reading `.dev.vars`. Do **not** hand-edit it — add the key to
  `.dev.vars` and regenerate (see §6).
- **Changelog** — `apps/agent-api/CHANGELOG.md` is a **flat, dated list**, most
  recent first (`- YYYY-MM-DD: <user-facing change>`), not Keep-a-Changelog.
  Match the existing repo style. This file is bundled and surfaced in-product as
  Zero's read-only "Changelog" topic, so the entry ships to users.

## Tavily Extract API (verified live, 2026-07-22)

Source: `https://docs.tavily.com/documentation/api-reference/endpoint/extract`.

- **Endpoint:** `POST https://api.tavily.com/extract`
- **Auth:** `Authorization: Bearer tvly-YOUR_API_KEY` (same bearer scheme as
  Tavily Search). **Callable from a Cloudflare Worker** with a plain JSON
  `fetch`; the SDKs are optional wrappers.
- **Request body:**
  - `urls` (**required**) — a single URL string **or** an array (max 20).
  - `query` (optional) — user intent; when set, extracted chunks are reranked to
    it and `chunks_per_source` takes effect.
  - `chunks_per_source` (1–5, default 3) — caps chunks (≤500 chars each) and thus
    `raw_content` length; **only active when `query` is provided**.
  - `extract_depth` (`basic` | `advanced`, default `basic`) — `advanced` also
    pulls tables/embedded content, higher latency. **Pricing: `basic` = 1 credit
    per 5 successful URLs; `advanced` = 2 credits per 5 successful URLs.**
  - `format` (`markdown` | `text`, default `markdown`) — `markdown` recommended;
    `text` may increase latency.
  - `timeout` (1.0–60.0s; default 10s basic / 30s advanced), `include_images`,
    `include_favicon`, `include_usage` (all default false).
- **Response:**
  ```jsonc
  {
    "results": [
      { "url": "https://...", "raw_content": "# Title\n\nContent..." }
    ],
    "failed_results": [],       // URLs that could not be extracted
    "response_time": 2.3
  }
  ```
  `raw_content` is the cleaned page as markdown. `include_usage: true` adds credit
  usage (may read 0 until 5 successful extractions accrue).

**Unconfirmed / flag before shipping:** the exact free-tier credit allowance
(prior research cited ~1,000 credits/month) and RPM limits are not restated on
the Extract reference page; confirm on app.tavily.com. Not a blocker: at 1 credit
per 5 basic extractions, and with the agent fetching only results it judges
important, expected volume is low.

## Design decisions

### 1. web_search stays as-is (snippets, Brave)

No change to `websearch/types.ts`, `websearch/brave.ts`, or the `web_search`
tool's logic. Snippets are the intended cheap default. The **only** touch near
search is a one-line note in the tool `description` (optional) and the research
prompt telling the agent that results are snippets and how to go deeper. Brave
remains the search provider; do **not** switch search to Tavily in this task.

### 2. New page-fetch tool — `read_page`

A new tool named **`read_page`** (verb + object; reads clearly in a tool trace
and in the prompt). Input schema: **`{ url: z.string() }`** — **one URL per
call**.

**Why single URL, not a batch:**
- Simpler for the model to reason about and matches `web_search`'s single-input
  shape (`{ query }`).
- Per-call error handling is clean: one URL → one `{ content }` or one
  `{ error }`, with no partial-batch bookkeeping (`failed_results`) leaking to the
  model.
- Tavily bills per 5 successful URLs regardless of batching, so batching saves no
  credits at this volume. Selectivity (the whole point) is enforced by the model
  choosing which single URL to read, and by the loop's step cap.
- A batch tool can be added later behind the same port if a real need appears;
  starting single keeps the surface minimal.

**Backed by a new port** mirroring the `WebSearch` style, so it is unit-testable
with a fake adapter and swappable later. Put it in a new sibling directory
`apps/agent-api/src/pagefetch/` (parallels `websearch/`):

`pagefetch/types.ts`:
```ts
// Page-fetch port (a true-external seam). Callers depend only on this
// interface; a Tavily-Extract adapter serves production and an in-memory
// adapter serves tests.
export interface PageContent {
  url: string;
  content: string;   // cleaned page as markdown, truncated to a hard cap
}

export interface PageFetcher {
  fetch(url: string): Promise<PageContent>;
}
```

`pagefetch/tavily.ts` — `createTavilyFetcher(apiKey, options?)` implementing
`PageFetcher`:
- `POST https://api.tavily.com/extract`, `Authorization: Bearer ${apiKey}`,
  `Content-Type: application/json`, body
  `{ urls: url, extract_depth: "basic", format: "markdown" }`.
  (Default `basic`: cheaper, sufficient for reading article text. `query`/
  `chunks_per_source` omitted in v1 — we want the whole page, not query-reranked
  chunks; leaving `query` out returns full `raw_content`.)
- Normalize: take `results[0].raw_content` → `{ url, content }`. If `results` is
  empty or the URL is in `failed_results`, **throw** (the tool swallows it into
  `{ error }`).
- **Hard char cap** on returned `content` — `maxContentChars`, injectable via
  `options`, default **8000** (roughly a long article; keeps a pathological page
  from blowing the turn's context). Truncate with a `…[truncated]` marker,
  matching the existing `truncateBody` convention in `prompts.ts`.
- **Empty key guard:** if `apiKey` is falsy, `fetch()` throws
  `"page fetch unavailable: TAVILY_API_KEY not configured"` immediately (no HTTP
  call). This makes graceful degradation testable and keeps the tool always
  registered (see §5).
- **Errors:** throw on non-2xx. Optional small bounded retry on 429/5xx with an
  injectable `sleep`/`maxRetries` mirroring `brave.ts`; simpler than Brave (no
  per-second free-tier quirk), so a small fixed backoff is enough. A single retry
  is acceptable for v1; keep the shape injectable.

`pagefetch/memory.ts` — `createMemoryFetcher(byUrl?)`, deterministic canned
content for tests (fake adapter), mirroring `websearch/memory.ts`.

### 3. Wire the tool into the research agent only

- Add `fetcher: PageFetcher` as a **required** field on `ResearchToolDeps`
  (`tools/research.ts`) — matching the required `search`/`google` precedent — and
  include the new tool in the research agent's toolset:
  `{ ...buildTopicTools(...), ...buildWebSearchTool({ search }),
     ...buildReadPageTool({ fetcher }) }`.
- New `apps/agent-api/src/tools/read-page.ts`, `buildReadPageTool({ fetcher })`,
  mirroring `web-search.ts`:
  ```ts
  read_page: tool({
    description:
      "Fetch and read the full cleaned content of a web page by URL. " +
      "web_search returns only short snippets; call read_page on a result's " +
      "url when that result looks important and you need the full text before " +
      "relying on it. Returns the page content as markdown, or { error }.",
    inputSchema: z.object({ url: z.string() }),
    execute: async ({ url }) => {
      try { return await fetcher.fetch(url); }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("read_page_failed", { error: message });
        return { error: message };
      }
    },
  })
  ```
  Log `read_page_failed` on error (mirrors `web_search_failed`); no page content
  or full URL body logged beyond the error message (log.ts conventions).
- **Only the research agent** gets `read_page` — matches where `web_search` lives.
  The interface agent does not get it (it has no `web_search` either; it delegates
  via the `research` tool).
- **Thread `fetcher`** through the same path as `search`:
  `UserDO.runTurn` → `orchestrateTurn` / `orchestrator.runTurn`
  (`TurnInput.fetcher`) → `interface.ts` (`InterfaceAgentInput.fetcher`) →
  `buildResearchTool({ fetcher })`. Add the field as a **required** field on each
  interface with a short comment ("Threaded exactly like `search`"), matching how
  `google` was threaded. Because it is required, **every existing call site must
  pass `fetcher`** or typecheck/test fails (see Test strategy and Files →
  Changed).

### 4. Construct the fetcher in production

In `UserDO.runTurn` (`UserDO/index.ts`), alongside
`const search = createBraveSearch(this.env.BRAVE_API_KEY);` add:
```ts
const fetcher = createTavilyFetcher(this.env.TAVILY_API_KEY);
```
and pass `fetcher` into the `orchestrateTurn({...})` call (line 250; the DO's
alias for the orchestrator's `runTurn`).

### 5. Prompt edit — `researchSystemPrompt()`

Two small edits in `agents/prompts.ts`:

1. Tool list line, currently:
   > "You have the topic tools (list_topics, get_topic, create_topic,
   > update_topic) and web_search."

   becomes (name the new tool and set expectations):
   > "You have the topic tools (list_topics, get_topic, create_topic,
   > update_topic), web_search, and read_page. **web_search returns only short
   > snippets;** when a result looks important or you need to rely on its
   > specifics, call read_page on that result's url to read the full page first.
   > Be selective — read the pages that matter, not every result — to control
   > cost and latency."

2. In the "Investigate:" list, add a bullet reinforcing it:
   > "- Search gives snippets. Before you record a claim that rests on a specific
   >   source, open it with read_page and read the full page; don't rely on a
   >   snippet alone for anything load-bearing."

Keep it short; the existing "corroborate / keep source URLs" guidance still fits.

### 6. Secret — `TAVILY_API_KEY`

- **ZeroVault:** set `TAVILY_API_KEY` in project `zero-api`, **both**
  `development` and `production` environments (see `docs/secrets.md`). No edit to
  `bin/fetch-secrets` (it downloads the whole project).
- **Type generation (do not hand-edit):** `apps/agent-api/worker-configuration.d.ts`
  is **generated by `wrangler types`**, which reads `.dev.vars`. That is how
  `BRAVE_API_KEY` got both its `Cloudflare.Env` entry (line ~15) and its
  `ProcessEnv` `Pick<...>` entry (line ~42). So the correct sequence is:
  1. Add `TAVILY_API_KEY` in ZeroVault (dev + prod).
  2. Run `bin/fetch-secrets` to write `apps/agent-api/.dev.vars` with the new key.
  3. Regenerate types: `pnpm --filter @zero/agent-api exec wrangler types` (or the
     package's `wrangler types` script). This adds `TAVILY_API_KEY` to both `Env`
     and `ProcessEnv` automatically. Commit the regenerated file.
  Only fall back to a hand edit if the generator is unavailable, and then it
  **must match the generator's output byte-for-byte** (same placement in `Env` and
  in the `ProcessEnv` `Pick<...>` list) to avoid drift on the next `wrangler types`.
  Production upload follows the same path as other `zero-api` secrets.
- **Not** in `wrangler.jsonc` `vars` — it is a secret.
- **Graceful degradation:** the tool is **always registered**, but when the key
  is unset the adapter's `fetch()` throws immediately and the tool returns
  `{ error }` (§2 empty-key guard). This keeps the prompt/tool surface identical
  across environments and means a missing key degrades to "read_page reports it's
  unavailable" rather than a crash. In production the key will be set. (Alternative
  considered: conditionally omit the tool when the key is unset — rejected because
  it makes the prompt reference a tool that may not exist and complicates the
  static toolset assembly.)

### 7. Reconcile the earlier plans

- **Delete** `docs/plans/tavily-deep-research.md` (fully superseded: it put
  full-page `raw_content` into every `web_search` result via one tool — the
  opposite of this snippets-plus-on-demand design).
- **Retire** `docs/plans/tavily-research.md`: either delete it or replace its body
  with a one-line pointer ("Superseded by `research-page-fetch.md`: search stays
  snippet-only on Brave; depth is a separate on-demand `read_page` tool backed by
  Tavily Extract."). Recommend replacing with the pointer so the verified Tavily
  facts remain discoverable in git history via this plan. Only **this** design
  stands.

### 8. Docs + changelog (same change)

- **`docs/research.md`:**
  - "Web search port" section — keep Brave as the production search adapter
    returning snippets; note the second seam.
  - Add a short "Page fetch port" note: `pagefetch/types.ts` (`PageFetcher`),
    `tavily.ts` (Tavily Extract adapter, `basic` depth, markdown, 8000-char cap),
    `memory.ts`. The research agent has `read_page` alongside `web_search`; it
    reads full pages on demand for results it judges important.
  - "Upgrade paths" — replace the stale "Add a `fetch_url` tool" bullet (now
    done) with future levers: batch fetch (list of URLs), `extract_depth:
    "advanced"` for tables/embedded content, or query-reranked chunks
    (`query` + `chunks_per_source`) to shrink tokens further.
- **`apps/agent-api/CHANGELOG.md`** (load the `changelog` skill; match the flat
  dated-list style already in the file), one user-facing entry, e.g.:
  > `- 2026-07-22: Research now opens and reads full web pages when a result
  >   matters, not just short snippets, for deeper and better-sourced answers.`

## Files

**New:**
- `apps/agent-api/src/pagefetch/types.ts` — `PageFetcher` port + `PageContent`.
- `apps/agent-api/src/pagefetch/tavily.ts` — `createTavilyFetcher(apiKey, options?)`.
- `apps/agent-api/src/pagefetch/memory.ts` — `createMemoryFetcher(...)` fake.
- `apps/agent-api/src/pagefetch/tavily.test.ts` — adapter test.
- `apps/agent-api/src/tools/read-page.ts` — `buildReadPageTool({ fetcher })`.

**Changed:**
- `apps/agent-api/src/tools/research.ts` — add required `fetcher` dep, register `read_page`.
- `apps/agent-api/src/agents/interface.ts` — add required `fetcher` to `InterfaceAgentInput`, pass to `buildResearchTool`.
- `apps/agent-api/src/agents/orchestrator.ts` — add required `fetcher` to `TurnInput`, thread it.
- `apps/agent-api/src/UserDO/index.ts` — construct `createTavilyFetcher(this.env.TAVILY_API_KEY)` (line 231, beside `createBraveSearch`), pass into the `orchestrateTurn({...})` call (line 250).
- `apps/agent-api/src/agents/prompts.ts` — `researchSystemPrompt()` edits (§5).
- `apps/agent-api/src/tools/research.test.ts` — **required-field fallout:** pass `fetcher: createMemoryFetcher()` at all **3** `buildResearchTool({...})` sites (lines ~49, ~87, ~104); plus the new `read_page` assertions (see Test strategy).
- `apps/agent-api/src/agents/orchestrator.test.ts` — **required-field fallout:** pass `fetcher: createMemoryFetcher()` at all **~8** `runTurn({...})` sites (lines ~34, ~53, ~87, ~118, ~169, ~217, ~259, ~302).
- `apps/agent-api/src/agents/interface.test.ts` — **required-field fallout:** pass `fetcher: createMemoryFetcher()` at every `runInterfaceAgent({...})` site that supplies `search`/`google`. Verified count: **22** `runInterfaceAgent(` call sites, **21** of which construct the input object with `search`/`google` (there is no shared input helper — each is an inline literal). Update all of them; omitting any fails typecheck/test.
- `apps/agent-api/worker-configuration.d.ts` — regenerated by `wrangler types` after `TAVILY_API_KEY` lands in `.dev.vars` (adds it to `Env` + `ProcessEnv`); **not** hand-edited (§6).
- `docs/research.md` — page-fetch port + upgrade paths.
- `apps/agent-api/CHANGELOG.md` — one entry.
- `docs/plans/tavily-deep-research.md` — delete.
- `docs/plans/tavily-research.md` — replace with pointer (or delete).

**External (not code):** `TAVILY_API_KEY` in ZeroVault `zero-api` dev + prod.

## Test strategy

- **`pagefetch/tavily.test.ts`** (new), mirroring `websearch/brave.test.ts`'s
  mock-`fetch` pattern (`globalThis.fetch = vi.fn(...)`, restore in `afterEach`):
  - Asserts request: URL `https://api.tavily.com/extract`, method POST,
    `Authorization: Bearer <key>` header, JSON body `{ urls, extract_depth:
    "basic", format: "markdown" }`.
  - Normalizes `results[0].raw_content` → `{ url, content }`.
  - **Truncation cap:** a `raw_content` longer than `maxContentChars` (inject a
    small cap in options) is truncated with the marker.
  - **failed_results / empty results** → throws.
  - **Empty key** → throws `page fetch unavailable`, makes **no** fetch call.
  - Non-2xx → throws; retry-then-succeed on 429/5xx with injected `sleep` (if the
    retry knob is included).
- **`tools/research.test.ts`** (existing) — inject `createMemoryFetcher()` as the
  fake `fetcher`; assert the research agent can call `read_page` and that a
  fetch error surfaces as `{ error }` (loop continues). Confirms wiring and the
  no-throw contract without a network call.
- **Required-field fallout across the suite** — because `fetcher` is a required
  field (like `search`/`google`), every existing call site that constructs one of
  these inputs must add `fetcher: createMemoryFetcher()`, or **typecheck and tests
  fail**. Verified sites to update:
  - `tools/research.test.ts` — **3** `buildResearchTool({...})` sites (lines ~49,
    ~87, ~104).
  - `agents/orchestrator.test.ts` — **~8** `runTurn({...})` sites (lines ~34, ~53,
    ~87, ~118, ~169, ~217, ~259, ~302).
  - `agents/interface.test.ts` — **22** `runInterfaceAgent(` call sites, **21**
    constructing the input with `search`/`google` (no shared input helper; each
    is an inline literal). Add `fetcher` to every one.
  Import `createMemoryFetcher` from `../pagefetch/memory` (or `./pagefetch/memory`)
  in each test file, mirroring how `createMemorySearch`/`createMemoryGoogle` are
  imported.
- Existing `web_search`, `brave.test.ts`, `memory.ts` tests unchanged (search
  path untouched).
- **e2e unaffected:** the mock Anthropic issues no tool calls, so neither
  `web_search` nor `read_page` fires (see `docs/research.md` "e2e").

## Verification

- Per-package, no `workerd` needed (per `AGENTS.md` local limitation):
  `pnpm --filter @zero/agent-api run test`,
  `pnpm --filter @zero/agent-api run lint`,
  `pnpm --filter @zero/agent-api run typecheck`.
  Rely on GitHub Actions for the `workerd`-backed suites.
- **Live check (needs the key):** once `TAVILY_API_KEY` is in `.dev.vars`, run a
  real research turn in dev and confirm `read_page` returns page content for a
  chosen URL. Cannot run without the key — flag as a manual post-merge step.

## Skills to use

- `tdd` — write `pagefetch/tavily.test.ts` first against mocked `fetch`; it is
  pure normalization + cap + error logic.
- `changelog` — before editing `apps/agent-api/CHANGELOG.md` (match the flat
  dated-list style).
- `git-commit` — commit code + docs + changelog together.
- `reproducible-locally` — for the verification approach (per-package checks;
  live check flagged as needing the key).
- `open-pr` — if shipped as a PR.

## Acceptance criteria

- `web_search` is unchanged: still one tool, input `{ query }`, Brave snippets.
- A new `read_page` tool (input `{ url }`) is registered **only on the research
  agent**, backed by a `PageFetcher` port with a Tavily-Extract adapter and an
  in-memory fake.
- Returned content is capped by an injectable hard char limit; a large page
  can't blow the turn context.
- The tool returns `{ error }` (never throws into the loop) on fetch failure and
  when `TAVILY_API_KEY` is unset.
- `researchSystemPrompt` tells the agent search returns snippets and to
  `read_page` important results before relying on them, selectively.
- `TAVILY_API_KEY` is declared as a secret (Env + ProcessEnv), set in ZeroVault
  dev + prod, and not in `wrangler.jsonc` `vars`. Its `worker-configuration.d.ts`
  entries are produced by re-running `wrangler types` after the key lands in
  `.dev.vars`, not hand-written.
- `fetcher` is a **required** field on `ResearchToolDeps`, `InterfaceAgentInput`,
  and `TurnInput`, and every existing test call site (research.test.ts ×3,
  orchestrator.test.ts ×~8, interface.test.ts ×21) passes
  `fetcher: createMemoryFetcher()`.
- `docs/research.md` and `apps/agent-api/CHANGELOG.md` updated in the same change;
  `docs/plans/tavily-deep-research.md` deleted and `docs/plans/tavily-research.md`
  retired so only this design stands.
- Package `test` / `lint` / `typecheck` green.

## Risks & open items

- **Tavily free-tier credits/RPM** not restated on the Extract reference page —
  confirm on app.tavily.com before relying on volume. Low risk given on-demand,
  selective fetching.
- **Prompt over/under-triggering `read_page`** — too eager wastes credits/latency,
  too shy defeats the purpose. The `read_page_failed` log plus per-turn step
  counts make this observable; tune the prompt from logs after ship (same
  approach as `research` triggering).
- **8000-char cap** is a starting point; adjust from real usage if important
  pages get clipped or if token cost runs high (advanced/chunked modes are the
  documented levers).
