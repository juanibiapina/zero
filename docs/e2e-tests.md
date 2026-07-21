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
  agent's LLM calls with canned responses. `POST /test/mode {"mode":"rate_limit"}`
  switches it to return HTTP 429s (reset with `DELETE /test/mode`).

`TELEGRAM_API_ROOT` and the LLM base URL are pointed at these mocks via
the test wrangler config (`apps/agent-api/wrangler.test.jsonc`), so no real
Telegram or Anthropic traffic leaves the machine.

Current tests:

- `hello.test.ts` — a plain text message produces a reply.
- `attachments.test.ts` — a document upload is handled.
- `rate-limit.test.ts` — a 429 from the model produces the rate-limit message.

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

When unit-testing an LLM error path through the Vercel AI SDK (`generateText`), throw a **non-retryable** error. A plain error carrying `statusCode` works; a default `APICallError` with a retryable status does not. Otherwise the SDK retries with exponential backoff and the test hangs past vitest's 5s timeout. Don't attach a `retry-after` header in these tests either. See the 429 case in `apps/agent-api/src/agents/orchestrator.test.ts`, which throws `Object.assign(new Error("rate limited"), { statusCode: 429 })`.
