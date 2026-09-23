# Prompt caching

Zero caches the stable prefix of every LLM call so the provider bills it at a
fraction of the input price on reads, instead of re-billing the full system
prompt, tool schemas, and history on every tool-loop step and every turn.

Since the pi-ai migration, **caching is managed by the model layer, not
hand-marked by Zero.** The adapter (`agents/model-pi.ts`) sets two request
options and pi-ai (and the provider) do the rest:

- **`sessionId`** = a per-agent shard key, `zero:<agent>:v1:<shard>`
  (`promptCacheKey`). On OpenAI Responses this becomes `prompt_cache_key`, so the
  byte-identical prefix (tool schemas + static instructions) is routed to the
  same cache across users of the same agent.
- **`cacheRetention: 'long'`** → OpenAI `prompt_cache_retention: "24h"` (and, on
  the Anthropic wire, `cache_control.ttl: "1h"`).

`gpt-6-luna` uses **implicit** prompt caching: pi-ai does not send
`prompt_cache_options: { mode: "explicit" }` (the model definition has no
explicit-cache-mode support), and it places no per-block `cache_control`
breakpoints. Zero no longer computes breakpoints at all — the old
`agents/cache.ts` marking, the `agents/model-anthropic.ts` breakpoint trimming,
and `agents/openai-wire.ts` were removed with the migration.

## What Zero still owns

Two invariants keep the shared prefix reusable; break either and cross-user
caching silently stops:

- **Nothing per-user in `tools` or the static `system`.** The file tools
  (`get_file`, `list_files`, `view_image`, the `view_attachment` alias,
  `read_pdf`, `send_file`, `delete_file`) are registered **unconditionally** so
  their schemas are byte-identical across users, and tool descriptions carry no
  user values (the Google calendar tools close over `timezone` only in their
  `execute` bodies). The per-user pinned topics ride in a separate `systemTail`
  block, after the static head.
- **Stable ordering.** Tools then system then messages; the runner assembles the
  same content in the same order every step, so a later step's prefix matches the
  earlier one and is read rather than rewritten.

## Cache statistics

`agents/model-pi.ts` logs a content-free `cache_stats` line per model call:
`agent`, `step` (the zero-based loop index), `input_tokens` (uncached,
full-price), `cache_read_tokens`, `cache_write_tokens`, and `thinking_tokens`
(reasoning spend, which is inside `output_tokens` and invisible otherwise).

Read it per agent per step. On a working cache, `cache_read_tokens` grows step
over step within a run while `input_tokens` stays small; the broken case is a
large constant `input_tokens` with a tiny constant read.

The API's reported `input_tokens` **includes** the cached tokens; pi-ai subtracts
them, so `input_tokens` in the log and in cost accounting means the part billed
at full price. The provider's response id is persisted on each assistant row
(`messages.responseId`) for tracing a turn back to a provider log line.

## Reading cache tokens from logs

`runAgent` returns `usage` (whole-run aggregate) and `stepUsages` (per step).
Each agent's completion log carries token fields via `usageLogFields`:

- `interface_completed`, `learn_slice_completed`, `onboarding_completed`:
  `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, and
  a derived `cache_hit_ratio` = `cache_read / (cache_read + cache_write + input)`.
- `interface_step_usage` (multi-step turns only): per-step `cache_read`,
  `cache_write`, `input` arrays, exposing the write-then-read pattern the
  aggregate hides.

`result.usage` sums across every tool-loop step, so on a multi-step turn the read
term counts the prefix once per step; read `cache_hit_ratio` as a turn-level
signal and use `interface_step_usage` for the within-run check.

## Production validation

Prompt caching cannot be validated in unit or e2e tests: the mocks implement no
real cache. Validate in production by reading the logged cache-token fields in
Workers Logs (the dashboard Observability tab, or the telemetry query in the root
`AGENTS.md`), cross-checked against the AI Gateway logs, which break tokens and
cost down by the `agent` metadata tag.

- **Within one run:** a multi-step turn (a search, a calendar lookup). Pass: the
  first step logs `cache_write_tokens > 0`; later steps log `cache_read_tokens`
  at roughly the prefix size with small `input_tokens`.
- **Across turns / users:** a second turn (or a second user of the same agent)
  logs `cache_read_tokens` on its first step without a preceding write in that
  turn, because the shared prefix was already warm under the same `sessionId`.

> Cache placement is fully delegated to pi-ai; Zero deliberately owns no custom
> cache machinery any more (the old hand-marked breakpoint scheme and its probe
> were removed). Zero controls exactly two levers — the `sessionId` routing key
> and `cacheRetention: 'long'` — and reads the token logs above to see the result.
> Early production data shows the expected write-then-read accumulation (writes
> shrink to the per-step delta while reads grow), so the automatic policy tracks
> what the old hand-tuned one did.
