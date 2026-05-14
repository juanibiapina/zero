# Telegram Webhook Registration

Telegram doesn't pull updates — it pushes them to a URL we register. The
registration is a one-off manual step: we call Telegram's HTTP API to tell
it where to deliver updates and which secret token to echo back.

> Reference: <https://core.telegram.org/bots/api#making-requests> and
> <https://core.telegram.org/bots/api#setwebhook>.

## What you need

- `TELEGRAM_BOT_TOKEN` — from `@BotFather`, stored in Doppler `zero-api`.
- `TELEGRAM_WEBHOOK_SECRET` — any string we choose (recommended:
  `openssl rand -hex 32`), stored in Doppler `zero-api`. Telegram echoes
  this back in the `X-Telegram-Bot-Api-Secret-Token` header on every
  delivery; the worker rejects requests where it doesn't match.
- The public webhook URL: `https://zero.juanibiapina.dev/api/webhooks/telegram`.

Both secrets must already be set in Doppler and synced to Cloudflare
(`bin/sync-secrets-to-cloudflare`) before registering — otherwise the
worker will reject deliveries with 401.

## Making requests

All Telegram Bot API calls go to:

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/<METHOD>
```

Parameters can be passed as query string, `application/x-www-form-urlencoded`,
or `application/json`. We use JSON below.

## Register the webhook

```bash
TOKEN=$(doppler secrets get TELEGRAM_BOT_TOKEN       --plain --project zero-api --config prd)
SECRET=$(doppler secrets get TELEGRAM_WEBHOOK_SECRET --plain --project zero-api --config prd)

curl -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg url 'https://zero.juanibiapina.dev/api/webhooks/telegram' \
                --arg secret "$SECRET" \
                '{url: $url, secret_token: $secret, drop_pending_updates: true}')"
```

Expected response:

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

Notes:

- `secret_token` must be 1–256 chars, only `A-Z`, `a-z`, `0-9`, `_`, `-`.
- `drop_pending_updates: true` clears anything Telegram queued before the
  webhook existed. Omit it if you want to preserve a backlog.
- To restrict update types, add `allowed_updates`, e.g. `["message"]`.

## Inspect the current webhook

```bash
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | jq
```

Useful fields: `url`, `has_custom_certificate`, `pending_update_count`,
`last_error_date`, `last_error_message`. `last_error_message` is the first
thing to check when deliveries stop working.

## Remove the webhook

```bash
curl -X POST "https://api.telegram.org/bot${TOKEN}/deleteWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"drop_pending_updates": true}'
```

## Rotating the secret

1. Generate a new secret and update Doppler (`zero-api`, config `prd`).
2. `bin/sync-secrets-to-cloudflare` to push it to the worker.
3. Re-run the `setWebhook` call above with the new value.

Order matters: if you update Telegram before the worker, every delivery
fails until the worker catches up.
