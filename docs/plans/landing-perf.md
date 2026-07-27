# Landing page: Lighthouse mobile performance 100 (via Astro migration)

## Outcome (2026-07-27)

Shipped in commit `33961eb`: `apps/landing` migrated from React/Vite to a static
Astro build, self-hosted Archivo font, CSS inlined into `<head>`, and a real 404
page. Result (verified, median of 5 production mobile Lighthouse runs): mobile
performance **97 -> 100**, Speed Index **4.0s -> 0.9s**, FCP **1.7s -> 0.9s**,
**zero JS shipped**. SEO 100, best-practices 100, accessibility 94, desktop
performance 100 all held.

Gotcha worth remembering: Astro's `build.inlineStylesheets: "auto"` only inlines
stylesheets under **4096 raw (uncompressed) bytes**. The landing CSS is ~8.8 kB
raw, so `"auto"` left it external and render-blocking; `"always"` was required to
inline it and clear the render-blocking path.

## Goal

Raise the `https://zeroapps.dev` landing page (`apps/landing`, Worker
`zero-landing`) from **97 to 100** on Lighthouse **mobile** performance, without
regressing the other production scores: SEO 100, best-practices 100,
accessibility 94. Desktop is already 100.

The chosen approach is to **migrate `apps/landing` from React/Vite to Astro**.
The page is 100% static, so Astro's static output (zero client JS by default)
removes the entire React runtime from the critical path — the root cause of the
lost points — while keeping the exact same DOM, styles, and SEO markup. This
supersedes the earlier "prerender React" and "hand-delete React" options.

The measurement target is **production**: `zero-landing` is an asset-only Worker
and this dev box cannot run `workerd` locally (see root `AGENTS.md` "Local
workerd limitation"). `astro build` + `astro preview` work locally for building
and eyeballing output, but scoring must be done against the deployed site.

## Baseline (recon, real evidence — unchanged, still applies)

Tool: `npx lighthouse@13.4.1`, mobile form factor, 4x CPU throttle, Chromium
149. Command used for each run:

```
CHROME_PATH=/run/current-system/sw/bin/chromium \
npx --yes lighthouse https://zeroapps.dev --only-categories=performance \
  --output=json --output-path=/tmp/lh-perf-mobile.json \
  --chrome-flags="--headless --no-sandbox --disable-gpu" --quiet
```

Three consecutive mobile runs against production:

| run | score | FCP | LCP | TBT | CLS | SI |
|----|------|-----|-----|-----|-----|-----|
| 1 | 97 | 1.7 s | 1.7 s | 30 ms | 0 | 4.1 s |
| 2 | 97 | 1.8 s | 1.8 s | 0 ms | 0 | 4.0 s |
| 3 | 97 | 1.7 s | 1.7 s | 40 ms | 0 | 4.0 s |

**The 97 is deterministic, not variance.** All three runs scored 97 with tight
metric spreads. This is a real, structural 3-point loss.

### Where the 3 points go (per-metric)

Mobile weights (LH 13.4.1): FCP 10, LCP 25, TBT 30, CLS 25, SI 10.

| metric | value | metric score | weighted contribution | points lost |
|--------|-------|--------------|----------------------|-------------|
| FCP | 1.7 s | 0.92 | 0.092 | ~0.8 |
| SI  | 4.1 s | 0.79 | 0.079 | ~2.1 |
| LCP | 1.7 s | 0.99 | 0.2475 | ~0.25 |
| TBT | 25 ms | 1.00 | 0.300 | 0 |
| CLS | 0 | 1.00 | 0.250 | 0 |

Sum = 0.9685 -> rounds to **97**. The loss is almost entirely **Speed Index**
(2.1 pts) and **FCP** (0.8 pt). TBT and CLS are already perfect.

### Failing / flagged audits (with savings and blamed resource)

- **unused-javascript** — score 0, **est 36 KiB / 120 ms**. Blamed resource:
  `assets/index-*.js`, sub-item names `react-dom/cjs/react-dom-client.production.js`.
  58% of the JS bundle is unused at initial load: the React DOM runtime itself.
- **render-blocking-insight** — score 0, **est 300 ms**. Two blockers:
  1. `https://fonts.googleapis.com/css2?family=Archivo:...` (Google Fonts CSS),
     wastedMs 780.
  2. our own `assets/index-*.css` (3.2 KB transferred).
- **network-dependency-tree-insight** — score 0. Longest critical chain is
  HTML -> Google Fonts CSS (`fonts.googleapis.com`) -> font file
  (`fonts.gstatic.com`): two extra origins plus a chained request on the render
  path.

All other performance audits pass (legacy-JS, unused-CSS, font-display,
minification, cache, bootup, main-thread work). So legacy-JS, unused-CSS, and
font-display are **not** problems here.

### Root cause

The shipped bundle is React 19 + react-dom + two `lucide-react` icons (`Bug`,
`Shield`); `dist/assets/index-*.js` is 195.89 kB (61.83 kB gzip). `src/App.tsx`
is 100% static: only anchor links, no `useState`/`useEffect`, no handlers (hover
is pure CSS). The only client code is `src/main.tsx` (`createRoot`). `#root` is
empty until the JS runs, so content only paints after React downloads, parses,
and executes — driving the high FCP (1.7 s) and SI (4.1 s) — then repaints again
when the Google web font swaps in over two extra origins.

### Fonts actually used

`src/index.css` uses `font-weight` 700 (x2) and 800 (x8), family
`"Archivo", Arial, sans-serif`, `font-synthesis: none`. Copy is English / basic
Latin only. The **latin** subset variable woff2 is the only file the page needs:
`https://fonts.gstatic.com/s/archivo/v25/k3kPo8UDI-1M0wlSV9XAw6lQkqWY8Q82sLydOxI.woff2`
— **34,928 bytes** (verified `HTTP 200`, WOFF2), weight axis 400..900. The `↗`
glyph (U+2197) used by `<Arrow>` is outside Archivo's latin subset, so it
already renders via the system fallback today; self-hosting changes nothing about
it. Archivo is licensed **SIL Open Font License 1.1** (Omnibus-Type); self-host
and redistribution are permitted — ship the real OFL text.

## Astro research (evidence, this environment's registry)

Versions checked with `pnpm view` against the registry this repo resolves
against (note: this registry pins higher-than-upstream numbers across the repo —
e.g. `vite 8.1.5`, `react 19.2.7`, `eslint 10.7.0`, `typescript 6.0.3` — so trust
these, not public-web version lore):

- **`astro` 7.1.3** (`pnpm view astro version`). Plan installs **`astro@^7.1.3`**.
  `engines`: node `>=22.12.0` (repo runs node 24.16 ✓).
- **`@astrojs/check` 0.9.9**, peer `typescript ^5||^6` (repo has 6.0.3 ✓).
- **`eslint-plugin-astro` 3.0.1**, peers `@typescript-eslint/parser >=8.61.0`,
  `eslint >=10.0.0` (repo 10.7.0 ✓), `eslint-plugin-jsx-a11y >=6.10.2`.
- **`astro-eslint-parser` 3.0.0**.
- **`tailwindcss` 4.3.3** and **`@tailwindcss/vite` 4.3.3** (matches
  `apps/agent-web`).

### 1. Zero client JS by default — confirmed

Astro's config schema defaults `output: "static"`
(`dist/core/config/schemas/base.js`; `"hybrid"` is removed and aliased to
static). A static Astro page with no client-directive islands ships **no
JavaScript** — nothing to hydrate. This landing page has zero interactivity, so
there are no islands and no `client:*` directives. Result: the HTML paints
immediately with no JS on the critical path. This clears `unused-javascript`
outright (no script to be unused) and is the dominant FCP/SI win.

### 2. Tailwind v4 integration — `@tailwindcss/vite`, not `@astrojs/tailwind`

The repo already standardises on Tailwind v4 via the Vite plugin: `apps/agent-web`
and `apps/dashboard-web` both use `@tailwindcss/vite` + `tailwindcss` and a CSS
`@import "tailwindcss";`. `apps/landing` today uses the same
(`@tailwindcss/vite` in `vite.config.ts`, `@import "tailwindcss"` in
`src/index.css`). The old `@astrojs/tailwind` **integration** is the deprecated
Tailwind-v3 path and must not be used. Astro consumes Vite plugins through
`vite.plugins` in `astro.config.mjs`, so wire Tailwind identically:

```js
vite: { plugins: [tailwindcss()] }
```

Keep the **same versions** (`tailwindcss@^4.3.3`, `@tailwindcss/vite@^4.3.3`) and
the same `@import "tailwindcss";` in the global stylesheet, so the generated CSS
(Tailwind preflight/reset + the page's custom classes) is byte-for-byte what
ships today and every style renders identically. (Note: the page's classNames —
`.site-header`, `.hero`, `.button`, `.product`, etc. — are custom CSS, not
Tailwind utilities; Tailwind contributes preflight + theme layer only.)

### 3. CSS inlining — confirmed, and default "auto" is NOT enough here

Astro's `build.inlineStylesheets` defaults to **`"auto"`**
(`dist/core/config/schemas/base.js`). The inlining plugin
(`dist/core/build/plugins/plugin-css.js`) resolves `"auto"` to
`shouldInlineAsset(source, fileName, assetsInlineLimit)`, which inlines only when
`Buffer.byteLength(assetContent) < assetsInlineLimit` and `assetsInlineLimit`
defaults to Vite's **4096 bytes (4 KiB), measured on the raw (uncompressed)
bytes** (`dist/core/build/plugins/util.js`).

The landing CSS today builds to **8.81 kB raw** (2.77 kB gzip) — dominated by
Tailwind preflight plus the ~5 kB of custom CSS in `index.css`. **8.81 kB > 4096
bytes**, so `"auto"` would leave the stylesheet **external and render-blocking**,
which does not fix `render-blocking-insight`. Therefore set explicitly:

```js
build: { inlineStylesheets: "always" }
```

`"always"` inlines the whole page CSS into a `<style>` in `<head>`, removing the
last render-blocking resource so the critical path is HTML-only -> font swap.
This is a confirmed behavior, not an assumption; do not rely on the default.

### 4. Fonts — plain self-hosted `@font-face` + preload (not Astro's Fonts API)

Decision: **plain `@font-face` on the committed latin variable woff2 + a manual
`<link rel="preload">`.** Rationale: it is the simplest and most predictable
path, needs no experimental Astro feature, produces byte-stable output, keeps
the build fully offline/deterministic (the woff2 is committed, no build-time
download), and is exactly what the earlier evidence already validated. Astro's
Fonts API adds an abstraction (and, depending on provider, build-time fetching)
for a single committed file we already have the exact URL and license for — no
benefit here, more moving parts. Concretely:

- Commit the latin variable woff2 to `apps/landing/public/fonts/archivo-latin.woff2`
  (34,928 bytes) from the verified gstatic URL above. Ship the **real** Archivo
  `OFL.txt` verbatim at `apps/landing/public/fonts/OFL.txt` (see verify carry-over).
- In the global stylesheet, add `@font-face` for Archivo -> local woff2 with
  `font-weight: 400 900`, `font-style: normal`, `font-display: swap`, and the
  **real latin `unicode-range`** copied from a browser request to the css2 URL
  (do not hand-type; Google returns HTTP 400 to non-browser UAs). Keep
  `font-family: "Archivo", Arial, sans-serif` and `font-synthesis: none`.
- In `index.astro` `<head>` add
  `<link rel="preload" as="font" type="font/woff2" href="/fonts/archivo-latin.woff2" crossorigin>`
  (crossorigin is required for font preload even same-origin).
- Remove all three Google Fonts lines (both `preconnect` and the css2
  stylesheet). This deletes the two extra origins and the chained
  `CSS -> woff2` request, clearing `render-blocking-insight` and
  `network-dependency-tree-insight`.

### 5. Cloudflare deploy — stays a static `dist/` on the existing asset worker

`astro build` with the default adapter-less static config emits **`dist/`**
(`outDir` default `./dist`), with hashed build assets under **`dist/_astro/`**
(`build.assets` default `_astro`) and everything in **`public/`** copied to the
`dist/` root (`publicDir` default `./public`). So `robots.txt`, `sitemap.xml`,
`og-image.png`, and `favicon.svg` still land at the `dist` root exactly as
`assets.directory: ./dist` expects. **Do NOT add the Cloudflare adapter or switch
to SSR** — static output is the entire point; an adapter would ship a runtime we
do not want. `wrangler.jsonc` keeps `assets.directory: ./dist` and the
`zeroapps.dev` custom-domain route unchanged.

**`not_found_handling` decision — switch `single-page-application` -> `404-page`
(recommended).** Today the SPA fallback serves `index.html` with HTTP 200 for
*any* unknown path, i.e. soft-404s that are an SEO smell. A static Astro build
makes a real 404 cheap: add `src/pages/404.astro`, which builds to `dist/404.html`,
and set `assets.not_found_handling: "404-page"` so Workers assets serve it with a
proper 404 status. Tradeoff: SPA fallback is marginally more forgiving for
client-routed apps, but this is a static multi-page-capable site with one real
route, so a hard 404 is the correct behavior and improves crawl signals.
**SEO must not regress:** `robots.txt` and `sitemap.xml` are real files served
directly from the assets before `not_found_handling` is ever consulted, so the
earlier robots/sitemap SEO fix is unaffected under either setting. This switch is
a low-risk judgment call; keeping `single-page-application` also works and does
not affect the scored home route, so if the 404 page adds friction, leave SPA.

### 6. Repo integration — keep script names and turbo/CI green

The Workers Builds connector runs `pnpm -F @zero/landing run build` and
`pnpm -F @zero/landing run deploy`; both script names stay. Turbo's `build` task
expects `outputs: ["dist/**"]` — Astro's default `dist` matches. Map scripts:

- `build`: `astro build` (emits `dist/`).
- `typecheck`: `astro check` (replaces `tsc --noEmit`; type-checks `.astro` and
  `.ts` via `@astrojs/check` + `typescript`). Turbo `typecheck` has
  `dependsOn: ["^typecheck"]`; unaffected.
- `lint`: keep `eslint .`, but the landing `eslint.config.js` switches from the
  React preset to the base config + `eslint-plugin-astro` flat recommended so it
  lints `.astro` files instead of choking on them. Add devDeps
  `eslint-plugin-astro`, `astro-eslint-parser`, and `eslint-plugin-jsx-a11y`
  (peer of the astro plugin). The root eslint config is untouched; only this
  package's config changes, so `bin/ci` (`pnpm run lint` / `typecheck` / `build`)
  stays green.
- `dev`: `astro dev --port 5180` (keeps the expected 5180 Vite-equivalent port).
- `dev:worker`, `deploy`: unchanged (`wrangler`). `dev:worker` still cannot start
  on this NixOS box (no `workerd`); irrelevant to CI.

### 7. Content fidelity — identical head and DOM

- **Head:** move every SEO tag into `index.astro`'s `<head>` **byte-for-byte in
  effect**: `<title>`, meta description, canonical, favicon, the 8 `og:*`, the 4
  `twitter:*`, and the JSON-LD `@graph` (Organization + WebSite). Put the JSON-LD
  in an Astro `<script type="application/ld+json" set:html={...}>` or a raw
  `<script is:inline>` so Astro does not process/scope it. Drop only the three
  Google Fonts lines (replaced by the self-hosted preload).
- **Body:** reproduce the exact DOM from `src/App.tsx` (same elements, classes,
  `aria-*`, dark theme). The two `lucide-react` icons become **raw inline
  `<svg>`** in the `.astro` markup — no icon integration, no extra dependency.
  To keep the DOM identical (and protect the a11y-94), **capture the exact SVG
  lucide-react currently emits once, before deleting React** (e.g. one
  `renderToStaticMarkup(<App/>)` run; the earlier probe confirmed 2 inline SVGs,
  3388 chars total) and paste the `<svg>...</svg>` markup verbatim for `Shield`
  and `Bug`, keeping lucide's attributes (`viewBox="0 0 24 24"`,
  `stroke="currentColor"`, `stroke-width="2"`, `aria-hidden="true"`, etc.; the
  `.product-title h2 svg` rule overrides width/height to `0.72em`). The `<Arrow>`
  (`<span aria-hidden="true">↗</span>`) is plain inline markup.

## Ordered steps

### Step 0 — Capture the exact icon SVGs (before removing React)

While React is still present, render `src/App.tsx` once and copy the two inline
`<svg>` blocks (Shield, Bug) verbatim for pasting into `index.astro`. This
guarantees a byte-identical DOM and removes any hand-typed-SVG drift risk.

### Step 1 — Scaffold Astro config and scripts

Add `apps/landing/astro.config.mjs`:

```js
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://zeroapps.dev",
  build: { inlineStylesheets: "always" },
  server: { port: 5180 },
  vite: { plugins: [tailwindcss()] },
});
```

Replace `apps/landing/package.json` with (deps pruned, Astro toolchain added):

```json
{
  "name": "@zero/landing",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev --port 5180",
    "dev:worker": "wrangler dev --port 8794",
    "build": "astro build",
    "lint": "eslint .",
    "typecheck": "astro check",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@astrojs/check": "^0.9.9",
    "@tailwindcss/vite": "^4.3.3",
    "@zero/eslint-config": "workspace:*",
    "@zero/typescript-config": "workspace:*",
    "astro": "^7.1.3",
    "astro-eslint-parser": "^3.0.0",
    "eslint": "10.7.0",
    "eslint-plugin-astro": "^3.0.1",
    "eslint-plugin-jsx-a11y": "^6.10.2",
    "tailwindcss": "^4.3.3",
    "typescript": "6.0.3",
    "wrangler": "4.103.0"
  }
}
```

(No runtime `dependencies` — no React, no lucide.) Add `apps/landing/src/env.d.ts`
with `/// <reference types="astro/client" />`. Point
`apps/landing/tsconfig.json` at Astro's preset:

```json
{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
```

Update `apps/landing/eslint.config.js` to base + astro flat recommended:

```js
import base from "@zero/eslint-config";
import astro from "eslint-plugin-astro";

export default [...base, ...astro.configs.recommended];
```

### Step 2 — Migrate markup: `index.html` + `App.tsx` -> `src/pages/index.astro`

- Create `apps/landing/src/pages/index.astro`. Its frontmatter imports the global
  stylesheet: `import "../styles/global.css";`.
- `<head>`: paste every existing head tag from `index.html` (title, description,
  canonical, favicon, 8 og, 4 twitter, JSON-LD) verbatim; **remove** the three
  Google Fonts lines; **add** the self-hosted font preload link (Step 4).
- `<body>`: paste the DOM from `App.tsx` (translate JSX `className` -> `class`
  and self-closing tags to HTML), substituting the two captured inline SVGs
  (Step 0) for `<Shield/>`/`<Bug/>` and inlining the `↗` spans for `<Arrow/>`.
  The `vaultUrl`/`errorsUrl`/`keysUrl` constants become frontmatter `const`s or
  literal hrefs.

### Step 3 — Migrate styles: `src/index.css` -> `src/styles/global.css`

- Copy `src/index.css` verbatim into `apps/landing/src/styles/global.css`
  (keeps `@import "tailwindcss";`, all custom rules, media queries,
  `prefers-reduced-motion`).
- Add the Archivo `@font-face` block (Step 4) at the top (after the Tailwind
  import). `inlineStylesheets: "always"` inlines the whole thing into `<head>`.

### Step 4 — Self-host the Archivo font

- Commit `apps/landing/public/fonts/archivo-latin.woff2` (34,928 bytes) from the
  verified gstatic URL (one-off `curl`; no build-time download).
- Commit `apps/landing/public/fonts/OFL.txt` — the **real** Archivo license text
  (see carry-over), not a template.
- Add the `@font-face` (variable `font-weight: 400 900`, `font-display: swap`,
  real latin `unicode-range`) to `global.css`, and the preload `<link>` to
  `index.astro`'s head.

### Step 5 — Add a real 404 page and update the worker config

- Add `apps/landing/src/pages/404.astro` (a minimal branded not-found page reusing
  the same global styles).
- In `apps/landing/wrangler.jsonc`, change
  `assets.not_found_handling` from `"single-page-application"` to `"404-page"`.
  Keep `assets.directory: ./dist` and the `zeroapps.dev` route unchanged.

### Step 6 — Delete the React/Vite scaffolding

Delete: `apps/landing/index.html`, `apps/landing/src/App.tsx`,
`apps/landing/src/main.tsx`, `apps/landing/src/index.css`,
`apps/landing/src/vite-env.d.ts`, `apps/landing/vite.config.ts`. Remove the
`react`, `react-dom`, `lucide-react`, `@vitejs/plugin-react`, `@types/react`,
`@types/react-dom`, `@types/node`, and `vite` deps (superseded by the Step-1
package.json). Astro's default build emits **no client sourcemaps**, so the
stray 860 kB `index-*.js.map` from `vite.config.ts`'s `sourcemap: true` is gone
by construction (see carry-over).

### Step 7 (optional, unscored) — immutable cache headers

Add `apps/landing/public/_headers` (copied to `dist` root; honored by Workers
static assets on this asset-only Worker):

```
/_astro/*
  Cache-Control: public, max-age=31536000, immutable
/fonts/*
  Cache-Control: public, max-age=31536000, immutable
```

`cache-insight` already passes and Lighthouse's cold load ignores caching, so
this does not change the score; it only helps real repeat visitors. `_headers`
does not touch `not_found_handling`. Purely nice-to-have.

## Files added / changed / deleted

**Added**
- `apps/landing/astro.config.mjs`
- `apps/landing/src/pages/index.astro`
- `apps/landing/src/pages/404.astro`
- `apps/landing/src/styles/global.css`
- `apps/landing/src/env.d.ts`
- `apps/landing/public/fonts/archivo-latin.woff2` (binary, 34,928 bytes)
- `apps/landing/public/fonts/OFL.txt` (real Archivo SIL OFL 1.1)
- `apps/landing/public/_headers` (optional, Step 7)

**Changed**
- `apps/landing/package.json` (Astro scripts + deps, React deps removed)
- `apps/landing/tsconfig.json` (extend `astro/tsconfigs/strict`)
- `apps/landing/eslint.config.js` (base + `eslint-plugin-astro`)
- `apps/landing/wrangler.jsonc` (`not_found_handling` -> `404-page`)

**Deleted**
- `apps/landing/index.html`
- `apps/landing/src/App.tsx`
- `apps/landing/src/main.tsx`
- `apps/landing/src/index.css`
- `apps/landing/src/vite-env.d.ts`
- `apps/landing/vite.config.ts`

## Carry-over from the verify report (still relevant)

- **Real OFL text, not a placeholder.** OFL 1.1 requires the copyright notice
  and license travel with the font. Ship the canonical Archivo `OFL.txt`
  verbatim (from `google/fonts` `ofl/archivo/OFL.txt`), which begins
  `Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)`.
  A blank template with `<Copyright Holder>` placeholders does not satisfy
  attribution.
- **Pin the real latin `unicode-range`.** Copy it from a real browser request to
  the css2 URL (non-browser UAs get HTTP 400). Confirm it excludes U+2197 (it
  does by design), consistent with `↗` already using the system fallback.
- **No stray sourcemaps.** Astro's default (no client sourcemaps) removes the old
  860 kB `.js.map` that Vite's `sourcemap: true` emitted; do not re-enable
  sourcemaps.
- **`_headers` is supported by Workers static assets.** A plain `_headers` in
  `public/` (copied to `dist`) overrides default headers on this asset-only
  Worker and does not affect the SPA/404 fallback. Safe but unscored.

## What must NOT regress

- **SEO 100:** the full copy is in the static HTML (only helps SEO). Every
  `<meta>`, canonical, OG/Twitter, and JSON-LD block is carried over verbatim.
  `robots.txt`/`sitemap.xml` remain real files at the `dist` root, served before
  `not_found_handling`, so the 404 switch does not touch them.
- **Best-practices 100:** removing the third-party font origins reduces
  third-party content; a same-origin preloaded woff2 with `font-display: swap`
  introduces no console errors, mixed content, or 404s. Verify the font path
  after deploy.
- **Accessibility 94:** the migrated DOM is structurally identical to today's
  React output (same elements/classes/`aria-*`, same captured icon SVGs), so a11y
  is unchanged. The pre-existing 94 is **out of scope** — confirm it stays 94, do
  not attempt to fix it here.

## Changelog routing

Per root `AGENTS.md`: landing is not under the Agent or the ZeroVault/Errors/
console products, and this is an internal framework migration + performance change
with **no user-visible capability or behavior change** — so **no changelog
entry** (default). If the team decides a faster public landing page is worth
recording, the only correct file is the root `CHANGELOG.md`; never
`apps/agent-api/CHANGELOG.md`. Decide before merging; default is no entry.

## Acceptance criteria (repeatable measurement)

Measure against **production** after the `zero-landing` Workers Builds deploy
finishes, mobile, with the exact recon command above.

1. **Primary:** run Lighthouse mobile **5 times**; the **median performance
   score = 100** (median, not best/single run — emulated-mobile SI is noisy near
   the boundary).
2. **Per-audit pass conditions** (each must hold in the median run):
   - `unused-javascript`: passes / absent (no JS shipped at all).
   - `render-blocking-insight`: passes (no `fonts.googleapis.com` stylesheet, and
     no external CSS — CSS is inlined via `inlineStylesheets: "always"`).
   - `network-dependency-tree-insight`: passes (no
     `fonts.googleapis.com -> fonts.gstatic.com` chain; font is same-origin).
   - `font-display-insight`: still passes.
3. **Metric gates** (median of 5): SI score >= 0.99 and FCP score >= 0.99;
   LCP, TBT, CLS remain 1.00.
4. **No regressions:** in the same production run, SEO = 100, best-practices =
   100, accessibility = 94 (>= 94).
5. **Screenshot comparison:** capture the migrated page (local `astro preview`
   and post-deploy production) and compare against the current live page at
   desktop and mobile widths; the rendered layout, type, spacing, dark theme, and
   the two icons must match. Any visible drift (font metrics, icon size, spacing)
   is a defect to fix before sign-off.
6. If the median lands at **99** with SI as the only sub-perfect metric, document
   SI across the 5 runs; a 99 caused solely by SI variance (SI score oscillating
   0.98-1.00) is the known residual risk, not a defect to chase.

## Risks: does Astro alone reach 100?

- **CSS inlining is a config decision, not automatic.** With the default
  `"auto"`, the 8.81 kB (raw) stylesheet stays external and render-blocking and
  the fix silently fails. `inlineStylesheets: "always"` is mandatory here, not
  optional. (Primary risk; mitigated by Step 1.)
- **Speed Index boundary noise.** Even with zero JS, inlined CSS, and a
  same-origin preloaded font, SI is the metric closest to the 0.99/1.00 boundary
  and the noisiest on emulated mobile. A single run may show 99; that is why
  acceptance is median-of-5 with SI as the gating metric.
- **Font swap repaint.** `font-display: swap` still causes one late repaint when
  Archivo loads; the preload minimizes but does not eliminate it. Same behavior
  the earlier plan accepted; keep the `Arial` fallback and `font-synthesis: none`
  so the swap is visually stable (CLS stays 0).
- **Toolchain peer resolution.** `eslint-plugin-astro@3.0.1` requires
  `eslint-plugin-jsx-a11y` and `@typescript-eslint/parser >=8.61.0` as peers, and
  `@astrojs/check@0.9.9` requires `typescript ^5||^6`. All satisfiable in this
  repo, but confirm a clean `pnpm install` and that `astro check` + `eslint .`
  both exit 0 locally before relying on CI.
- **DOM drift from hand-migration.** Translating JSX to `.astro` by hand could
  nudge the structure and disturb a11y-94 or layout. Mitigated by capturing the
  exact icon SVGs (Step 0) and the screenshot comparison (acceptance #5).

## Skills to use

- `code` — executing Steps 0-7.
- `cloudflare` — for the Workers static-assets config (`not_found_handling`,
  `_headers`, `dist/` layout).
- `reproducible-locally` — proving the change: `astro build` locally, inspect
  that `dist/index.html` contains the full painted markup, an inlined `<style>`,
  the font preload, and **no** `<script>`/external CSS; then deploy and run the
  5-run mobile Lighthouse median plus the screenshot comparison against
  production (localhost worker verification is impossible on this box).
- `git-commit` — committing (font binary + real OFL + Astro sources together).
