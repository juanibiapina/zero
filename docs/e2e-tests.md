# E2E Tests

End-to-end tests that drive a **local** worker through the full turn
pipeline with the outside world stubbed out. Lives in
`packages/agent-e2e` and is run by `bin/e2e-test`.

## What it covers

Each test posts a Telegram webhook update to the worker and asserts on
the reply the worker sends back. Two external services are replaced by
mock HTTP servers so the test is fast, free, and deterministic:

- **Mock Telegram** (`src/mock-telegram.ts`, port 3501) captures every
  `sendMessage`/`sendChatAction` the worker makes and exposes them at
  `GET /test/messages` (cleared with `DELETE /test/messages`).
- **Mock Anthropic** (`src/mock-anthropic.ts`, port 3502) answers the
  agent's LLM calls with a canned non-streaming Messages response (the worker
  posts `stream: false` and parses JSON). Each response carries a fresh
  `msg_...` id, which the tool loop threads into the next request's
  `diagnostics.previous_message_id`. `POST /test/mode {"mode":"rate_limit"}`
  switches it to return HTTP 429s (reset with `DELETE /test/mode`).

`TELEGRAM_API_ROOT` and the LLM base URL are pointed at these mocks via
the test wrangler config (`apps/agent-api/wrangler.test.jsonc`), so no real
Telegram or Anthropic traffic leaves the machine.

Current tests:

- `hello.test.ts` — a plain text message produces a reply.
- `attachments.test.ts` covers a document upload. **Currently failing and
  stale:** it uploads a `text/plain` document and waits for a `getFile`
  download, but the worker only downloads image attachments and answers anything
  else with a notice. It needs rewriting around an image upload.
- `rate-limit.test.ts` — a 429 from the model produces the rate-limit message.

Webhook update ids are deduped durably per user, so `buildWebhookUpdate`
generates a fresh id per call (seeded from the clock). A test that pins
`updateId` by hand is a no-op on the second run against the same worker state.

## Running

```bash
bin/e2e-test
```

The script (`bin/e2e-test`) orchestrates everything:

1. Regenerates `apps/agent-api/.dev.vars` from ZeroVault (`zero-api/development`)
   and restores the original on exit. Requires `ZEROVAULT_API_KEY` and
   `ZEROVAULT_API_URL`.
2. Starts mock Telegram (:3501), mock Anthropic (:3502), and
   `wrangler dev --config wrangler.test.jsonc` (:8791).
3. Seeds KV so `tg:12345 → user_test`.
4. Runs the vitest suite in `packages/agent-e2e`.
5. Tears down all processes and ports on exit.

Because everything runs locally against mocks, this suite is safe to run
often. It is not yet wired into `bin/ci` (it needs ZeroVault credentials
and spins up several processes); run it on demand.

## Testing gotcha: LLM error paths

Unit tests inject failures at the `AgentModel` seam (`capturingModel` in `apps/agent-api/src/agents/mock-model.ts`), which is above the HTTP client, so nothing retries and a thrown error surfaces immediately. Classification reads `status`: see the 429 case in `apps/agent-api/src/agents/orchestrator.test.ts`, which throws `Object.assign(new Error("rate limited"), { status: 429 })`.

Only the e2e suite exercises the real Anthropic client, where a 429 is retried twice (`maxRetries: 2`) with backoff before it surfaces. That is why `packages/agent-e2e/src/rate-limit.test.ts` polls with a longer timeout.
