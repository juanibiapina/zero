# Environment Variables and Secrets

This document explains how environment variables and secrets are organized in the Zero project.

> **⚠️ Important**: Never manually edit `.dev.vars`, `.env.local`, or `.env.production` files. These are auto-generated from ZeroVault via `bin/fetch-secrets`. To change a secret, update it in ZeroVault and re-run `bin/fetch-secrets`.

## Secret Management with ZeroVault

All secrets are managed through [ZeroVault](https://zerovault.juanibiapina.dev), a self-hosted secrets manager. Secrets are organized across two ZeroVault projects, each with `development` and `production` environments:

- **`zero-api`**: Zero Cloudflare Worker secrets (also loaded by `bin/e2e-test`)
- **`zero-web`**: Zero React app build-time secrets

| ZeroVault Project | Environment | Target | Purpose |
|-------------------|-------------|--------|---------|
| `zero-api` | `development` | `apps/api/.dev.vars` | Worker runtime variables for local development |
| `zero-api` | `production` | Cloudflare Workers | Worker runtime variables for production (uploaded via wrangler) |
| `zero-web` | `development` | `apps/web/.env.local` | Vite build-time variables for local development |
| `zero-web` | `production` | `apps/web/.env.production` | Vite build-time variables for production builds |

### Prerequisites

Set these in your shell environment:

- `ZEROVAULT_API_KEY` — your ZeroVault API key
- `ZEROVAULT_API_URL` — `https://zerovault.juanibiapina.dev`

The CLI is run on demand via `pnpm dlx zerovault-cli@0.1.0` (no install needed). Optionally alias it:

```bash
alias zv='pnpm dlx zerovault-cli@0.1.0'
```

### Fetching Secrets Locally

```bash
bin/fetch-secrets
```

This downloads all development and build-time secrets from ZeroVault and generates the required environment files. Values are downloaded as JSON and serialized to dotenv by `bin/json-to-dotenv.mjs`, so multiline (PEM) and JSON secrets round-trip through wrangler and Vite correctly.

### Managing Secrets

**To view secrets** in a project/environment (values masked):
```bash
pnpm dlx zerovault-cli@0.1.0 secrets list -p zero-api -e development
```

**To get a single value**:
```bash
pnpm dlx zerovault-cli@0.1.0 secrets get CLERK_SECRET_KEY -p zero-api -e development
```

**To update a secret**:
```bash
pnpm dlx zerovault-cli@0.1.0 secrets set VARIABLE_NAME=value -p zero-api -e development
```

Or use the web portal at https://zerovault.juanibiapina.dev.

After updating secrets in ZeroVault, run `bin/fetch-secrets` to regenerate local files.

### Syncing Production Secrets to Cloudflare

Production runtime secrets are stored in the `zero-api` project (`production` environment) and uploaded directly to Cloudflare Workers.

**To sync production secrets to Cloudflare**:
```bash
bin/sync-secrets-to-cloudflare
```

## File Structure

### `apps/api/.dev.vars` - Worker Runtime Variables (Local Development)

Contains variables used by the Cloudflare Worker at runtime during local development.

**Source**: Generated from ZeroVault project `zero-api`, environment `development`

### `apps/web/.env.local` - Vite Build-Time Variables (Local Development)

Contains variables used by Vite during local development builds.

**Source**: Generated from ZeroVault project `zero-web`, environment `development`

### `apps/web/.env.production` - Vite Build-Time Variables (Production Builds)

Contains variables used by Vite during production builds.

**Source**: Generated from ZeroVault project `zero-web`, environment `production`

## Production Deployment

1. **Worker runtime secrets**: Stored in `zero-api` project (`production` environment), synced to Cloudflare Workers using `bin/sync-secrets-to-cloudflare`

2. **Build-time variables**: Fetched from `zero-web` project → `apps/web/.env.production` (used during build)

3. **Deployment process**:
   ```bash
   # Optional: Sync production secrets if they changed in ZeroVault
   bin/sync-secrets-to-cloudflare

   # Deploy the application
   bin/deploy
   ```
