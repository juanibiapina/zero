# Plan: Discord ping on new signup

## Goal

Notify Discord when a user signs up, via Clerk's `user.created` webhook.
Mirrors the proven pattern in `juanibiapina/trippycards`.

## What to change and why

- **New route** `POST /api/webhooks/clerk` (`apps/api/src/routes/clerk-webhook.ts`),
  registered in `app.ts` **before** `clerkMiddleware()` — it's svix-signed, not
  JWT-authed. Verifies with the `svix` package (400 on bad/missing signature),
  handles `user.created`, ignores other types, always returns 200.
- **New Discord module** `apps/api/src/discord.ts`: deep interface
  `notifyDiscord(env, text)`, fire-and-forget. Message includes the new user's
  email: `"🎉 New Zero signup: <email>"`.
- **New secrets** (Doppler `zero-api` dev+prd): `CLERK_WEBHOOK_SIGNING_SECRET`,
  `DISCORD_WEBHOOK_URL` → then `wrangler types`. Add `svix` to `apps/api/package.json`.

## Tests

`clerk-webhook.test.ts`: sign payload with `wh.sign`, stub `fetch` — assert
Discord called on `user.created`, not called on other types, 400 on bad signature.

## Docs

This file + add the route to `docs/design.md`.

## Acceptance criteria

A real Clerk `user.created` event posts `"🎉 New Zero signup: <email>"` to Discord;
invalid signatures are rejected; CI is green.

## Manual (out of code)

Clerk dashboard → add webhook endpoint, subscribe to `user.created`, copy signing
secret to Doppler.
