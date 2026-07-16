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

Zero receives Telegram bot webhooks and routes each update to the right user via KV. Messages are handled by a two-phase meta-agent that runs inside the per-user `UserDO` Durable Object: an **interface agent** reads the conversation and a topic-based knowledge model (stored in DO SQLite) and replies to the user, then a **writer agent** consolidates what was learned back into the accessed topics. The interface agent and a **research agent** are the same runner (`agents/run.ts`) with different prompts and tools; the interface agent can call a `research` tool that spawns the research agent with web search (`WebSearch` port, Brave adapter) and returns its final message. The webhook enqueues each turn and returns 200 immediately; the turn (including any research loop) runs inline on a DO alarm. LLM calls go through the Cloudflare AI Gateway (BYOK Anthropic) with per-user `cf-aig-metadata` attribution. The web app is a single screen where a signed-in user links their Telegram account via Telegram's Login Widget (see `docs/telegram-login.md`). See `docs/topics.md` for the topic model and writer policy, and `docs/research.md` for the research agent.

Packages:

- **Worker:** `apps/api` (`@zero/api`)
- **Frontend:** `apps/web` (`@zero/web`)
- **Shared types:** `packages/core` (`@zero/core`) — currently empty placeholder
- **E2E tests:** `packages/e2e-tests` (`@zero/e2e-tests`) — end-to-end tests against a local worker with mock Telegram and Anthropic servers; run via `bin/e2e-test`. See `docs/e2e-tests.md`

Expected dev ports:
- **5176**: Web frontend (Vite)
- **8790**: API worker (Wrangler)

The worker follows a layered architecture: Entry Point → App → Routes → Durable Objects. See `docs/framework.md` and `docs/design.md`.

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
- `zero-api` — Worker backend secrets (also used by `bin/e2e-test`)
- `zero-web` — Frontend build-time secrets
