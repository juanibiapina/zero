# Clerk webhook → Discord signup notice

`POST /api/webhooks/clerk` is a public route (no Clerk JWT) authenticated by the
Svix signature Clerk attaches to every webhook. On `user.created` it posts a
signup line to a Discord channel via an incoming webhook URL. The Discord call
runs in the background (`executionCtx.waitUntil`); the route returns `200`
immediately and never 5xxes on a Discord outage, so Clerk does not retry. A
bad or missing signature returns `401`.

Message format (name and email included, degrading gracefully):

```
🎉 New signup: Alice Smith — alice@example.com (user_abc123)
```

Code: `apps/api/src/routes/clerk-webhook.ts` (route + `formatSignupMessage` +
`handleClerkEvent`) and `apps/api/src/discord.ts` (`notifyDiscord`).

## Secrets

Both live in Doppler project `zero-api` (configs `dev` and `prd`); never
hand-edit `.dev.vars` (see `docs/secrets.md`).

- `CLERK_WEBHOOK_SIGNING_SECRET` — `whsec_…`, from the Clerk Dashboard webhook
  endpoint.
- `DISCORD_SIGNUP_WEBHOOK_URL` — the Discord channel's incoming webhook URL.

Set them:

```bash
doppler secrets set CLERK_WEBHOOK_SIGNING_SECRET="whsec_..." --project zero-api --config dev
doppler secrets set CLERK_WEBHOOK_SIGNING_SECRET="whsec_..." --project zero-api --config prd
doppler secrets set DISCORD_SIGNUP_WEBHOOK_URL="https://discord.com/api/webhooks/..." --project zero-api --config dev
doppler secrets set DISCORD_SIGNUP_WEBHOOK_URL="https://discord.com/api/webhooks/..." --project zero-api --config prd

bin/fetch-secrets                 # regenerate apps/api/.dev.vars
pnpm --dir apps/api cf-typegen    # regenerate Env types
bin/sync-secrets-to-cloudflare    # push prd secrets to the Worker (on deploy)
```

## Clerk Dashboard (one-time)

Dashboard → Webhooks → Add endpoint:

- URL: `https://zero.juanibiapina.dev/api/webhooks/clerk`
- Events: `user.created`

Copy the endpoint's signing secret into `CLERK_WEBHOOK_SIGNING_SECRET`.
