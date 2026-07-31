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

### ZeroVault: bot username for the web app

The widget script tag needs the bot's username at render time. Set it
in `zero-web` (both environments use the same bot today):

```bash
ZV="pnpm dlx zerovault-cli@0.1.0"
$ZV secrets set VITE_TELEGRAM_BOT_USERNAME=getzerobot -p zero-web -e production
$ZV secrets set VITE_TELEGRAM_BOT_USERNAME=getzerobot -p zero-web -e development
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

The worker validates payloads in `apps/agent-api/src/telegram-auth.ts`. The
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

## First conversation

A bot cannot initiate a conversation: `sendMessage` to a user who never
pressed START returns `403 Forbidden: bot can't initiate conversation with
a user`. Linking through the Login Widget proves identity but creates no
chat, so after `POST /api/telegram-link` there is nothing to send to.

So the web CTAs link to `https://t.me/<bot>?start=welcome`. Telegram
replaces the input bar with a **Start button** on any `?start=` link, even
if the user has already started the bot
([spec](https://core.telegram.org/api/links)). Pressing it delivers a
`/start` update, which is the first moment Zero can speak. The `welcome`
payload is unused today and kept for future attribution.

`/start` is handled in `apps/agent-api/src/commands/start.ts`:

- unlinked sender → a reply pointing at the web app (the same reply an
  ordinary message from an unlinked sender now gets, instead of silence)
- first contact → a real turn, so Zero introduces itself
- every later `/start` → a short canned ack, no model run

"First contact" is a one-shot claim in the store (`claimFirstContact`,
persisted as `user_settings.firstContactAt`). It is taken inside
`UserDO.enqueueTurn`, after the webhook dedupe gate, so the first turn a
user ever has carries the introduction note whether they pressed START,
typed `/start`, or asked a question straight away. Because it is persisted,
a relink, a DO eviction or a second `/start` never re-introduces Zero.

That same introduction message also **offers** a daily morning check-in and
asks what time suits the user. It is only an offer: nothing is scheduled
unless the user accepts, and the acceptance goes through the ordinary
`create_schedule` tool on a later turn. The offer rides on the first-contact
note precisely because that claim is already exactly-once, so it cannot
repeat and needs no flag of its own. Schedules are otherwise undiscoverable,
and this is the one moment Zero has the user's attention.
