# Environment Variables and Secrets

This document explains how environment variables and secrets are organized in the Zero project.

> **⚠️ Important**: Never manually edit `.dev.vars`, `.env.local`, or `.env.production` files. These are auto-generated from Doppler via `bin/fetch-secrets`. To change a secret, update it in Doppler and re-run `bin/fetch-secrets`.

## Secret Management with Doppler

All secrets are managed through [Doppler](https://www.doppler.com/). Secrets are organized across two Doppler projects:

- **`zero-api`**: Zero Cloudflare Worker secrets
- **`zero-web`**: Zero React app build-time secrets

| Doppler Project | Doppler Config | Target | Purpose |
|-----------------|----------------|--------|---------|
| `zero-api` | `dev` | `apps/api/.dev.vars` | Worker runtime variables for local development |
| `zero-api` | `prd` | Cloudflare Workers | Worker runtime variables for production (uploaded via wrangler) |
| `zero-web` | `dev` | `apps/web/.env.local` | Vite build-time variables for local development |
| `zero-web` | `prd` | `apps/web/.env.production` | Vite build-time variables for production builds |

### Setting Up Doppler Locally

1. **Install Doppler CLI**:
   ```bash
   # macOS
   brew install dopplerhq/cli/doppler

   # Other platforms: https://docs.doppler.com/docs/install-cli
   ```

2. **Authenticate**:
   ```bash
   doppler login
   ```

3. **Fetch secrets**:
   ```bash
   bin/fetch-secrets
   ```
   This script fetches all secrets from Doppler and generates the required environment files.

### Managing Secrets

**To view secrets** in a specific config:
```bash
doppler secrets --project zero-api --config dev
doppler secrets --project zero-web --config dev
```

**To update a secret**:
```bash
doppler secrets set VARIABLE_NAME="value" --project zero-api --config dev
```

After updating secrets in Doppler, run `bin/fetch-secrets` to regenerate local files.

### Syncing Production Secrets to Cloudflare

Production runtime secrets are stored in the `zero-api` Doppler project (config `prd`) and uploaded directly to Cloudflare Workers.

**To sync production secrets to Cloudflare**:
```bash
bin/sync-secrets-to-cloudflare
```

## File Structure

### `apps/api/.dev.vars` - Worker Runtime Variables (Local Development)

Contains variables used by the Cloudflare Worker at runtime during local development.

**Source**: Generated from Doppler project `zero-api`, config `dev`

### `apps/web/.env.local` - Vite Build-Time Variables (Local Development)

Contains variables used by Vite during local development builds.

**Source**: Generated from Doppler project `zero-web`, config `dev`

### `apps/web/.env.production` - Vite Build-Time Variables (Production Builds)

Contains variables used by Vite during production builds.

**Source**: Generated from Doppler project `zero-web`, config `prd`

## Production Deployment

1. **Worker runtime secrets**: Stored in `zero-api` Doppler project (config `prd`), synced to Cloudflare Workers using `bin/sync-secrets-to-cloudflare`

2. **Build-time variables**: Fetched from `zero-web` Doppler project → `apps/web/.env.production` (used during build)

3. **Deployment process**:
   ```bash
   # Optional: Sync production secrets if they changed in Doppler
   bin/sync-secrets-to-cloudflare

   # Deploy the application
   bin/deploy
   ```
