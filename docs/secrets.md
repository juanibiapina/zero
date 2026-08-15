# Environment Variables and Secrets

No secret is written to disk. `zero vault run` starts a command with the secrets
it needs and removes every trace when the command exits. There is no
`bin/fetch-secrets` and there are no generated `.dev.vars` or `.env` files.

## Where each value comes from

| Value | Source of truth | Who reads it |
|---|---|---|
| Worker secrets (`TELEGRAM_BOT_TOKEN`, `CLERK_SECRET_KEY`, `MASTER_KEY`, …) | ZeroVault `zero-api`, `zerovault` | `wrangler dev` locally, Worker secrets in production |
| Web build values (`VITE_CLERK_PUBLISHABLE_KEY`, `VITE_TELEGRAM_BOT_USERNAME`) | ZeroVault `zero-web`, `zerovault-web` | Vite, locally and in `pnpm run build:agent` |
| The same web build values, for production builds | The Workers Builds connector on each Worker | The Cloudflare build, which has no ZeroVault credential |

The web build values are public: they are compiled into the bundle and served to
every visitor. They are copied on the Cloudflare connectors on purpose, so a
deploy never depends on ZeroVault being reachable. Two copies can drift, so run
`bin/check-build-vars` after rotating one.

## Local development

`pnpm turbo dev` needs a ZeroVault credential, because each `dev` script fetches
its own secrets:

```bash
zero login          # or export ZERO_API_KEY
pnpm turbo dev
```

With no network, those commands exit with status 75 and the app does not start.

The two Worker `dev` scripts use `--mount`:

```
zero vault run -p zero-api -e development --mount .dev.vars -- wrangler dev ...
```

That serves `.dev.vars` through a named pipe. Do not replace it with plain
environment variables. Wrangler treats the two routes differently:

1. If a real `.dev.vars` file exists, Wrangler reads it and ignores everything
   else. A stale file therefore wins silently. Delete it.
2. With no `.dev.vars`, Wrangler copies the **whole host environment** into the
   Worker's bindings whenever the config declares `secrets`. A variable exported
   in your shell, such as `TELEGRAM_BOT_TOKEN`, would override the vault value.
3. On that route Wrangler also drops any key that is not listed in `vars` or
   `secrets.required`, with no error.

The mount avoids all three.

## Building and deploying

| Command | What it does |
|---|---|
| `pnpm run build` | Builds everything with whatever `VITE_*` is set. Used by Cloudflare and CI |
| `pnpm run build:agent` | Builds `agent-web` with `zero-web` production values, byte-identical to production |
| `pnpm run build:dashboard` | The same for `dashboard-web` with `zerovault-web` |
| `pnpm run deploy:agent` | Builds and deploys `zero-api` with production values |
| `pnpm run deploy:dashboard` | Builds and deploys `zerovault-api` |
| `pnpm run deploy:sites` | Deploys landing and docs, which carry no build values |

There is no root `deploy` script on purpose: an unwrapped whole-repo deploy
would ship a bundle built with no values in it.

Deploys normally happen by pushing to `main`. The commands above are for a
manual deploy from a laptop.

## Production Worker secrets

```bash
bin/sync-secrets-to-cloudflare
```

That pushes `zero-api` and `zerovault` production secrets to the two Workers
through `wrangler secret bulk`, piping JSON with no file in between.

## CI

The GitHub Actions build job holds no credential. It sets `pk_test_ci` and
`ci-bot` for the two public build values, because it proves that the code
compiles, not that the configuration is right. `bin/check-build-vars` covers the
configuration.

## Analytics Engine reporting

`CLOUDFLARE_ANALYTICS_TOKEN` belongs in the `zero-api` development and
production environments. Create it as a custom Cloudflare token with only
**Account → Account Analytics → Read** for the Zero account. It reads the
`zero-ai-usage` dataset for admin reports. Model calls write through the
`AI_USAGE` Worker binding and do not use this token.

Before deploying code that lists a new secret in `secrets.required`:

1. Store the secret in both `zero-api` environments.
2. Run `bin/sync-secrets-to-cloudflare` to set the production Worker secret.

Do not reuse `CLOUDFLARE_API_KEY`, which authenticates AI Gateway requests and
has a different purpose.
