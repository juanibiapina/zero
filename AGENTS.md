# Instructions for AI Agents

## Development

During development, use `gob run bin/ci` to run all necessary checks including build, linter, tests etc.

## Deployment

Pushing to `main` auto-deploys to production via the Cloudflare Git
connector (Workers Builds). No manual step is needed; after pushing,
wait for the Cloudflare build to finish. GitHub Actions CI only lints,
typechecks, tests, and runs a deploy dry-run; it does not deploy.

To deploy manually (e.g. from a branch, without pushing):
```bash
gob run bin/deploy
```

## Architecture

Zero receives Telegram bot webhooks, routes each update to the right user via KV, and forwards forum-topic messages to a per-user Cloudflare Container that runs [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). The agent's reply is sent back into the same Telegram topic. Telegram attachments (photos, PDFs, any file) are downloaded by the worker and written to `/workspace/attachments` inside the container. The container's entire `/workspace` tree (pi sessions, notes, attachments, and working files) persists as a single `state.tar.gz` archive per user on R2, restored on boot and saved on each turn through the worker, so conversations survive container sleep/wake. The web app is a single screen where a signed-in user links their Telegram account via Telegram's Login Widget (see `docs/telegram-login.md`).

Packages:

- **Worker:** `apps/api` (`@zero/api`)
- **Frontend:** `apps/web` (`@zero/web`)
- **Shared types:** `packages/core` (`@zero/core`) — currently empty placeholder
- **Agent server:** `packages/agent-server` (`@zero/agent-server`) — pi-coding-agent wrapped as an HTTP server, packaged as the container image
- **Integration tests:** `packages/integration-tests` (`@zero/integration-tests`) — end-to-end Telegram round-trip test against prod; see `docs/integration-tests.md`

Expected dev ports:
- **5176**: Web frontend (Vite)
- **8790**: API worker (Wrangler)

The worker follows a layered architecture: Entry Point → App → Routes → Durable Objects. See `docs/framework.md` and `docs/design.md`. Per-user R2 mount setup is in `docs/r2-mount.md`.

## Production Logs

```bash
gob add pnpm --dir apps/api exec wrangler tail
```

## Dev Server

The dev server is auto-started via gobfile (`.config/gobfile.toml`) running `pnpm turbo dev`. It should already be running - check with `gob list`. Do not start new dev server jobs; reuse the existing one.

If ports are unavailable or an app doesn't load, there may be lingering processes that need to be killed:
```bash
lsof -ti :5176 | xargs -r kill -9
lsof -ti :8790 | xargs -r kill -9
```

Then restart the dev server with `gob restart <job_id>`.

## Secrets

When you need to manage secrets (environment variables, API keys, etc.), refer to `docs/secrets.md` for instructions on how to use ZeroVault. The CLI runs via `pnpm dlx zerovault-cli@0.1.0` and needs `ZEROVAULT_API_KEY` and `ZEROVAULT_API_URL` env vars.

ZeroVault projects (each with `development` and `production` environments):
- `zero-api` — Worker backend secrets
- `zero-web` — Frontend build-time secrets
- `zero-tests` — Integration-test secrets (Telegram MTProto app + session)
