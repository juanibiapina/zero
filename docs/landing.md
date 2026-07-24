# Zero landing site

`https://zeroapps.dev/` is Zero's public landing page. It introduces Vault and Errors and sends visitors to the authenticated dashboard at `https://dash.zeroapps.dev`.

The site lives in `apps/landing` (`@zero/landing`). It is an asset-only Cloudflare Worker: it has no Worker script, API, storage, Clerk setup, or runtime secrets.

## Local development

Start the Vite server:

```bash
pnpm --filter @zero/landing run dev
```

Vite serves the source site at `http://localhost:5180`.

Build the site, then serve its generated `dist` assets through Workers Assets:

```bash
pnpm --filter @zero/landing run build
pnpm --filter @zero/landing run dev:worker
```

The Worker listens on `http://localhost:8794` and serves only the built `dist` directory.

## Build and deploy

```bash
pnpm --filter @zero/landing run build
pnpm --filter @zero/landing run deploy
```

Workers Builds uses `apps/landing` as its root directory. Its production branch is `main`, with `pnpm run build` as the build command and `pnpm run deploy` as the deploy command.
