# Integration Tests

End-to-end test that drives the **deployed production worker** by
sending a real Telegram message as a real user account and waiting for
the bot's reply. Lives in `packages/integration-tests`.

## What it covers

A single test (`src/session-persistence.test.ts`) drives three turns in
the same topic:

1. Send a message mentioning `1`. Wait for any bot reply.
2. Send a message mentioning `2`. Wait for any bot reply.
3. Sleep ~5.5 minutes so Cloudflare Containers' `sleepAfter = 5 min`
   idle-evicts the per-user container; pi's in-memory session map is
   lost.
4. Send "what is the next number?" and assert the bot replies `3`.

The only way step 4 can succeed is if the cold-started container
resumes the prior conversation from the restored `/workspace` state
archive (`GET /state` on boot) via `SessionManager.continueRecent`.
Passing the test therefore proves both the basic round-trip *and* the
durable-session path.

Full production layering exercises end-to-end:

```
Telegram (user account)
  → POST /api/webhooks/telegram (secret-token auth)
    → waitUntil → KV (tg:* → clerk)
      → AgentContainer (getByName) → restore /workspace via /state
        → pi-coding-agent (lazy-resume on cold start) → Anthropic
          → POST http://zero.worker/message-end → grammY sendMessage
            → Telegram (back into the same topic)
```

Each run takes ~6.5 min (the 5.5 min sleep dominates) and costs ~$0.01
of Anthropic. Not wired into `bin/ci`.

## One-time setup

### 1. Register a Telegram application

Go to <https://my.telegram.org/apps>, log in with your phone number, and
create an app:

- App title: `zero-integration-tests`
- Short name: anything
- Platform: Other / Desktop

Capture the `api_id` (numeric) and `api_hash` (hex). This pair
identifies the test program to Telegram; it's reusable forever and is
**not** a user credential. See
[Telegram docs](https://core.telegram.org/api/obtaining_api_id).

### 2. Set up the test topic

The test uses **your own Telegram account** as the source user, talking
to `@getzerobot` from inside a forum topic. You need:

- A supergroup with topics enabled.
- The bot added as a member.
- A dedicated topic (e.g. "zero-tests") inside that supergroup, separate
  from any topic you actually use day-to-day.

Capture two ids:

- **`TG_TEST_CHAT_ID`** — the supergroup id, of the form `-100…`. The
  easiest way: send any message into the test topic, then look it up in
  `wrangler tail` for the worker — the `forwarded_message` log line
  carries `chat_id`.
- **`TG_TEST_THREAD_ID`** — the topic's `message_thread_id`. Same log
  line carries `thread_id`.

### 3. Create the ZeroVault project

```bash
pnpm dlx zerovault-cli@0.1.0 projects create zero-tests
```

This creates `development` and `production` environments. Populate the
`development` environment with placeholder values for now
(`TG_TEST_SESSION_STRING` gets filled in by the next step):

```bash
ZV="pnpm dlx zerovault-cli@0.1.0"
$ZV secrets set TG_TEST_API_ID="..."          -p zero-tests -e development
$ZV secrets set TG_TEST_API_HASH="..."        -p zero-tests -e development
$ZV secrets set TG_TEST_CHAT_ID="-100..."     -p zero-tests -e development
$ZV secrets set TG_TEST_THREAD_ID="..."       -p zero-tests -e development
$ZV secrets set TG_TEST_BOT_USERNAME="getzerobot" -p zero-tests -e development
$ZV secrets set TG_TEST_SESSION_STRING=""     -p zero-tests -e development
```

### 4. Capture a session string

The session string is the per-user credential. Capture it once via SMS
login:

```bash
eval "$(pnpm dlx zerovault-cli@0.1.0 secrets download -p zero-tests -e development --format shell)" \
  && pnpm --filter @zero/integration-tests login
```

The script prompts for your phone number (with country code), the SMS
code Telegram sends, and your 2FA password if you have one. It then
prints a long base64-looking blob. Paste it into ZeroVault:

```bash
pnpm dlx zerovault-cli@0.1.0 secrets set TG_TEST_SESSION_STRING="<the printed blob>" \
  -p zero-tests -e development
```

The session string is long-lived but not immortal: Telegram can
invalidate it if you revoke the "zero-integration-tests" session in
Telegram's `Settings → Devices`, or after long periods of inactivity.
When the test fails with "Telegram session is not authorised", re-run
the login step.

### 5. Link your Telegram id in Zero

The webhook routes messages by looking up `tg:<your-telegram-id>` in
KV. Make sure that mapping exists by signing in to
<https://zero.juanibiapina.dev> and clicking **Log in with Telegram**;
the Login Widget posts a signed payload that the worker verifies and
uses to write the KV mapping. (If you've already done this for normal
use, no action needed.) See [`telegram-login.md`](telegram-login.md).

## Running the test

```bash
bin/integration-test
```

The wrapper loads every `TG_TEST_*` var from ZeroVault
(`zero-tests/development`) into the environment for the vitest process.

A successful run takes ~6.5 minutes and ends with `1 passed`. The 5.5
min sleep between turns 2 and 3 dominates the wall-clock; the test
logs `[test] turn 2 acknowledged; sleeping 330s…` when it enters the
sleep so you know it isn't hung. On success, all six messages (three
sent, three replies) are deleted from the topic. On failure, the
remaining messages stay behind so you can inspect them.

## Adding more tests

Add another `*.test.ts` file under `packages/integration-tests/src/`.
The vitest config runs files sequentially (`fileParallelism: false`,
single worker) so a single Telegram session string is enough.
Fast smoke tests (no 5-minute sleep) can live alongside
`session-persistence.test.ts` — follow the same pattern of nonce-tagged
prompts, topic-scoped polling, and delete-on-success cleanup.

## CI

Not wired into `bin/ci` today — cost and runtime make it a poor fit for
per-PR runs. A future GitHub Actions cron workflow can call
`bin/integration-test` on a schedule.

## Cost notes

- **Anthropic**: three turns with no tools is a couple of cents on
  `claude-opus-4-8` at thinking level `high`.
- **Cloudflare Containers**: each run wakes the container if it was
  idle (free billable seconds, mostly).
- **Telegram**: free, but counts toward your account's normal rate
  limits.

If you run the test in a tight loop (don't), the bot's rate limit on
`sendMessage` will start returning 429 long before you spend real
money.
