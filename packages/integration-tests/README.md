# @zero/integration-tests

End-to-end integration tests that exercise the **deployed production
worker** by sending real Telegram messages as a user and asserting on
the bot's reply.

The test signs in to Telegram as a regular human user via MTProto
(gramjs), sends three messages into a pre-configured supergroup topic,
and asserts that the agent remembers the prior turns after a ~5.5 min
sleep that forces the per-user container to be idle-evicted. Every
layer of the stack runs for real — there are no mocks.

> Each run takes ~6.5 minutes (mostly sleeping) and costs ~$0.01 of
> Anthropic. Run on demand, not on every commit.

## Running

```bash
bin/integration-test
```

Setup is documented in [`docs/integration-tests.md`](../../docs/integration-tests.md).
