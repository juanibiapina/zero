# Telegram Login Widget

The "Link Telegram" button on the Zero web app is Telegram's official
[Login Widget](https://core.telegram.org/widgets/login). The widget
posts a signed payload back to the page; the worker verifies the HMAC
and writes the KV mapping `clerk:{userId} ↔ tg:{telegramId}`.

## One-off setup

### BotFather: `/setdomain`

Telegram restricts the widget to a single domain per bot.

```
/setdomain
@getzerobot
zero.juanibiapina.dev
```

(Send each line as a separate message to `@BotFather`. The inline form
`/setdomain @getzerobot zero.juanibiapina.dev` also works.)

### Doppler: bot username for the web app

The widget script tag needs the bot's username at render time. Set it
in `zero-web` (both configs use the same bot today):

```bash
doppler secrets set VITE_TELEGRAM_BOT_USERNAME=getzerobot \
  --project zero-web --config prd
doppler secrets set VITE_TELEGRAM_BOT_USERNAME=getzerobot \
  --project zero-web --config dev
bin/fetch-secrets
```

No new worker secret is required — the worker validates payloads with
the existing `TELEGRAM_BOT_TOKEN`.

## Dev caveat

The widget only renders on the domain registered with BotFather. The
production domain (`zero.juanibiapina.dev`) is the one configured.
`localhost:5176` won't trigger the widget; **test sign-up flows in
production**.

To work around this in a pinch you can repoint `/setdomain` to
`localhost` for a session, but remember to flip it back. A second bot
for dev is overkill for one developer.

## Verification algorithm

The worker validates payloads in `apps/api/src/telegram-auth.ts`. The
recipe (from [Telegram's docs](https://core.telegram.org/widgets/login#checking-authorization)):

1. `secret_key = SHA-256(TELEGRAM_BOT_TOKEN)`
2. `data_check_string` = every field except `hash`, sorted alphabetically
   by key, formatted as `key=value`, joined with `\n`
3. `expected = HEX(HMAC-SHA-256(secret_key, data_check_string))`
4. Constant-time compare `expected` against `payload.hash`
5. Reject if `auth_date` is older than one hour (Telegram suggests
   ≤ 24h; we're stricter because the payload is produced and consumed
   in the same browser session)

## Re-linking

`POST /api/telegram-link` overwrites whatever Telegram id was bound to
the caller, clearing the previous reverse-index entry. To unlink
entirely call `DELETE /api/telegram-id`.
