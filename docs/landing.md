# Zero landing site

`https://zeroapps.dev/` is Zero's public landing page. It introduces Vault and Errors and sends visitors to the authenticated dashboard at `https://dash.zeroapps.dev`.

The site lives in `apps/landing` (`@zero/landing`). It is a static Astro site served by an asset-only Cloudflare Worker: it has no Worker script, API, storage, Clerk setup, or runtime secrets. `astro build` emits static HTML with the CSS inlined into `<head>` and ships zero client JavaScript.

## Design

The page is black on white with no accent color. Its palette comes from the
console's own tokens in `packages/ui/src/styles.css`: `--background`,
`--foreground`, `--primary`, and `--primary-foreground` are copied byte for byte,
and four landing-only departures (`--muted-foreground`, `--border`,
`--primary-hover`, and a `--foreground` focus ring) are darker or lighter steps on
the same neutral ramp, each commented in `src/styles/global.css`.

Invariants:

- **Chroma 0.** Every color literal that ships from `apps/landing` is written
  `oklch(L 0 0)` — no hex, no `rgb()`/`hsl()`/`color-mix()`, no named color, no
  `currentColor`, no `transparent` — and every shipped PNG is grayscale. The
  landing page has no destructive, success, or warning state, so it needs no
  chromatic value.
- **No Tailwind CSS in the output.** `global.css` is hand-written; the built
  stylesheet contains nothing else. `astro.config.mjs` still registers
  `@tailwindcss/vite` and `package.json` still lists the two Tailwind
  devDependencies, but with no `@import "tailwindcss"` they emit zero bytes.
  Both are a known leftover, to be dropped by the next change that already
  touches `pnpm-lock.yaml`.
- **Light only.** The console ships light-only, so the landing page keeps
  `color-scheme: light` and defines no `prefers-color-scheme` block.
- Structure is one surface, a 68rem centered column, 1px rules, and varied
  vertical space. The hero button is the only filled surface and the only
  border-radius on the page.

## Local development

Start the Astro dev server:

```bash
pnpm --filter @zero/landing run dev
```

Astro serves the source site at `http://localhost:5180`.

Build the site, then serve its generated `dist` assets through Workers Assets:

```bash
pnpm --filter @zero/landing run build
pnpm --filter @zero/landing run dev:worker
```

The Worker listens on `http://localhost:8794` and serves only the built `dist` directory.

## SEO and social assets

Static files in `apps/landing/public/` are copied to the `dist/` root at build and
served verbatim by Workers Assets (exact paths are served directly, before
`not_found_handling` is ever consulted):

- `robots.txt` — allows all crawlers and points at the sitemap. Required for the
  Lighthouse `robots-txt` audit to pass. It is served as a real asset, so it is
  never affected by `not_found_handling`.
- `sitemap.xml` — lists the single public URL `https://zeroapps.dev/`. Served as
  `text/xml` (extension-based content type from Workers Assets); Google accepts
  that for sitemaps.
- `og-image.png` — 1200x630 social preview card (black Zero mark, wordmark, and
  headline on white, grayscale only). Referenced by the Open Graph and Twitter card tags in
  `src/pages/index.astro`. Regenerate by screenshotting a 1200x630 HTML with
  headless Chromium if the brand or copy changes.

`src/pages/index.astro` also carries Open Graph / Twitter card meta tags and a
JSON-LD `Organization` + `WebSite` block for rich search and social previews.

### Google Search Console verification (configured)

`zeroapps.dev` is registered in Google Search Console as a **Domain property**
(`sc-domain:zeroapps.dev`), owned by the `juanibiapina@gmail.com` Google account.
Ownership is verified by the DNS TXT method (domain-wide, covers all subdomains
and both protocols).

The verification TXT record lives on the `zeroapps.dev` Cloudflare zone:

- name `zeroapps.dev` (zone root)
- content `google-site-verification=hQox-dN1Py2KhUxpTk5wHPL3OJ8hADpeovBUoO-cLck`

**Do not delete this TXT record.** Removing it drops Search Console verification
and the property loses access to indexing, sitemaps, and performance data.

The `https://zeroapps.dev/sitemap.xml` sitemap is submitted in the property
(status Success). The homepage `https://zeroapps.dev/` was submitted for
indexing (priority crawl queue).

Alternative seam if the DNS record ever needs replacing with an in-code token:
a `<meta name="google-site-verification" content="…">` in the
`src/pages/index.astro` head. Requires a deploy per token, so DNS TXT is
preferred.

## Build and deploy

```bash
pnpm --filter @zero/landing run build
pnpm --filter @zero/landing run deploy
```

Workers Builds uses `apps/landing` as its root directory. Its production branch is `main`, with `pnpm run build` as the build command and `pnpm run deploy` as the deploy command.
