# Plan: Lighthouse SEO 100 for zeroapps.dev landing page

## Goal

Make the production landing page at `https://zeroapps.dev` score **100** on the
Lighthouse **SEO** category on both the mobile (default) and desktop
(`--preset=desktop`) presets, verified by rerunning Lighthouse against
production after deploy. Add standard SEO hygiene (sitemap, social cards,
structured data) and leave a documented seam for Google Search Console
verification. Do not regress the other three categories.

## Owning app (recon result)

`https://zeroapps.dev` is served by **`apps/landing`** (`@zero/landing`) in this
repo (`juanibiapina/zero`). It is an **asset-only Cloudflare Worker** (worker
name `zero-landing`), no Worker script, configured in
`apps/landing/wrangler.jsonc`:

```jsonc
"assets": { "directory": "./dist", "not_found_handling": "single-page-application" },
"routes": [{ "pattern": "zeroapps.dev", "custom_domain": true }]
```

It is a Vite + React 19 SPA. The head lives in `apps/landing/index.html`; the
page body is client-rendered from `apps/landing/src/App.tsx`. Static files live
in `apps/landing/public/` (Vite copies them to `dist/` root at build).
Background doc: `docs/landing.md`.

The local clone was 16 commits behind `origin/main` during recon; `apps/landing`
and `apps/dashboard-web` only exist on the up-to-date `main`. Work from current
`main`.

## Root cause of the current SEO score (evidence)

Baseline Lighthouse run against production `https://zeroapps.dev`
(Chromium headless on this box), category scores:

| Category | Mobile | Desktop |
|---|---|---|
| Performance | 96 | 100 |
| Accessibility | 94 | 94 |
| Best Practices | 100 | 100 |
| **SEO** | **92** | **92** |

The **only failing scored SEO audit**, identical on both presets:

- **`robots-txt`** — score 0, "robots.txt is not valid", `23 errors found`.

Cause: `not_found_handling: "single-page-application"` makes the Worker return
`index.html` (HTTP 200, `content-type: text/html`) for **any** unmatched path,
including `/robots.txt` and `/sitemap.xml`. Confirmed by curl: both
`https://zeroapps.dev/robots.txt` and `/sitemap.xml` return the SPA HTML shell
with status 200. Lighthouse fetches `/robots.txt`, parses HTML as robots
directives, and every line is "Syntax not understood" / "Unknown directive".

Exact static files DO take precedence over the SPA fallback (verified:
`/favicon.svg` returns `200` `content-type: image/svg+xml`). So dropping a real
`robots.txt` into `apps/landing/public/` is served verbatim and fixes the audit.

Other SEO audits already pass: `document-title`, `meta-description`,
`http-status-code`, `link-text`, `crawlable-anchors`, `is-crawlable`,
`canonical`, `hreflang`, plus mobile `font-size` / `tap-targets`. `image-alt` is
`notApplicable` (no `<img>`; icons are inline SVG with `aria-hidden`).
`structured-data` is a **manual** audit (never affects the score).

The head already ships `<title>`, `<meta name="description">`,
`<link rel="canonical" href="https://zeroapps.dev/">`, `lang="en"` on `<html>`,
`og:title/description/url/type`, and `favicon.svg`. These need **no change** for
the score; the plan only adds what is missing.

### Non-SEO gaps (note only, do not fix as part of hitting SEO 100)

- Accessibility 94 (both presets): `color-contrast` — foreground/background
  contrast below WCAG AA somewhere on the page. Would need a CSS color tweak in
  `apps/landing/src/index.css`. Out of scope; note for a follow-up.
- Performance (mobile 96): `unused-javascript`, `render-blocking-insight`
  (the Google Fonts stylesheet), `speed-index` 0.76. Desktop perf is already
  100. Out of scope.

## What to change and why

Only item 1 is required to reach SEO 100. Items 2–5 are requested hygiene that
does not move the Lighthouse SEO number but improves real-world SEO and social
sharing; implement them in the same change. Item 6 is a documented seam only.

### 1. Real `robots.txt` (REQUIRED for SEO 100)

Create `apps/landing/public/robots.txt`:

```
User-agent: *
Allow: /

Sitemap: https://zeroapps.dev/sitemap.xml
```

Served at `https://zeroapps.dev/robots.txt` as `text/plain`, fixing the
`robots-txt` audit. This is the single change that takes SEO from 92 to 100.

### 2. `sitemap.xml` (hygiene; referenced by robots.txt)

Create `apps/landing/public/sitemap.xml` listing the one public URL. It must be
a real file, otherwise the `Sitemap:` line above points at SPA HTML.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://zeroapps.dev/</loc>
  </url>
</urlset>
```

(Omit `lastmod` to avoid a stale hardcoded date, or set it and accept it will
drift; prefer omitting.)

### 3. Social cards: Open Graph image + Twitter tags

In `apps/landing/index.html` `<head>`, add the missing social tags. Existing
`og:title/description/url/type` stay. Add:

```html
<meta property="og:site_name" content="Zero" />
<meta property="og:image" content="https://zeroapps.dev/og-image.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Zero | One API key for every product" />
<meta name="twitter:description" content="One API key for every Zero product, built for indie developers and small teams." />
<meta name="twitter:image" content="https://zeroapps.dev/og-image.png" />
```

Add a `1200x630` PNG at `apps/landing/public/og-image.png` (Zero wordmark on the
brand background `oklch(0.13 0 0)` to match `favicon.svg`). If producing the PNG
is blocked, ship the tags pointing at the file and land the image in the same
change; do not reference a nonexistent asset in a deploy.

### 4. Structured data (JSON-LD `Organization` + `WebSite`)

In `apps/landing/index.html` `<head>`, add one JSON-LD block. This satisfies the
manual `structured-data` audit and enriches search results (does not change the
numeric SEO score).

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", "name": "Zero", "url": "https://zeroapps.dev/",
      "logo": "https://zeroapps.dev/favicon.svg" },
    { "@type": "WebSite", "name": "Zero", "url": "https://zeroapps.dev/" }
  ]
}
</script>
```

Validate the JSON parses (it is inlined into the shipped HTML, no build step
touches it).

### 5. Favicon / web app manifest (hygiene)

`favicon.svg` already exists and is linked. Optionally add
`apps/landing/public/site.webmanifest` (name, short_name, icons, theme_color
`oklch`→hex, background) and link it with
`<link rel="manifest" href="/site.webmanifest">`, plus an
`apple-touch-icon`. Not required for SEO 100; include if cheap, skip if it
risks a broken-asset reference.

### 6. Google Search Console verification hook (SEAM ONLY — do not implement)

A follow-up task will register the site in GSC. Two viable seams, pick at that
time:

- **DNS TXT** on the `zeroapps.dev` Cloudflare zone (`google-site-verification=…`).
  Zone-level, no code change, verifies the whole domain. Preferred.
- **Meta tag**: `<meta name="google-site-verification" content="…">` in
  `apps/landing/index.html` head. Requires a deploy per token.

Document the choice in `docs/landing.md` when the follow-up lands. This plan
does not add a token.

## Files touched

- `apps/landing/public/robots.txt` (new) — required
- `apps/landing/public/sitemap.xml` (new)
- `apps/landing/public/og-image.png` (new)
- `apps/landing/public/site.webmanifest` (new, optional)
- `apps/landing/index.html` (edit head: social tags, JSON-LD, optional manifest link)
- `CHANGELOG.md` (root) — changelog entry (see below)
- `docs/landing.md` (edit) — note robots/sitemap/social assets and the GSC seam

## Changelog

User-observable (site becomes crawlable/indexable and shows rich social
previews). Route to the **root `CHANGELOG.md`**, not the agent file: the landing
page is a console/marketing surface, and the existing landing entry
(`- 2026-07-24: Zero now has a public home…`) already lives there. Add at the
top:

```
- YYYY-MM-DD: The Zero landing site now ships a robots.txt, sitemap, and social preview cards, so search engines can crawl and index it and shared links show a rich preview.
```

## Test / verification strategy

Local (pre-deploy) — this box can build and run the asset Worker (no `workerd`
DO limitation applies to an asset-only worker):

```bash
pnpm --filter @zero/landing run build
pnpm --filter @zero/landing run dev:worker   # serves dist on http://localhost:8794
curl -sSI http://localhost:8794/robots.txt   # expect 200, content-type text/plain
curl -sS  http://localhost:8794/robots.txt   # expect the robots text, NOT <!doctype html>
curl -sSI http://localhost:8794/sitemap.xml  # expect 200, content-type application/xml (or text/xml)
```

Also run repo checks: `pnpm --filter @zero/landing run lint` and
`pnpm --filter @zero/landing run typecheck` (index.html/public changes should be
inert to both, but the head edit must keep valid HTML).

Post-deploy (push to `main` auto-deploys via Workers Builds; wait for the
Cloudflare build to finish), rerun against production:

```bash
export CHROME_PATH=/run/current-system/sw/bin/chromium
npx --yes lighthouse https://zeroapps.dev \
  --only-categories=seo,performance,accessibility,best-practices \
  --output=json --output-path=/tmp/zeroapps-lh-mobile.json \
  --chrome-flags="--headless --no-sandbox --disable-gpu" --quiet
npx --yes lighthouse https://zeroapps.dev --preset=desktop \
  --only-categories=seo,performance,accessibility,best-practices \
  --output=json --output-path=/tmp/zeroapps-lh-desktop.json \
  --chrome-flags="--headless --no-sandbox --disable-gpu" --quiet
```

## Acceptance criteria (objectively checkable)

1. `curl -sSI https://zeroapps.dev/robots.txt` returns **200** with
   `content-type: text/plain`, and `curl -sS https://zeroapps.dev/robots.txt`
   returns the robots directives (does **not** start with `<!doctype html>`).
2. `curl -sSI https://zeroapps.dev/sitemap.xml` returns **200** with an XML
   content-type and valid `<urlset>` XML (not the SPA HTML).
3. Lighthouse **SEO = 100** against production `https://zeroapps.dev` on **both**
   mobile (default) and desktop (`--preset=desktop`) presets.
4. The `robots-txt` SEO audit passes (score 1) on both presets.
5. No regression: Performance, Accessibility, Best-Practices scores are **≥** the
   recorded baseline (mobile 96/94/100, desktop 100/94/100).
6. Root `CHANGELOG.md` has the new dated entry, committed with the code.

## Skills to use

- `code` — implementing the file additions and head edits.
- `changelog` — before editing `CHANGELOG.md`; confirm routing to the root file.
- `reproducible-locally` — prove the robots/sitemap serve locally before deploy
  and rerun Lighthouse against production after.
- `git-commit` — committing (code + changelog together).
- `browse` — reference for the local Chromium path (`CHROME_PATH`) when running
  Lighthouse.

## Risks / notes

- Referencing `og-image.png` / `site.webmanifest` before the file exists ships a
  broken asset (the SPA fallback would return HTML for the image path). Land each
  asset in the same change as its reference, or omit the reference.
- Pushing to `main` auto-deploys; a deploy of the asset-only `zero-landing`
  worker has no DO/turn blast radius (unlike `agent-api`). Still, verify the
  Cloudflare build finished before rerunning Lighthouse.
- Lighthouse against `localhost` cannot validate the production `canonical`/`og`
  absolute URLs; the score-defining rerun must target `https://zeroapps.dev`.
