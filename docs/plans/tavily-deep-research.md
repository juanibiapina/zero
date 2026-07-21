# Plan: deep research via Tavily, one tool

## Goal
Make the research agent read real page content, not snippets. Keep the model's
toolset unchanged: still **one** search tool, no new tools, no new params the
model has to reason about. The depth comes from the adapter, not from more
surface.

## Key decision: no `fetch_url` tool
First instinct was a second `fetch_url`/extract tool. Dropped it. Tavily's
search with `search_depth=advanced` + `include_raw_content` returns the **full
page text of each result inline**. That is the content extraction, delivered
through the existing `web_search` call. So:

- Tool count stays at 1 (`web_search`), interface unchanged (`{ query }`).
- No separate `/extract` capability, no `extract` method on the port, no second
  port. A specific URL the agent wants is reachable by searching for it.

One tool, deep behavior behind it. This is the "as few as possible" shape.

## What to change and why

1. **`websearch/types.ts`** — add one optional field to `SearchResult`:
   `content?: string` (full page text when the provider supplies it). Port
   interface `WebSearch.search(query)` is otherwise unchanged. Brave keeps
   returning results with no `content`; Tavily fills it.

2. **`websearch/tavily.ts`** (new adapter) — `createTavilySearch(apiKey,
   options?)` implementing `WebSearch`. Calls Tavily `/search` with
   `search_depth: "advanced"`, `include_raw_content: true`, `max_results`
   (default 5). Normalizes each hit to `{ title, url, snippet, content }`.
   - **Caps to protect the prompt:** truncate each result's `content` to ~8000
     chars; cap result count. Full pages are large; unbounded inline content
     blows the turn's context. Caps live in the adapter, injectable for tests.
   - **Errors:** throw on non-2xx (the `web_search` tool already swallows throws
     into `{ error }` so the loop retries). Retry 429/5xx with bounded backoff,
     mirroring the Brave adapter's injectable `sleep`/`maxRetries` shape.
     Simpler than Brave: no per-second free-tier quirk, so a small fixed backoff
     is enough.

3. **`tools/web-search.ts`** — unchanged interface. Only the result rendering
   needs to pass `content` through so the model sees page text. (If results are
   returned as raw JSON to the model today, `content` rides along automatically;
   confirm and keep it.)

4. **`websearch/memory.ts`** — canned results may now include `content`; no
   interface change. Existing tests still pass.

5. **Wire the provider** in `UserDO/index.ts`: swap
   `createBraveSearch(this.env.BRAVE_API_KEY)` →
   `createTavilySearch(this.env.TAVILY_API_KEY)`. Keep `brave.ts` in the tree as
   an alternate adapter (the port's second real adapter — justifies the seam).

6. **Env + secret plumbing:**
   - Add `TAVILY_API_KEY` to `apps/api/worker-configuration.d.ts` (or regenerate
     types) and the `wrangler.jsonc` var list.
   - Store `TAVILY_API_KEY` in ZeroVault `zero-api`, both `development` and
     `production`, then `bin/fetch-secrets` and `bin/sync-secrets-to-cloudflare`.
     Requires the user's Tavily key.

7. **Prompt** (`agents/prompts.ts`, `researchSystemPrompt`): note that each
   `web_search` result now carries the page's full text, so the agent should
   read that content and corroborate across results rather than searching
   shallowly. Keep it short; the existing "cast a wide net / corroborate / keep
   source URLs" guidance already fits.

## Tests to add or update
- `websearch/tavily.test.ts` (new), mirroring `brave.test.ts` structure: mock
  `fetch`; assert request body (`search_depth: "advanced"`,
  `include_raw_content: true`, key placement), normalization into `SearchResult`
  with `content`, content truncation cap, result-count cap, retry-then-succeed
  on 429/5xx with injected `sleep`, throw on other non-2xx, throw after retries
  exhausted.
- `tools/research.test.ts` / web-search tool test: confirm `content` reaches the
  tool result and errors still return `{ error }`.
- Keep `brave.test.ts` as-is (adapter retained).

## Docs to update
- `docs/research.md`: replace the "Upgrade paths" section with the shipped
  design — Tavily as the production adapter returning inline full-page content
  via advanced search; note the deliberate choice of **one tool** over a
  separate extract tool; document the content/result caps and where they live.
  Update the "Web search port" section (Brave now the fallback adapter, Tavily
  primary).
- `CHANGELOG.md`: one user-facing entry, e.g. `- 2026-07-21: Research now reads
  full web pages, not just short snippets, for deeper and better-sourced
  answers.` (load the changelog skill; commit with the code).

## Skills to use
- `tdd` — write the Tavily adapter test-first against mocked `fetch`; it's pure
  normalization + retry logic.
- `changelog` — before editing `CHANGELOG.md`.
- `git-commit` — when committing (code + changelog together).
- `open-pr` — if this ships as a PR.

## Acceptance criteria
- `web_search` is still the only search tool and still takes only `{ query }`.
- A real research run returns results whose `content` holds full page text
  (verified against Tavily in dev once the key is set).
- Provider swap is one line in `UserDO`; both adapters satisfy the unchanged
  port.
- Inline content is capped per-result and per-count; a pathological page can't
  blow the turn context.
- `gob run bin/ci` green; new Tavily adapter test covers normalization, caps,
  and retry/error paths.
- `docs/research.md` and `CHANGELOG.md` updated in the same change.

## Open input needed
Tavily API key (app.tavily.com) to store in ZeroVault. Everything else builds
and tests against the memory/mock adapters without it.
