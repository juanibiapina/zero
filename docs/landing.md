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

## SEO and social assets

Static files in `apps/landing/public/` are copied to the `dist/` root at build and
served verbatim by Workers Assets (exact paths take precedence over the SPA
fallback):

- `robots.txt` — allows all crawlers and points at the sitemap. Required for the
  Lighthouse `robots-txt` audit to pass (without it the SPA fallback returns the
  HTML shell for `/robots.txt`, which Lighthouse parses as invalid).
- `sitemap.xml` — lists the single public URL `https://zeroapps.dev/`. Served as
  `text/xml` (extension-based content type from Workers Assets); Google accepts
  that for sitemaps.
- `og-image.png` — 1200x630 social preview card (Zero wordmark on the brand dark
  background). Referenced by the Open Graph and Twitter card tags in
  `index.html`. Regenerate by screenshotting a 1200x630 HTML with headless
  Chromium if the brand or copy changes.

`index.html` also carries Open Graph / Twitter card meta tags and a JSON-LD
`Organization` + `WebSite` block for rich search and social previews.

### Google Search Console verification (seam, not yet configured)

The site is not yet registered in Google Search Console. Two seams when it is:

- **DNS TXT** on the `zeroapps.dev` Cloudflare zone
  (`google-site-verification=…`). Zone-level, no code change, verifies the whole
  domain. Preferred.
- **Meta tag**: `<meta name="google-site-verification" content="…">` in the
  `index.html` head. Requires a deploy per token.

## Build and deploy

```bash
pnpm --filter @zero/landing run build
pnpm --filter @zero/landing run deploy
```

Workers Builds uses `apps/landing` as its root directory. Its production branch is `main`, with `pnpm run build` as the build command and `pnpm run deploy` as the deploy command.
