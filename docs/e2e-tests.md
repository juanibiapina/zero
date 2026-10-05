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
- **Mock OpenAI** (`src/mock-openai.ts`, port 3502) answers the agent's LLM
  calls at `POST /responses` with a canned non-streaming Response object. Its
  `output` is one assistant message and no function call, which the adapter
  reads as a final answer, so the mock never drives a tool loop.
  `POST /test/mode {"mode":"rate_limit"}` switches it to return HTTP 429s
  (reset with `DELETE /test/mode`).

`TELEGRAM_API_ROOT` and the LLM base URL are pointed at these mocks via
the test Worker config (`apps/zero-api/wrangler.test.jsonc`), so no real
Telegram or LLM traffic leaves the machine.

Current tests:

- `hello.test.ts` — a plain text message produces a reply.
- `attachments.test.ts` covers a generic document upload and Telegram file
  download through the user-owned file ingestion path.
- `rate-limit.test.ts` — a 429 from the model produces the rate-limit message.

Webhook update ids are deduped durably per user, so `buildWebhookUpdate`
generates a fresh id per call (seeded from the clock). A test that pins
`updateId` by hand is a no-op on the second run against the same worker state.

## Running

```bash
bin/e2e-test
```

The script (`bin/e2e-test`) orchestrates everything:

1. Serves `zero-api/development` secrets to the Worker dev server through a named pipe
   at `apps/zero-api/.dev.vars` (`zero vault run --mount`), so no plaintext
   file is written and nothing has to be restored afterwards. Requires a
   ZeroVault credential; `ZERO_API_URL` is optional.
2. Starts mock Telegram (:3501), mock OpenAI (:3502), and
   `vite dev --mode test` (:8791, inspector :9233). `--mode test` makes
   `apps/zero-api/vite.config.ts` load `wrangler.test.jsonc`, so the suite runs
   the same Vite pipeline that builds production.
3. Seeds KV so `tg:12345 → user_test`.
4. Runs the vitest suite in `packages/agent-e2e`.
5. Tears down all processes and ports on exit.

Because everything runs locally against mocks, this suite is safe to run
often. It is not yet wired into `bin/ci` (it needs ZeroVault credentials
and spins up several processes); run it on demand.

## Testing gotcha: LLM error paths

Unit tests inject failures at the `AgentModel` seam (`capturingModel` in `apps/zero-api/src/agents/mock-model.ts`), which is above the HTTP client, so nothing retries and a thrown error surfaces immediately. Classification reads `status`: see the 429 case in `apps/zero-api/src/agents/orchestrator.test.ts`, which throws `Object.assign(new Error("rate limited"), { status: 429 })`.

Only the e2e suite exercises the real OpenAI client, where a 429 is retried twice (`maxRetries: 2`) with backoff before it surfaces. That is why `packages/agent-e2e/src/rate-limit.test.ts` polls with a longer timeout.

## Related: mobile hermetic E2E

The mobile app extends the same local-Worker pattern to signed-in `/api/*`
behavior. `pnpm --filter @zero/agent-mobile e2e:pixel` loads the current checkout
from Metro into the attached Pixel 7 development client. One hermetic profile
selects fake Clerk auth, localhost networking, isolated device stores, and
suppressed launcher side effects. `wrangler.e2e.jsonc` trusts the local bearer as
the userId and writes to a fresh local Durable Object. The harness then asserts
the result through both the mobile UI and the Worker's HTTP interface. See
`apps/agent-mobile/README.md` ("End-to-end tests").
