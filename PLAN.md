# Analytics Engine AI cost reporting

## Goal

Account for successful model responses, then show estimated AI cost by user and chat in the existing admin UI.

Persist one aggregated Analytics Engine point per agent execution, not one point per model response. Each point contains the execution's model-call count, token categories, and estimated cost. This answers the admin reporting questions while staying far below Analytics Engine's 250-point-per-Worker-invocation limit.

Analytics Engine is an operational estimate, not an accounting ledger. Data can be sampled and is retained for about three months. AI Gateway logs remain the request-level debugging source.

## Technical approach

### 1. Add a dedicated Analytics Engine dataset

Add an `AI_USAGE` binding for a new `zero-ai-usage` dataset in `apps/agent-api/wrangler.jsonc` and `apps/agent-api/wrangler.test.jsonc`. Do not reuse `ANALYTICS` and its `zero-events` dataset because that positional schema already stores signup events.

Write one point after each agent execution that produced at least one successful model response. An interface run and each nested research run produce separate points. Learner slices, compaction, onboarding, and admin tasks each produce their own point.

Use this explicit positional schema:

- index1: Clerk user ID
- blob1: schema version
- blob2: model returned by Anthropic
- blob3: agent
- blob4: conversation ID, or the empty-string sentinel
- blob5: Telegram chat ID as a string, or the empty-string sentinel
- blob6: topic ID as a string, or the empty-string sentinel
- blob7: pricing version
- blob8: pricing status (`priced` or `unpriced`)
- double1: estimated USD cost; `0` only when blob8 is `unpriced`
- double2: uncached input tokens
- double3: output tokens
- double4: cache-read tokens
- double5: 5-minute cache-write tokens
- double6: 1-hour cache-write tokens
- double7: successful model-call count

Analytics Engine blobs are strings, not nullable fields. Queries must keep unpriced usage visible and must not present its zero cost placeholder as a priced estimate.

### 2. Measure one agent execution

Split measurement across the existing seams:

1. In `apps/agent-api/src/agents/model.ts`, parse the full Anthropic usage object after each successful response. Extend the internal token usage shape to preserve separate 5-minute and 1-hour cache-write counters.
2. In `apps/agent-api/src/agents/run.ts`, keep accumulating successful step usage as it does now, including a model-call count.
3. Add a narrow, optional completion callback to the runner. Invoke it once from a `finally` path when at least one model response succeeded, including when a later model request or tool fails.
4. Pass a non-throwing Analytics Engine reporter from each production agent wrapper. The reporter estimates cost, writes one point for the aggregate without `await`, and catches/logs synchronous fake or programming failures so telemetry cannot lose a user reply.

The runner remains independent of Cloudflare. It knows only the callback interface and aggregated usage. The Analytics Engine adapter owns the binding, positional schema, pricing, and attribution.

A hard isolate reset may prevent the completion callback from running and lose that in-progress estimate. Accept this because the view is operational telemetry, not a billing ledger. Do not add a Queue or durable checkpoint for this feature.

### 3. Estimate cost at ingestion

Create a small `ai-usage` module with a narrow interface for pricing and point creation.

Store calculated cost and a pricing version at ingestion time so later price changes do not rewrite historical totals. Use the model returned by Anthropic rather than assuming the configured alias was billed.

Unknown models still record calls and token usage with pricing status `unpriced`. Their numeric cost placeholder is zero, but the UI and query responses must expose the unpriced call/token totals.

For Sonnet 4.6, test the current Anthropic rates:

- $3/M uncached input
- $15/M output
- $0.30/M cache reads
- $3.75/M 5-minute cache writes
- $6/M 1-hour cache writes

### 4. Carry attribution into agent execution

Each reporter captures immutable attribution for one agent execution:

- Clerk user ID
- agent label
- conversation ID when applicable
- Telegram chat and topic IDs when applicable

Normal turns know `chatId` and `topicId`, but `UserDO.runTurn` currently creates the model factory before the orchestrator resolves the conversation ID. Resolve the stable conversation ID from the store before model/reporter creation, then pass it into the orchestrator as well. Avoid separate lookups that can drift.

Compaction carries its conversation ID. Research inherits the active conversation attribution. User-wide learner runs, onboarding, and admin tasks use the non-chat sentinels.

Keep existing AI Gateway `user_id` and `agent` metadata for request-level debugging.

### 5. Add a read adapter for Analytics Engine SQL

The Analytics Engine binding is write-only. Add a separate `CLOUDFLARE_ANALYTICS_TOKEN` secret with `Account Analytics: Read`. Do not broaden or reuse the AI Gateway token.

Create an adapter that POSTs SQL to:

`/accounts/{account}/analytics_engine/sql`

Use only validated range enums: `24h`, `7d`, `30d`, and `90d`.

SQL rules:

- Keep the dataset identifier as a code constant.
- Escape every interpolated SQL string literal, especially the path-supplied Clerk user ID.
- Request an explicit response format and validate decoded rows with Zod.
- Add lower and upper timestamp bounds.
- Weight every sum with `_sample_interval`, including cost, call count, and all token categories.
- Return priced cost plus separate unpriced calls/tokens.

Add two admin-only routes:

- `GET /api/admin/ai-usage?range=30d`: totals and rows grouped by user
- `GET /api/admin/users/{userId}/ai-usage?range=30d`: that user's totals plus breakdowns by agent and conversation

Keep these separate from `/api/admin/users`. A Cloudflare query failure must not prevent the Clerk roster from loading.

### 6. Restore and improve the admin cost UI

On `/admin`:

- add a 24h/7d/30d/90d selector
- show total estimated AI cost, model calls, and token categories
- show unpriced usage when present
- add cost and call columns to the user table, sorted by cost
- show a usage-specific error if Analytics Engine is unavailable while leaving the user roster visible

On `/admin/users/:userId`:

- show the selected period's total estimated cost, calls, and tokens
- show cost by agent
- show cost by conversation, with chat/topic identifiers and a separate non-chat row
- show unpriced usage when present

Label money as `Estimated AI cost`. State that history starts at deployment and is retained for about three months. Keep `90d` as the query-window label, not a claim of exact retention.

### 7. Secrets and deployment sequencing

Before pushing code:

1. Create the least-privilege Cloudflare analytics-read token.
2. Store it as `CLOUDFLARE_ANALYTICS_TOKEN` in ZeroVault for `zero-api` development and production.
3. Sync it to the Worker.
4. Add it to `secrets.required`.
5. Regenerate `worker-configuration.d.ts` with `cf-typegen`.

Do not backfill old AI Gateway logs. Analytics Engine timestamps points when written, so imported historical calls would receive false dates. Collection starts at deployment.

## Tests

- Anthropic usage parsing fixtures for uncached input, output, cache reads, 5-minute writes, and 1-hour writes.
- Cost estimator fixtures for every token category and an unknown model.
- Runner tests proving one completion report per agent execution, aggregated call/token totals, no point for zero successful responses, and partial usage reporting when a later step or tool fails.
- Reporter tests proving the positional point schema, chat/non-chat attribution, `priced`/`unpriced` handling, and telemetry failure isolation.
- Attribution tests for interface, research, learner, compaction, onboarding, and admin-task executions.
- SQL adapter tests for range validation, weighting of every aggregate, explicit response parsing, quote-bearing user IDs, injection attempts, future-timestamp exclusion, and Cloudflare failures.
- Admin route tests for the admin gate, response schemas, unpriced usage, and failure isolation from the Clerk roster.
- Admin web tests for range selection, independent roster/usage states, sorting, breakdowns, and unpriced notices.
- Run direct agent API and web tests, lint, typecheck, and build checks supported on this NixOS host. Run `gob run bin/ci`, expecting the documented local `workerd` limitation; GitHub Actions covers the whole-repo Worker checks.

## Docs and changelog

- Update `docs/design.md` with the aggregated agent-execution schema, sampling behavior, roughly three-month retention, estimated-cost semantics, reset limitation, and admin query path.
- Update `docs/secrets.md` for the analytics-read token.
- Add to `apps/agent-api/CHANGELOG.md`: `- 2026-07-31: Admins can see estimated AI costs by user, agent, and conversation for selectable time ranges.`

## Acceptance criteria

- Every completed agent execution with at least one successful model response attempts one user-indexed Analytics Engine write containing its aggregate call count, token categories, and estimated cost.
- A later failure within an agent execution still reports usage from earlier successful responses unless the isolate itself resets.
- `/admin` shows per-user totals matching a controlled multi-step fixture.
- A user's detail page separates chat and non-chat costs.
- Unknown-model usage is visible and is not represented as known zero cost.
- Analytics failures do not affect model calls, replies, or the admin user roster.
- Reports weight Analytics Engine samples, bound the requested range, and describe retention and money as estimates.

## Verification report

**Status: approved after adopting one point per agent execution.**

### Resolved findings

1. **Analytics Engine's 250-point invocation limit:** one point per agent execution replaces one point per model response. This sharply bounds writes while preserving every required reporting dimension. Cloudflare limit: <https://developers.cloudflare.com/analytics/analytics-engine/limits/>.
2. **SQL injection risk:** the plan now keeps the dataset identifier constant and requires tested escaping for every request-derived SQL literal.
3. **Conversation attribution timing:** the plan resolves the stable conversation ID before reporter creation and passes the same ID into orchestration.
4. **Unknown pricing representation:** the schema now stores explicit pricing status and reports unpriced usage separately.
5. **Retention wording:** the UI and docs now say about three months rather than exactly 90 days.
6. **Write semantics:** `writeDataPoint()` is called without `await`; Cloudflare handles delivery after the immediate return: <https://developers.cloudflare.com/analytics/analytics-engine/get-started/>.

### Verified claims

- The dedicated dataset binding shape is supported: <https://developers.cloudflare.com/analytics/analytics-engine/get-started/>.
- One index is allowed and per-user indexing matches Cloudflare's sampling guidance: <https://developers.cloudflare.com/analytics/analytics-engine/sql-api/>.
- Sampling-weighted formulas are correct: counts and sums use `_sample_interval`: <https://developers.cloudflare.com/analytics/analytics-engine/sql-api/>.
- The SQL endpoint and `Account Analytics: Read` token permission are correct: <https://developers.cloudflare.com/analytics/analytics-engine/sql-api/>.
- The installed Anthropic SDK exposes separate 5-minute and 1-hour cache-write counters.
- The listed Sonnet 4.6 rates match Anthropic's standard rates and cache multipliers: <https://platform.claude.com/docs/en/about-claude/pricing>.

## Skills to use

- `code`: implementation and verification
- `cloudflare`: Analytics Engine binding, SQL API, and token setup
- `testing`: runner, adapter, and route behavior
- `changelog`: required before editing the agent changelog
- `impeccable`: admin cost UI changes
- `reproducible-locally`: prove ingestion and aggregation without manual UI steps
- `git-commit`: commit workflow
