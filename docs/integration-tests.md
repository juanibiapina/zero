# Integration tests (prod smoke)

A single smoke test that drives the **deployed production worker** by sending a
real Telegram message as a real user account and waiting for the bot's reply.
Lives in `packages/integration-tests`.

## What it covers

`src/smoke.test.ts` sends one nonce-tagged message into the test topic and
asserts the bot replies with that nonce. Passing proves the whole live path:

```
Telegram (user account)
  → POST /api/webhooks/telegram (secret-token auth)
    → KV (tg:* → clerk) → UserDO.enqueueTurn → alarm
      → pi-ai adapter → Cloudflare AI Gateway (BYOK) → OpenAI (gpt-6-luna)
        → reply persisted → grammY sendMessage
          → Telegram (back into the same topic)
```

One model call, a few seconds of latency, ~$0.01. Not wired into `bin/ci`.

## One-time setup

### 1. Register a Telegram application

Go to <https://my.telegram.org/apps>, log in with your phone number, and create
an app (title `zero-integration-tests`, platform Other/Desktop). Capture the
`api_id` (numeric) and `api_hash` (hex). This pair identifies the test program
to Telegram, is reusable forever, and is **not** a user credential. See the
[Telegram docs](https://core.telegram.org/api/obtaining_api_id).

### 2. Set up the test topic

The test uses **your own Telegram account** as the source user, talking to the
bot from inside a forum topic. You need:

- A supergroup with topics enabled.
- The bot added as a member.
- A dedicated topic (e.g. "zero-tests"), separate from any you use day-to-day.

Capture two ids from a `wrangler tail` `forwarded_message` log line after
sending a message into the topic:

- **`TG_TEST_CHAT_ID`** — the supergroup id, of the form `-100…` (`chat_id`).
- **`TG_TEST_THREAD_ID`** — the topic's `message_thread_id` (`thread_id`).

### 3. Create the ZeroVault project

```bash
zero vault projects create zero-tests
```

Populate the `development` environment (`TG_TEST_SESSION_STRING` is filled in by
the next step):

```bash
zero vault secrets set TG_TEST_API_ID="..."           -p zero-tests -e development
zero vault secrets set TG_TEST_API_HASH="..."         -p zero-tests -e development
zero vault secrets set TG_TEST_CHAT_ID="-100..."      -p zero-tests -e development
zero vault secrets set TG_TEST_THREAD_ID="..."        -p zero-tests -e development
zero vault secrets set TG_TEST_BOT_USERNAME="getzerobot" -p zero-tests -e development
zero vault secrets set TG_TEST_SESSION_STRING=""      -p zero-tests -e development
```

(`zero` is `pnpm dlx @zeroapps/cli@0.7.0`; needs `ZERO_API_KEY`.)

### 4. Capture a session string

The session string is the per-user credential. Capture it once via SMS login,
with the two API vars injected from the vault:

```bash
zero vault run -p zero-tests -e development -- \
  pnpm --filter @zero/integration-tests login
```

The script prompts for your phone number (with country code), the login code
Telegram sends, and your 2FA password if any, then prints a long blob. Store it:

```bash
zero vault secrets set TG_TEST_SESSION_STRING="<the printed blob>" \
  -p zero-tests -e development
```

The session is long-lived but not immortal: revoking the
"zero-integration-tests" session in Telegram's **Settings → Devices**, or long
inactivity, invalidates it. When the test fails with "Telegram session is not
authorised", re-run the login step.

### 5. Link your Telegram id in Zero

The webhook routes by `tg:<your-telegram-id>` in KV. Make sure that mapping
exists by linking your Telegram account in the web app (see
[`telegram-login.md`](telegram-login.md)). If you already use the bot normally,
no action needed.

## Running

```bash
bin/integration-test
```

The wrapper loads every `TG_TEST_*` var from ZeroVault (`zero-tests/development`)
into the environment for the vitest process and ends with `1 passed`. On success
both messages (sent + reply) are deleted from the topic; on failure they stay
for inspection.

## Adding more tests

Add another `*.test.ts` under `packages/integration-tests/src/`. The vitest
config runs files sequentially (single worker), so one session string is enough.
Follow the same pattern: nonce-tagged prompts, topic-scoped polling, and
delete-on-success cleanup.

## CI

Not wired into `bin/ci` — cost and runtime make it a poor fit for per-PR runs. A
scheduled GitHub Actions workflow can call `bin/integration-test` as a prod
health check.
