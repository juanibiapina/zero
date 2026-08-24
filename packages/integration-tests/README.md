# @zero/integration-tests

Prod smoke test that exercises the **deployed production worker** by sending a
real Telegram message as a user and asserting the bot replies.

It signs in to Telegram as a regular human user via MTProto (gramjs), sends one
nonce-tagged message into a pre-configured supergroup topic, and waits for the
bot's reply containing that nonce. Every layer runs for real — Telegram
delivery, the webhook, the `UserDO` alarm, the pi-ai adapter, the Cloudflare AI
Gateway (BYOK), OpenAI, and the reply back into the topic. No mocks. It does not
check memory or persistence; it answers only "is the bot responding right now".

> One model call, a few seconds, ~$0.01. Run on demand, not on every commit.

## Running

```bash
bin/integration-test
```

Setup is documented in [`docs/integration-tests.md`](../../docs/integration-tests.md).
