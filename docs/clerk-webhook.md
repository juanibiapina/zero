# Clerk webhook to Discord signup notice

`POST /api/webhooks/clerk` is a public route authenticated by the Svix signature
Clerk attaches to each webhook. On `user.created`, it posts a signup line to a
Discord incoming webhook. The Discord request runs in the background through
`executionCtx.waitUntil`; the route responds with `200` without waiting. A bad
or missing signature returns `401`. Discord failures are logged and swallowed,
so Clerk does not retry them.

## Agent

The Agent uses its own Clerk instance and Worker configuration.

- Endpoint: `https://zero.juanibiapina.dev/api/webhooks/clerk`
- Code: `apps/agent-api/src/routes/clerk-webhook.ts` and
  `apps/agent-api/src/discord.ts`
- ZeroVault project: `zero-api`
- Discord message: the existing Agent signup format with the user's name, email, and Clerk ID.

## Dashboard

The dashboard covers Vault and Errors. It has a separate Clerk instance and
Worker configuration from the Agent.

- Endpoint: `https://dash.zeroapps.dev/api/webhooks/clerk`
- Code: `apps/vault-api/src/routes/clerk-webhook.ts` and
  `apps/vault-api/src/discord.ts`
- ZeroVault project: `zerovault`
- Discord message: `🎉 New Zero dashboard signup: Alice Smith - alice@example.com (user_abc123)`

The dashboard endpoint is available only on `dash.zeroapps.dev`.
`api.zeroapps.dev/api/webhooks/clerk` returns `404`.

## Secrets

Each Worker needs these secrets in its own ZeroVault project, for both
`development` and `production` environments:

- `CLERK_WEBHOOK_SIGNING_SECRET`: the endpoint's `whsec_...` secret from Clerk.
- `DISCORD_SIGNUP_WEBHOOK_URL`: the Discord channel's incoming webhook URL.

For the dashboard:

```bash
ZV="pnpm dlx zerovault-cli@0.2.2"
$ZV secrets set CLERK_WEBHOOK_SIGNING_SECRET="whsec_..." -p zerovault -e development
$ZV secrets set CLERK_WEBHOOK_SIGNING_SECRET="whsec_..." -p zerovault -e production
$ZV secrets set DISCORD_SIGNUP_WEBHOOK_URL="https://discord.com/api/webhooks/..." -p zerovault -e development
$ZV secrets set DISCORD_SIGNUP_WEBHOOK_URL="https://discord.com/api/webhooks/..." -p zerovault -e production

bin/fetch-secrets
pnpm --dir apps/vault-api cf-typegen
bin/sync-secrets-to-cloudflare
```

Do not edit generated local environment files. See `docs/secrets.md`.

## Clerk setup

In the matching Clerk Dashboard, add an endpoint with:

- URL: the Agent or dashboard endpoint above
- Events: `user.created`

Copy the endpoint signing secret into that product's
`CLERK_WEBHOOK_SIGNING_SECRET`.
