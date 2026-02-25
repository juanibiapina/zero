# Instructions for AI Agents

## Development

During development, use `gob run bin/ci` to run all necessary checks including build, linter, tests etc.

## Deployment

To deploy to production:
```bash
gob run bin/deploy
```

## Architecture

Zero is an agent orchestrator with the following packages:

- **Worker:** `apps/api` (`@zero/api`)
- **Frontend:** `apps/web` (`@zero/web`)
- **Shared types:** `packages/core` (`@zero/core`)
- **Agent server:** `packages/agent-server` (`@zero/agent-server`)

Expected dev ports:
- **5176**: Web frontend (Vite)
- **8790**: API worker (Wrangler)

The worker backend follows a layered architecture pattern: Entry Point → App → Routes → Services → Durable Objects. See `docs/framework.md` for the full guide covering each layer's responsibilities, code patterns, and key constraints.

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

When you need to manage secrets (environment variables, API keys, etc.), refer to `docs/secrets.md` for instructions on how to use Doppler.

Doppler projects:
- `zero-api` — Worker backend secrets
- `zero-web` — Frontend build-time secrets

## Database Migrations

When making schema changes to Durable Objects, refer to `docs/migrations.md` for the migration workflow.

1. Edit schema file (`apps/api/src/{UserDO,ProjectDO,SessionDO}/db/schema.ts`)
2. Generate migration: `pnpm --filter @zero/api run db:generate`
3. Run `gob run bin/ci` to verify

**Do not rename migration files.** The `migrations.js` is auto-generated from `_journal.json`.
