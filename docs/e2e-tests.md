# E2E Tests

End-to-end tests that drive a **local** worker through the full turn
pipeline with the outside world stubbed out. Lives in
`packages/e2e-tests` and is run by `bin/e2e-test`.

## What it covers

Each test posts a Telegram webhook update to the worker and asserts on
the reply the worker sends back. Two external services are replaced by
mock HTTP servers so the test is fast, free, and deterministic:

- **Mock Telegram** (`src/mock-telegram.ts`, port 3501) captures every
  `sendMessage`/`sendChatAction` the worker makes and exposes them at
  `GET /test/messages` (cleared with `DELETE /test/messages`).
- **Mock Anthropic** (`src/mock-anthropic.ts`, port 3502) answers the
  agent's LLM calls with canned responses.

`TELEGRAM_API_ROOT` and the LLM base URL are pointed at these mocks via
the test wrangler config (`apps/api/wrangler.test.jsonc`), so no real
Telegram or Anthropic traffic leaves the machine.

Current tests:

- `hello.test.ts` — a plain text message produces a reply.
- `attachments.test.ts` — a document upload is handled.

## Running

```bash
bin/e2e-test
```

The script (`bin/e2e-test`) orchestrates everything:

1. Regenerates `apps/api/.dev.vars` from ZeroVault (`zero-api/development`)
   and restores the original on exit. Requires `ZEROVAULT_API_KEY` and
   `ZEROVAULT_API_URL`.
2. Starts mock Telegram (:3501), mock Anthropic (:3502), and
   `wrangler dev --config wrangler.test.jsonc` (:8791).
3. Seeds KV so `tg:12345 → user_test`.
4. Runs the vitest suite in `packages/e2e-tests`.
5. Tears down all processes and ports on exit.

Because everything runs locally against mocks, this suite is safe to run
often. It is not yet wired into `bin/ci` (it needs ZeroVault credentials
and spins up several processes); run it on demand.
