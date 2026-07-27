# Verify: landing-perf.md (Astro migration for mobile Lighthouse 97 -> 100)

Adversarial review of the **rewritten** `docs/plans/landing-perf.md` (React/Vite ->
Astro static). This replaces the earlier report (which reviewed the abandoned
"prerender React" / "hand-delete React" approach). Every claim below is backed by
a build, a throwaway install, a schema read, or a `file:line`. Verdict first.

## Verdict

**No blockers.** The Astro approach is sound and I reproduced every structural
claim of the plan end-to-end in a throwaway Astro 7.1.3 project built from the
plan's exact config: **zero JS emitted**, CSS **inlined into `<style>`**, the
lucide SVG attributes and the `↗` glyph preserved verbatim, `404.astro` ->
`dist/404.html`, and `astro check` + `eslint .` (with `eslint-plugin-astro` on
eslint 10.7.0) both exit 0. The migration removes the exact root cause (React
runtime on the critical path) the baseline blames.

**Two concerns worth fixing** (one of which will break `pnpm run lint`), plus a
few nits. **Ship it with C1 applied** (the `.astro` eslint ignore) and ideally
C2 (a real DOM diff in acceptance). Neither concern blocks starting the work.

---

## What I verified as TRUE (with the probe that proved it)

- **Astro is installable in this registry and builds under this toolchain.**
  `pnpm view astro versions` ends at `7.1.3` (`latest`), `engines.node
  >=22.12.0` (box runs node **v24.16.0** ✓), astro depends on `vite ^8.0.13`
  (repo pins 8.1.5; astro bundles its own vite anyway). A throwaway
  `pnpm add -D astro@^7.1.3 @astrojs/check@^0.9.9 typescript@6.0.3
  @tailwindcss/vite@^4.3.3 tailwindcss@^4.3.3 eslint@10.7.0
  eslint-plugin-astro@^3.0.1 astro-eslint-parser@^3.0.0
  eslint-plugin-jsx-a11y@^6.10.2` installed cleanly (one non-fatal peer warning,
  see N1). `astro build` produced `dist/index.html` + `dist/404.html`; `astro
  check` reported 0 errors on 5 files; `eslint .` exited 0 on a valid `.astro`
  page and exited 1 with correct `no-unused-vars`/`no-debugger` diagnostics on a
  bad one (so the parser genuinely lints `.astro`, not silently skips).

- **Zero client JS — confirmed by inspecting the build.** `find dist -name
  '*.js'` = **0**. `dist/index.html` has one `<style>`, **no** `<script>`, **no**
  external `<link rel="stylesheet">`. This is the dominant FCP/SI win and clears
  `unused-javascript` by construction. The plan's Skills section already mandates
  this local check ("inspect that `dist/index.html` contains ... no
  `<script>`/external CSS"), and acceptance #2 asserts `unused-javascript`
  absent — so the "no JS on the critical path" gate is present. Good.

- **CSS inlining: threshold and size both confirmed; `"always"` is mandatory.**
  The current build emits `dist/assets/index-*.css` at **8817 bytes raw** / 2798
  bytes gzip (`wc -c` + `gzip -c | wc -c`). 8817 > **4096** (Vite's
  `assetsInlineLimit` default, measured on raw bytes), so the default `"auto"`
  would leave the stylesheet external and render-blocking. In the probe,
  `build: { inlineStylesheets: "always" }` inlined the whole stylesheet into a
  `<head>` `<style>` with no external CSS link. The plan is right that `"always"`
  is not optional here.

- **Inlining 8.8 kB does not hurt, and purge is NOT a better lever.** Inlined,
  the whole page is ~11 kB raw / ~4 kB gzip in one document — one fewer request,
  CSS gzipped with the HTML, so cold-load transfer is marginally *lower*, not
  higher (good for SI/FCP). "HTML no longer separately cacheable" is immaterial:
  the page changes rarely and Lighthouse's cold run ignores caching. **Purging is
  not a substitute:** the render-blocking problem is the *separate request*, not
  the byte count — even a purged 2 kB external stylesheet still blocks. Only
  inlining removes the request. On composition: `src/index.css` is 5667 raw bytes
  of custom CSS; the ~3 kB delta to 8817 is Tailwind's `@import "tailwindcss"`
  (theme CSS-variable block + preflight). **The page uses zero Tailwind
  utilities** (every class — `.hero`, `.button`, `.product` — is custom CSS), so
  Tailwind v4 already emits no utility layer; the only arguably-dead weight is the
  `@layer theme` variable block, which `unused-css-rules` does not flag (it passes
  today). Net: purge buys no score and can't replace inlining. See N2 for the one
  real byte-cut option (dropping Tailwind entirely) and why the plan correctly
  avoids it.

- **`not_found_handling: "404-page"` is a valid, safe switch.** The repo's own
  wrangler 4.103.0 `config-schema.json` enumerates `not_found_handling` as
  `["single-page-application","404-page","none"]`, described "How to handle
  requests that **do not match an asset**." So the fallback is consulted *only*
  for unmatched paths: `/` -> `/index.html`, `/robots.txt`, `/sitemap.xml`, and
  `/favicon.svg` are real assets (present in `apps/landing/public/` and copied to
  `dist/` root — verified) and serve directly, unaffected by the switch. The
  probe's `src/pages/404.astro` built to `dist/404.html`, which is what
  `"404-page"` serves (with a real 404 status) for genuine misses. SEO 100 is not
  at risk; the switch only turns today's soft-404 (SPA 200-for-everything) into a
  correct hard 404.

- **DOM/SVG fidelity: the plan's Step 0 capture is exact — reproduced.**
  `renderToStaticMarkup(<App/>)` yields **3388 chars, 2 inline `<svg>`** (Shield
  415 chars, Bug 661 chars), each carrying `xmlns`, `width="24" height="24"`,
  `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`,
  `stroke-width="2"`, `stroke-linecap`/`stroke-linejoin="round"`,
  `class="lucide lucide-*"`, `aria-hidden="true"`. Pasting these verbatim (Step 0)
  is the correct way to guarantee a byte-identical icon DOM. In the probe, Astro
  preserved pasted SVG attributes and the `↗` glyph unchanged.

- **Toolchain integration is green.** Turbo `build` declares `outputs:
  ["dist/**"]` — Astro's default `dist/` matches. `typecheck` -> `astro check`
  self-syncs types and passed offline. `build`/`deploy` script names are
  unchanged, so the Workers Builds connector (`pnpm -F @zero/landing run build` /
  `deploy`) is untouched. An `.astro` eslint plugin **does** exist in this
  registry (`eslint-plugin-astro@3.0.1` + `astro-eslint-parser@3.0.0`) and works
  under eslint 10.7.0 — so no honest fallback is needed; the plan's `eslint .`
  stays real, not a rubber stamp. (Caveat: C1.)

---

## Concerns (ranked)

### C1. The new eslint config must ignore `.astro/`, or `pnpm run lint` breaks
`astro build`/`astro check`/`astro sync` generate a `.astro/` types dir at the
package root containing `content.d.ts` (~5.5 kB) and `types.d.ts`. The base
`@zero/eslint-config` lints `**/*.{ts,tsx}` (with typechecked `no-unused-vars`)
and ignores only `dist`/`node_modules` — **not** `.astro`. Proof: with a
base-like flat config (`js.configs.recommended` + a `**/*.{ts,tsx}` block +
astro recommended, ignoring only `dist`/`node_modules`), `eslint .` over the
generated dir produced **21 `no-unused-vars` errors** in `.astro/content.d.ts`
and exited 1. The plan's proposed config —
`export default [...base, ...astro.configs.recommended]` — has no `.astro`
ignore, so it inherits this. Worse, it is **order-sensitive** in CI: `bin/ci`
runs `pnpm run lint -- --fix` *before* `pnpm run build`, so a fresh checkout may
lint clean once (dir absent) and then break on every subsequent run and on every
local build. **Fix (concrete):** prepend an ignore block:
```js
import base from "@zero/eslint-config";
import astro from "eslint-plugin-astro";
export default [{ ignores: [".astro"] }, ...base, ...astro.configs.recommended];
```
Re-proven: adding `.astro` to `ignores` drops the 21 errors and `eslint .` exits
0. Add this to Step 1's eslint snippet.

### C2. DOM-fidelity acceptance is visual (screenshots), not a DOM diff
Acceptance #5 compares *rendered screenshots* at desktop/mobile widths — good for
catching layout/type drift, but it will not catch a silent attribute or `aria-*`
change (e.g. Astro normalizing a boolean attr, or a hand-edit dropping
`aria-hidden`) that leaves pixels identical but nudges the a11y-94. The plan
already captures the exact React output (3388 chars, 2 SVGs — reproduced here),
so the cheap hardening is to **diff it**: normalize whitespace/attribute-order
and compare `renderToStaticMarkup(<App/>)`'s `<body>` against the astro-built
`dist/index.html` `<body>`, and require an empty diff as an acceptance gate.
Add it alongside #5; keep the screenshot check for layout.

### C3. The goal is 100 but acceptance #6 pre-authorizes accepting a 99
Acceptance #1 gates on median-of-5 = 100 (correct — emulated-mobile SI is noisy),
but #6 says a median 99 "caused solely by SI variance ... is the known residual
risk, not a defect to chase." That is honest, and the structural fixes (zero JS,
inlined CSS, same-origin preloaded font) remove all three root causes the
baseline blames for the SI/FCP loss — so 100 is the likely outcome. Just flag
that the exit gate has an escape hatch: "reach 100" is not strictly guaranteed,
and the team should decide up front whether a documented SI-only 99 is an
acceptable stop. No change required; call it out so the task can conclude
cleanly.

---

## Nits

- **N1. `eslint-plugin-jsx-a11y` peer warns on eslint 10 (non-fatal, maybe
  unneeded).** Max published `eslint-plugin-jsx-a11y` is 6.10.2, peering
  `eslint ^3..^9`; repo has 10.7.0, so install prints `unmet peer eslint@...:
  found 10.7.0`. The repo sets no `strict-peer-dependencies`, so install and lint
  still succeed (proven). `eslint-plugin-astro`'s **recommended** config does not
  load jsx-a11y rules (only its opt-in `jsx-a11y-*` configs do), so you can likely
  drop `eslint-plugin-jsx-a11y` from the devDeps entirely and silence the warning.
  Harmless either way; the plan keeps it because the astro plugin lists it as a
  peer.

- **N2. Dropping `@import "tailwindcss"` is the only real byte-cut, and the plan
  is right to skip it.** Since the page uses zero utilities, Tailwind contributes
  only preflight + the theme-var block (~3 kB). Removing it would shave that, but
  preflight resets (heading margins, list styles, `img` display, etc.) may be
  load-bearing for the current look, and the plan's stated goal is byte-identical
  rendering. Out of scope; note it as a possible follow-up, not a substitute for
  inlining.

- **N3. Carry-overs still valid.** Ship the **real** Archivo `OFL.txt` (starts
  `Copyright 2020 The Archivo Project Authors ...`), not a placeholder; copy the
  latin `unicode-range` from a real browser request to the css2 URL (Google 400s
  non-browser UAs) and confirm it excludes U+2197; Astro's default no-client-
  sourcemaps removes the old 860 kB `.js.map` by construction (confirmed: current
  Vite build still emits `index-*.js.map` 860 kB from `sourcemap: true`).

- **N4. `_headers` is now mostly moot.** With CSS inlined there is no external
  stylesheet to cache; the optional Step-7 `/_astro/*` immutable rule only helps
  `og-image.png` and the self-hosted `/fonts/*` woff2. Still safe and unscored;
  keep it truly optional.

- **N5. `@types/node` removal is fine.** `astro.config.mjs` + `@tailwindcss/vite`
  need no `@types/node`; astro bundles vite so the direct `vite` devDep drop is
  also correct.

---

## Would I ship this Astro plan as written?

**Yes, with C1 applied.** The migration is the right structural fix, every load-
bearing claim reproduced (zero JS, mandatory `"always"` inlining, valid
`404-page`, exact SVG capture, working eslint/astro-check on this exact
toolchain), and it removes the precise root cause of the deterministic 97. Before
building, make two named changes:

1. **C1 (do this):** add `{ ignores: [".astro"] }` to the landing eslint config
   so `pnpm run lint` / `bin/ci` stay green.
2. **C2 (recommended):** add a normalized `<body>` DOM diff (captured React
   output vs built `dist/index.html`) to the acceptance criteria, not only the
   screenshot comparison.

C3 is a heads-up, not a change: the plan may legitimately end at a documented
SI-only 99; agree that's acceptable before starting so the task can conclude.
