# Research agent

The interface agent has a `research` tool. Calling it instantiates a second
agent (research-prompted, with a `web_search` tool), runs its own tool loop, and
returns that agent's final message as the tool result.

## One runner, two agents

`apps/api/src/agents/run.ts` is the single agent machine:

```
runAgent({ model, system, prompt, tools, maxSteps }) → { text, finishReason, steps }
```

The interface agent and the research agent are the same runner with different
system prompts and toolsets:

- **Interface agent** (`agents/interface.ts`): tools are the topic tools +
  `reply` + `research`. Its output is the `{ replies, accessed }` collected by
  the tool closures; the runner's `text` and `finishReason` are used only to
  decide the no-silence fallback (deliver prose the model forgot to `reply`, or
  send a generic fallback when the loop hit the cap without a final answer).
- **Research agent** (spawned by `tools/research.ts`): its only tool is
  `web_search`. Its returned text *is* its output, returned to the interface
  agent as the `research` tool result (with a `"No findings."` fallback when the
  loop ends without text).

The research agent reuses the per-turn model instance, so per-user AI Gateway
attribution (`cf-aig-metadata`) is preserved. The research loop runs inline in
the turn's DO alarm (no separate alarm). Both agents share one step cap,
`AGENT_MAX_STEPS = 200` (`agents/run.ts`). The cap is a runaway-loop guard, not
an expected stopping point: a normal loop finishes in a handful of steps. 200
gives headroom while bounding pathological loops; if `finish_reason != "stop"`
with a high step count shows up in logs, lower it.

The research tool logs `research_started` (`prompt_len`) and `research_completed`
(`steps`, `finish_reason`, `duration_ms`, `result_len`); the `web_search` tool
logs `web_search_failed` (`error`) where search errors are otherwise swallowed
into the tool result. No message content is logged (see `log.ts` conventions).

## Web search port

`apps/api/src/websearch/types.ts` defines the `WebSearch` port and a normalized
`SearchResult` (`{ title, url, snippet }`). Adapters:

- `brave.ts` — `createBraveSearch(apiKey)`, production. Calls the Brave Web
  Search API (`X-Subscription-Token: BRAVE_API_KEY`) and normalizes
  `web.results[]`.
- `memory.ts` — `createMemorySearch(results)`, deterministic canned results for
  tests.

## Upgrade paths

Brave returns snippet descriptions only (no full page text). The `WebSearch`
port is the swap point:

- Swap to a richer provider (e.g. Tavily) by adding a new adapter; callers
  depend only on the port.
- Add a `fetch_url` tool to the research agent so it can read full pages behind
  the snippets.

## e2e

The e2e mock Anthropic returns canned text and never issues tool calls, so
`research` never fires in e2e and no real search call is made.
