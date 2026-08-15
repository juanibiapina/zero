# Telegram Webhook Registration

Telegram doesn't pull updates — it pushes them to a URL we register.
Registration is a one-off step per bot; thereafter the only reasons to
re-run it are to switch bots, rotate the secret, or recover from a
deletion.

> Reference: <https://core.telegram.org/bots/api#making-requests> and
> <https://core.telegram.org/bots/api#setwebhook>.

## Prerequisites

- `TELEGRAM_BOT_TOKEN` — from `@BotFather`, stored in ZeroVault `zero-api`.
- `TELEGRAM_WEBHOOK_SECRET` — any string we choose (recommended:
  `openssl rand -hex 32`), stored in ZeroVault `zero-api`. Telegram echoes
  this back in the `X-Telegram-Bot-Api-Secret-Token` header on every
  delivery; the worker rejects requests where it doesn't match.
- `TELEGRAM_BOT_INFO` — the JSON `result` of `getMe`, stored in ZeroVault
  `zero-api`. grammY uses this to skip the per-request `getMe` round trip
  when constructing a `Bot` inside the worker. See
  [Refreshing `TELEGRAM_BOT_INFO`](#refreshing-telegram_bot_info) below.
- The public webhook URL: `https://zero.juanibiapina.dev/api/webhooks/telegram`
  (hard-coded in the script).

All three secrets must be set in ZeroVault and synced to Cloudflare
(`bin/sync-secrets-to-cloudflare`) before registering — otherwise the
worker rejects deliveries (401) or fails to start the bot.

## Register the webhook

```bash
bin/set-telegram-webhook
```

The script reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` from
ZeroVault `zero-api/production`, calls `setWebhook` with `drop_pending_updates:
true`, and prints `getWebhookInfo` for inspection. Re-run any time
after rotating the secret, switching bots, or finding the webhook
unset.

## Privacy Mode (groups)

New bots default to Privacy Mode **on** (`can_read_all_group_messages:
false`). In groups they only see commands, mentions of `@<bot>`, and
replies to their own messages — *not* normal topic messages. Symptom:
webhook is healthy, `pending_update_count: 0`, but tail logs stay
silent when you send a message.

Fix in BotFather:

```
/setprivacy
```

Pick the bot, choose **Disable**. **Then remove the bot from the group
and re-add it** — Telegram caches the privacy flag at the moment of
join; toggling it in BotFather alone does nothing for existing
memberships.

After re-adding, refresh `TELEGRAM_BOT_INFO` (below) so the cached
`getMe` reflects `can_read_all_group_messages: true`.

## Refreshing `TELEGRAM_BOT_INFO`

Re-run when the bot's identity changes (rename via `@BotFather`, new
username, toggled `can_join_groups`/`can_read_all_group_messages`,
inline support, etc.). The value is not secret — it's the public
`getMe` response — but we keep it in ZeroVault for consistency.

```bash
ZERO="pnpm dlx @zeroapps/cli@0.6.0"
BOT_INFO=$($ZERO vault run -p zero-api -e production -- bash -c 'curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"' | jq -c .result)

$ZERO vault secrets set TELEGRAM_BOT_INFO="$BOT_INFO" -p zero-api -e production
$ZERO vault secrets set TELEGRAM_BOT_INFO="$BOT_INFO" -p zero-api -e development
bin/sync-secrets-to-cloudflare
```

## Inspect or remove the webhook

```bash
ZERO="pnpm dlx @zeroapps/cli@0.6.0"

# Inspect
$ZERO vault run -p zero-api -e production -- \
  bash -c 'curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"' | jq

# Remove (handy before switching bots, to silence the previous one)
curl -X POST "https://api.telegram.org/bot${TOKEN}/deleteWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"drop_pending_updates": true}'
```

`last_error_date` and `last_error_message` from `getWebhookInfo` are the
first place to look when deliveries stop working.

## Rotating the secret

1. Generate a new secret and update ZeroVault (`zero-api`, environments
   `development` and `production`).
2. `bin/sync-secrets-to-cloudflare` to push it to the worker.
3. `bin/set-telegram-webhook` to register the new value with Telegram.

Order matters: if you update Telegram before the worker, every delivery
fails until the worker catches up.
