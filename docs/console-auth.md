# Console authentication

The Zero dashboard is served from `https://dash.zeroapps.dev`. Vault lives under
`/vault/*` and Errors under `/errors/*`, so both products share one browser
origin, Clerk session, and sign-in flow.

## Clerk instances

- **Dashboard:** one Clerk instance with `zeroapps.dev` as its primary domain.
  Its Clerk frontend API and account portal are `clerk.zeroapps.dev` and
  `accounts.zeroapps.dev`; `dash.zeroapps.dev` is an allowed subdomain.
- **Agent:** a separate Clerk instance for `zero.juanibiapina.dev`. Do not merge
  its keys or domains with the dashboard instance.

`AuthProvider` uses relative `/sign-in` and `/sign-up` paths. Sign-in returns to
`/vault/projects` by default, while dashboard product links stay on the same
origin and preserve the session.

## Signup webhook

In the dashboard Clerk instance, add a webhook endpoint for dashboard account
creation:

- URL: `https://dash.zeroapps.dev/api/webhooks/clerk`
- Event: `user.created`

Store the endpoint's signing secret as `CLERK_WEBHOOK_SIGNING_SECRET` in the
`zerovault` ZeroVault project. Set `DISCORD_SIGNUP_WEBHOOK_URL` there for the
Discord notification channel. Both secrets are required in `development` and
`production`. See `docs/clerk-webhook.md` for the full setup.

## Domain changes

Changing the Clerk frontend domain reissues the publishable key. Before a
cutover, update the Clerk DNS records, Google OAuth callback, allowed origins,
worker `CLERK_SECRET_KEY`, local dashboard env files, and the Workers Build
`VITE_CLERK_PUBLISHABLE_KEY` value. Verify in a fresh browser session before
retiring old domains.
