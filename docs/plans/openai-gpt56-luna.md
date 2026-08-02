# Move the agent LLM to OpenAI `gpt-5.6-luna` (reasoning effort high)

## Goal

Every Zero agent call (interface, research, learner, compaction, onboarding,
admin_task) runs on OpenAI `gpt-5.6-luna` via the Responses API with
`reasoning.effort: "high"`, through the existing Cloudflare AI Gateway with a
stored OpenAI key (BYOK), keeping per-user attribution, prompt caching, usage
accounting, and the rate-limit path working.

## Background (state of the code today)

- `apps/agent-api/src/agents/model.ts` is the **only** module that knows an LLM
  SDK exists. It builds an `@anthropic-ai/sdk` client per agent, points it at
  `env.AI.gateway(env.CLOUDFLARE_GATEWAY_ID).getUrl("anthropic")`, suppresses
  `x-api-key` (BYOK injects the real key), authenticates to the gateway with
  `cf-aig-authorization: Bearer ${CLOUDFLARE_API_KEY}`, and tags each request
  with `cf-aig-metadata: {"user_id","agent"}`.
- `env.MODEL_ID` is a plain var (`claude-sonnet-4-6`) in
  `apps/agent-api/wrangler.jsonc` and `wrangler.test.jsonc`.
- `agents/protocol.ts` is Zero's dependency-free interface, but its shapes
  deliberately **mirror the Anthropic Messages wire format** (`text` /
  `image` / `tool_use` / `tool_result` / `thinking` blocks, `cache_control` in
  place) because the prompt cache keys on serialized bytes.
- `agents/cache.ts` places up to 4 Anthropic `cache_control` breakpoints: last
  tool definition, system block, caller anchor message, sliding tail message.
  `docs/caching.md` describes the three reuse tiers.
- Anthropic-only extras threaded through the runner: the
  `cache-diagnosis-2026-04-07` beta, `previousMessageId` / `crossRun` / `step`
  on `AgentModelRequest`, `CacheDiagnostic` on the response, and the
  `cache_diagnostic` log line. `previousMessageId` chains a run's
  `msg_...` ids (stored via migration `0027_message_response_id.sql`).
- Thinking is on for every agent: `{ type: "adaptive", display: "omitted" }`,
  with `effort` omitted because omitting it *is* Anthropic's `high`.
- Stored history (`store/messages.ts`) persists wire blocks as JSON, including
  `thinking` blocks with Anthropic signatures. `decodeContent` is deliberately
  tolerant of rows it does not understand.
- `packages/agent-e2e/src/mock-anthropic.ts` serves `POST /v1/messages` with a
  canned `BetaMessage` and a 429 mode; the worker reaches it through
  `LLM_BASE_URL_OVERRIDE`.
- `agents/ai-usage.ts` prices only `claude-sonnet-4-6`; unknown models record
  `pricingStatus: "unpriced"` (cost 0), so a model swap silently zeroes cost
  telemetry until the table is updated.

## Target facts about the model and API (researched 2026-08-02)

- `gpt-5.6` is an alias for `gpt-5.6-sol`. `gpt-5.6-luna` is the cheap,
  low-latency member of the family: **$0.20 / M input, $0.02 / M cached input,
  $0.25 / M cache write, $1.20 / M output** (standard tier, short context;
  verified against the official pricing page 2026-08-02, after OpenAI's
  late-July cut — third-party pages still quote the launch price of $1 / $6).
  For comparison: `gpt-5.6-terra` is $2.00 / $0.20 / $2.50 / $12.00, and the
  outgoing `claude-sonnet-4-6` is $3.00 / $0.30 / $3.75 / $15.00. Zero's spend
  is dominated by cached input on tool loops, so the decisive row is cache read:
  **$0.30 -> $0.02**. Prompts over 272K input tokens are billed at 2x input /
  1.5x output for the whole request.
- Reasoning is configured with `reasoning: { effort, mode, context }`.
  `effort` accepts `none|low|medium|high|xhigh|max`; **default is `medium`**, so
  `high` must be set explicitly (unlike Anthropic, where omitting it meant high).
  `mode` stays `standard` (pro mode is a deliberate non-goal: higher latency and
  token usage for a chat assistant).
- `reasoning.context` defaults to `all_turns` on GPT-5.6. With manually managed
  history (Zero's case) that means: resend previous user inputs and **every
  response output item**, replaying the **encrypted reasoning items** the API
  returns. Reasoning tokens land in `usage.output_tokens_details.reasoning_tokens`.
- Prompt caching on GPT-5.6: explicit breakpoints exist.
  `prompt_cache_breakpoint: { mode: "explicit" }` may be set on `input_text`,
  `input_image`, `input_file` blocks (Responses API) — **not** on tool
  definitions and not on the `instructions` field. `prompt_cache_options.mode:
  "explicit"` disables the implicit breakpoint on the latest message (avoiding
  cache writes for the volatile tail); `prompt_cache_options.ttl` is `30m` and
  is the only value. Up to 4 cache **writes** per request, reads consider the
  latest 50 breakpoints, and the service reads the longest matching prefix.
- `prompt_cache_key` must be set to get the reliable matching, is combined with
  the prefix hash for routing, and should carry **~15 requests/minute or less**
  per key.
- Cache accounting: reads in `usage.input_tokens_details.cached_tokens`, writes
  in `cache_write_tokens` (billed 1.25x uncached input).
- Gateway: base URL
  `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai`, Responses
  endpoint `/responses`. With stored keys (BYOK) Cloudflare documents two
  variants: send **no** `Authorization` header and authenticate with
  `cf-aig-authorization: Bearer {cf_token}` (the curl example), or pass the
  Cloudflare token as the SDK's `apiKey` (the JS example). Use the first: it is
  exactly the shape `model.ts` already proves out for Anthropic (suppress the
  SDK's auth header via `defaultHeaders`, keep a non-null dummy `apiKey` so the
  SDK does not start its credential-resolution chain inside workerd). `env.AI.gateway(id).getUrl("openai")` builds
  the same URL, so the existing `resolveBaseUrl` shape survives.
- OpenAI asks for a stable, privacy-preserving `safety_identifier` per end user.

## Approach

Keep `protocol.ts` as Zero's internal representation and translate to/from the
Responses wire inside the adapter. The alternative (rewriting the protocol into
Responses shapes and migrating every stored message row) touches the store, the
runner, compaction, delivery, and every agent test, and buys nothing: nothing
above the adapter cares what the wire looks like, only that the bytes are
*deterministic* so the cache prefix is stable. A pure, ordered translation gives
that.

Two seams:

1. **`agents/openai-wire.ts` (new, pure).** Protocol -> Responses input items and
   back. No SDK, no I/O, exhaustively unit tested. This is where every mapping
   decision below lives.
2. **`agents/model.ts` (rewritten adapter).** OpenAI SDK client, gateway auth,
   `cf-aig-metadata`, reasoning config, cache options, usage extraction, logging.

### Mapping decisions

| Protocol | Responses wire |
|---|---|
| `system: TextBlock[]` | first `developer` input message, one `input_text` block per entry (**not** `instructions`, which cannot carry a breakpoint) |
| user/assistant `TextBlock` | `input_text` / `output_text` |
| `ImageBlock` (base64) | `input_image` with `image_url: "data:<mime>;base64,<data>"` |
| `ToolUseBlock` | `function_call` item: `call_id`, `name`, `arguments` (JSON string) |
| `ToolResultBlock` (string) | `function_call_output`: `call_id`, `output` |
| `ToolResultBlock` (image blocks, `view_image`) | `function_call_output` whose `output` is an item list of `input_text` / `input_image` blocks (verified: `openai@7.3.0` `src/resources/responses/responses.ts:4192`, `ResponseFunctionCallOutputItemList`) — no placeholder message needed |
| `ThinkingBlock` / `RedactedThinkingBlock` | `reasoning` item with `id` + `encrypted_content` (see below) |
| `AgentToolDefinition` | `{ type: "function", name, description, parameters, strict: false }`, insertion order preserved |
| `cache_control` on a block | `prompt_cache_breakpoint: { mode: "explicit" }` on the corresponding `input_text`/`input_image` block — **only input blocks can carry one** (see "Breakpoints cannot land on assistant content" below) |
| assistant `phase` (`commentary` / `final_answer`) | preserved on the stored assistant block and resent verbatim; dropping it degrades performance on recent models (`openai@7.3.0` responses.ts:710-716) |
| `stop_reason` | derived: any `function_call` in output -> `tool_use`; `status: "completed"` -> `end_turn`; `incomplete_details.reason: "max_output_tokens"` -> `max_tokens`; a refusal item -> `refusal` |

`store/messages.ts` `TERMINAL_STOP_REASONS` keeps working unchanged under that
derivation, which is why the derivation exists rather than storing raw OpenAI
statuses.

### Reasoning round-trip

Reasoning items must be replayed with their `id` and `encrypted_content`, so
extend the protocol's reasoning block to carry both (a `ThinkingBlock` today has
`thinking` + `signature`). Add explicit fields rather than overloading
`signature`, and have the translator **drop any reasoning block that lacks the
new fields**. That single rule makes both the cutover and a rollback safe:
Anthropic-era `thinking` blocks in existing conversations are silently dropped
on the way to OpenAI, and OpenAI-era reasoning blocks are dropped on the way
back to Anthropic. Dropping reasoning is never an error — it costs multi-turn
reasoning reuse, not correctness.

**Also drop orphan reasoning items.** A reasoning item is only valid when the
item it belongs to is still in the rendered window; the API rejects a reasoning
item whose required following item is missing. Zero's context window can open
anywhere (a `CONTEXT_MESSAGE_PAGE` cut, or a compaction boundary — see
`store/messages.ts`), so the translator must drop any reasoning item not
immediately followed by its assistant message or `function_call`. This is the
same class of bug the existing boundary logic already guards for `tool_use` /
`tool_result`, and it fails as a hard 400 rather than degraded output, so it
needs its own unit test with a window that starts mid-turn.

Send `store: false` **with `include: ["reasoning.encrypted_content"]`** (the
include value exists in `openai@7.3.0` responses.ts:3772; the docs say GPT-5.6
returns encrypted reasoning by default under `store: false`, but asking for it
explicitly costs nothing and does not depend on a default). Keep the encrypted
reasoning replay: Zero's durable log
is the source of truth, and `previous_response_id` chaining is incompatible with
compaction rewriting history and with turns resuming after a Durable Object
reset. Set `reasoning.context: "all_turns"` explicitly (it is the default, but
Zero's cache prefix should not move when a default changes).

### Cache layout

`prompt_cache_options.mode: "explicit"`, four writes budgeted exactly as today:

1. static system instructions (developer message) — cross-user shared prefix
2. per-user tail of system (pinned topics) — per-user prefix
3. caller anchor: last stable history message
4. sliding breakpoint on the tail message, advanced each loop step

Tools no longer take a breakpoint (unsupported); they sit in the rendered prefix
*before* the input, so breakpoint 1 covers instructions + tools. The static
system prompt has to be a `developer` input message rather than the
`instructions` field, because `instructions` on the create params is a plain
string (`openai@7.3.0` responses.ts:8568 `ResponseCreateParamsBase`; only the
returned `Response` object types it as an item array) and a string cannot carry
a breakpoint. `EasyInputMessage` accepts role `developer` with a content list
(responses.ts:697-708). `markLastTool`
therefore disappears from `cache.ts` and its callers, and `cachedSystem` grows a
second block for the pinned tail. Everything else in `cache.ts` stays: the
marker type changes, the placement policy does not.

**Breakpoints cannot land on assistant content.** The Responses API accepts
`prompt_cache_breakpoint` only on `input_text`, `input_image`, and `input_file`
blocks (`openai@7.3.0` responses.ts:5033, 3984, 3875) — never on an assistant
`output_text` block or a `function_call` item. Today
`agents/interface.ts:372` anchors on `convo[lastIdx - 1]`, which for a normal
turn is the **previous assistant reply**, so that anchor is unrepresentable as
written. Fix: `markCacheBreakpoint` walks back to the last block in that message
that can carry a marker, and the interface agent's anchor walks back to the last
*input* message at or before `lastIdx - 1` (in practice the previous user
message). The cached prefix then excludes the previous assistant reply — a small
loss of coverage, and the only placement the API allows. The runner's sliding
breakpoint is unaffected in the normal case: the tail before each request is the
current user message or the tool-result message, both input items; the walk-back
covers the resumed-mid-flight case where the tail is an assistant message.

`prompt_cache_key`: `zero:<agent>:v1:<shard>` where `<shard>` is a stable hash
of the Clerk user id modulo N (start N = 1). A shared key is required for
cross-user reuse of the instructions prefix; the shard exists so the ~15 rpm per
key ceiling is raised by bumping N, and every shard still caches the shared
prefix once. Bump the `v1` segment whenever the static prompt changes, so a
stale prefix is never routed to.

### Reasoning effort, tokens, and limits

- `reasoning: { effort: "high", context: "all_turns" }` for every agent, keeping
  the existing "every agent thinks" invariant and its rationale (the learner's
  judgement is the call most worth reasoning about).
- `max_output_tokens`: raise from 16000 to **32000**. Reasoning tokens are
  billed and counted as output, and at `high` effort the old ceiling would start
  truncating replies. A rise in `incomplete_details.reason: "max_output_tokens"`
  is the signal to revisit.
- Keep the 300s per-request timeout and `maxRetries: 2`.
- Set `safety_identifier` to the Clerk user id (already opaque and stable).

### Diagnostics removal

Anthropic's cache-divergence diagnostics have no Responses equivalent. Delete
the beta header, `previousMessageId`/`crossRun` plumbing, `toDiagnostic`, and
`CacheDiagnostic`, and replace the `cache_diagnostic` log with a `cache_stats`
line carrying `agent`, `step`, `input_tokens`, `cached_tokens`,
`cache_write_tokens`, `reasoning_tokens`. Keep `step` — it is what makes the
write-then-read pattern readable per agent per call. Keep the stored response id
column (migration 0027); it becomes debugging metadata, and dropping a column is
not worth a migration.

### Usage and pricing

Map `cached_tokens` -> `cacheReadTokens`, `cache_write_tokens` ->
`cacheWriteTokens` **and** `cacheWrite5mTokens` (OpenAI has one 30m tier; the 1h
bucket stays 0 so the existing Analytics Engine schema and dashboard keep
working). Add to `PRICING`:

```
"gpt-5.6-luna": { version: "openai-2026-08-02", inputPerMillion: 0.2,
  outputPerMillion: 1.2, cacheReadPerMillion: 0.02,
  cacheWrite5mPerMillion: 0.25, cacheWrite1hPerMillion: 0 }
```

Without this entry every turn records cost 0 and `pricingStatus: "unpriced"`.

### Rollback

Select the adapter by model id prefix (`claude-` -> existing Anthropic adapter,
`gpt-` -> new OpenAI adapter) and keep both files. Rollback is then a
`MODEL_ID` var flip plus a deploy, with no code revert, and the reasoning-block
drop rule above makes mixed history safe in both directions. Delete the
Anthropic adapter in a follow-up once `gpt-5.6-luna` has run clean for a while.

## Implementation phases

1. **Config + key. DONE 2026-08-02.** The OpenAI key is stored in the `zero`
   gateway under provider OpenAI, alias `default` (the alias the gateway uses
   automatically). Verified live against
   `.../zero/openai/responses` with only `cf-aig-authorization: Bearer
   $CLOUDFLARE_API_KEY` and **no** `Authorization` header: `gpt-5.6-luna`
   answered, and the response echoed `reasoning: { effort: "high", context:
   "all_turns", mode: "standard" }`, `store: false`. A second probe carrying
   `prompt_cache_options: { mode: "explicit" }`, a `prompt_cache_breakpoint` on
   a `developer` `input_text` block, `prompt_cache_key`, `include:
   ["reasoning.encrypted_content"]`, a function tool, and `cf-aig-metadata` was
   accepted and returned a `function_call`, with usage carrying
   `cached_tokens`, `cache_write_tokens`, and `reasoning_tokens`. Assistant
   output items came back with `phase: "final_answer"`, confirming the `phase`
   round-trip mapping. Still to do: add
   `openai` (currently `7.3.0`, which types `prompt_cache_options`,
   `prompt_cache_breakpoint`, `reasoning.context`, `cache_write_tokens`, and
   `safety_identifier`) to the worker's dependencies. No behavior change yet.
2. **`openai-wire.ts`** with unit tests: message translation both directions,
   tool definitions, breakpoint placement, reasoning drop rule, stop-reason
   derivation, usage extraction.
3. **`model.ts` OpenAI adapter** + prefix-based selection, `cache_stats` log,
   diagnostics removal across `protocol.ts`, `run.ts`, `orchestrator.ts`, and
   the interface agent.
4. **`cache.ts`**: drop `markLastTool`, split system into stable head + pinned
   tail blocks, keep anchor and sliding breakpoints.
5. **Pricing entries + `MODEL_ID` flip** in `wrangler.jsonc` and
   `wrangler.test.jsonc`, plus the per-agent model override in the factory
   (default `MODEL_ID`, no agent overridden at first). Price both
   `gpt-5.6-luna` and `gpt-5.6-terra` so flipping one agent later does not
   silently zero its cost telemetry.
6. **E2E mock**: replace `mock-anthropic.ts` with a Responses mock
   (`POST /responses`, canned output items, 429 mode), rename the
   `MOCK_ANTHROPIC_*` env vars, update `bin/e2e-test`.
7. **Docs + changelog.**

Phases 2-5 land as one deployable change; splitting them leaves the worker in a
state where the model id and the adapter disagree.

## Test strategy

- **Pure translation tests** (`openai-wire.test.ts`): every row of the mapping
  table, both directions, plus the reasoning drop rule for legacy blocks and for
  OpenAI blocks fed back to the Anthropic adapter.
- **Adapter tests** (`model.test.ts`): keep the existing `fetchImpl` seam and
  assert on **request bytes** — model id, `reasoning.effort: "high"`,
  `max_output_tokens`, `prompt_cache_options.mode`, `prompt_cache_key`,
  breakpoint count and placement, `store: false`, `include`,
  `safety_identifier`, `cf-aig-metadata`, and that `cf-aig-authorization`
  carries the Cloudflare token while no `Authorization` header goes out. Byte-level
  assertions are the only way a cache regression is caught before production.
- **Runner/orchestrator tests**: mostly unchanged (they run against
  `mock-model.ts`); update only where `CacheDiagnostic` is removed.
- **Rate limit**: `llm-error.test.ts` gains an OpenAI-shaped `APIError` case
  (429 with `status`, and one wrapped in `cause`).
- **E2E** (`packages/agent-e2e`, run manually via `bin/e2e-test` on a
  workerd-capable machine, not this box): hello, attachments, and rate-limit
  suites pass against the Responses mock.
- **Production validation** (the only place caching is provably done): after
  deploy, read Workers Logs for `cache_stats` and confirm `cached_tokens` grows
  step-over-step within a run while `input_tokens` stays small, and confirm AI
  Gateway logs show the `gpt-5.6-luna` model with per-agent metadata.

## Documentation

- `docs/caching.md`: rewrite for OpenAI explicit breakpoints — 4 writes/request,
  30m ttl, `prompt_cache_key` routing and its rpm ceiling, no tools breakpoint,
  and the new production playbook (`cache_stats` instead of `cache_diagnostic`).
- `docs/design.md` and root `AGENTS.md`: the model id and "BYOK Anthropic"
  become OpenAI.
- `apps/agent-api/CHANGELOG.md`: one user-facing bullet (the assistant runs on a
  new model), per the changelog rule — same commit, not a follow-up.
- `docs/secrets.md` / gateway notes: where the OpenAI key lives.

## Skills to use

- `code` — executing this plan
- `deep-modules` — keeping the wire translation a real seam instead of leaking
  Responses shapes upward
- `tdd` and `testing` — the translation module and adapter byte assertions
- `cloudflare` — AI Gateway BYOK and Workers specifics
- `reproducible-locally` — proving the switch works without a manual step
- `changelog` — the agent changelog entry
- `git-commit` — committing

## Acceptance criteria

- A turn end-to-end (interface -> tools -> reply, plus learner) runs on
  `gpt-5.6-luna` with `reasoning.effort: "high"`.
- No module outside `model.ts` / `openai-wire.ts` imports an LLM SDK.
- `cache_stats` in production shows cache reads growing within a run and across
  turns; cost telemetry is `priced`, not `unpriced`.
- Rate limits still surface `RATE_LIMIT_MESSAGE`, not the generic failure.
- Conversations that predate the cutover keep working (legacy reasoning blocks
  dropped, no API rejection).
- `MODEL_ID` back to `claude-sonnet-4-6` restores the old behavior with no code
  change.

## Risks

- **Prompt fit.** Zero's prompts were written and tuned for Claude, and OpenAI's
  guidance for GPT-5.6 pushes leaner prompts, explicit autonomy boundaries, and
  `text.verbosity` instead of "be concise" instructions. Expect a tone/length
  shift on day one. Out of scope here; plan a prompt pass after the switch,
  guided by real turns.
- **`luna` is the cheap tier, and it is small.** Its own model page says it
  "roughly corresponds to the nano model tier used in earlier GPT-5 families"
  (developers.openai.com/api/docs/models/gpt-5.6-luna). Zero is replacing
  `claude-sonnet-4-6` — a mid/large frontier model — on work that is
  tool-loop-heavy and, in the learner's case, writes durable memory about the
  user. Expect a real quality drop there even at `effort: "high"`. Mitigation is
  cheap because the factory already builds a client per agent: keep `MODEL_ID`
  as the default and allow a per-agent override, so the learner (and research)
  can run `gpt-5.6-terra` while the interface runs `luna`.

  **Decision (2026-08-02): every agent runs `gpt-5.6-luna` at `effort: "high"`.**
  The per-agent override ships anyway as the lever, unused at first. Rationale
  from the model comparison: at `high` effort Luna scores 46 on the Artificial
  Analysis Intelligence Index against Sonnet 4.6's 47, and on the rows closest
  to Zero's work it is near the flagship (Toolathlon 53.4 vs Sol 58.0, Agents'
  Last Exam 50.3 vs 52.7, GPQA 92.3 vs 94.6). Its weak rows are ones Zero
  mostly does not hit (MRCR >256K, GraphWalks 1M, ARC-AGI-3). The two to watch
  are the **learner** (GDPval-AA-shaped judgement, 1591.8 Elo vs Sol 1747.8)
  and **research** (BrowseComp 83.3 vs Sol 90.4); if either degrades, flip that
  agent to `gpt-5.6-terra` via the override rather than reverting the switch.
  Keeping `effort: "high"` is load-bearing: Luna at `medium` drops to 38 and at
  `low` to 33 on the same index.
  Confirmed supported for luna: `effort: "high"`, image input, function calling,
  structured outputs, 1.05M context, 128K max output.
- **Cache key rpm.** Exceeding ~15 rpm on one `prompt_cache_key` silently costs
  cache hits. Watch `cached_tokens` and raise the shard count.
- **Tool-result images.** The `view_image` path is the least certain mapping;
  verify it against the current tools/vision reference before implementing.
- **Cost accounting drifts silently.** Missing the `PRICING` entry produces
  zeroed cost, not an error.
- **Long-context surcharge.** Prompts over 272K input tokens are billed at 2x
  input / 1.5x output for the whole request (model page). Compaction keeps Zero
  well under that today; it becomes relevant if the context ceiling is ever
  raised to exploit luna's 1.05M window.
