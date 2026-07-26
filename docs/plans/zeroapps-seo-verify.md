# Verify report: zeroapps-seo.md

**Verdict: no blockers.** The required change (a real `robots.txt` in
`apps/landing/public/`) is proven to take SEO from 92 to 100. Ship it. Fix the
concerns below (mostly the plan's overstated local-verification claim) before
implementing.

## What was verified with evidence

- **Root cause confirmed.** Production `curl -sSI https://zeroapps.dev/robots.txt`
  returns `HTTP/2 200`, `content-type: text/html`, body starts `<!doctype html>`.
  `/sitemap.xml` behaves the same. The SPA fallback serves the HTML shell for
  both. (live curl, 2026-07-26)
- **Exact static files take precedence over the SPA fallback.**
  `curl -sSI https://zeroapps.dev/favicon.svg` → `200`, `content-type:
  image/svg+xml`. A real `robots.txt` in `public/` will be served verbatim.
- **Vite copies `public/` to `dist/` root.** Built locally with a test
  `robots.txt`/`sitemap.xml` in `public/`; `dist/` root contained `robots.txt`,
  `sitemap.xml`, `favicon.svg`, `index.html`. (`pnpm --filter @zero/landing run build`)
- **`robots-txt` is the only failing scored SEO audit.** Re-ran Lighthouse
  SEO-only against production (Chromium headless): SEO **score 92**; every scored
  audit passes except `robots-txt` (score 0, weight 1). Sum of SEO weights
  ≈ 12.04; fixing the one weight-1 failure → 12.04/12.04 = **100**. (mobile preset;
  `robots-txt` is device-independent so desktop matches — see nit 4)
- **`.txt` → `text/plain`, `.xml` → `text/xml`.** Cloudflare Workers Assets sets
  Content-Type from the file extension (Wrangler MIME lookup; confirmed live by
  `favicon.svg` → `image/svg+xml`). `.txt` is `text/plain` in mime-db. `.xml` is
  served as **`text/xml`** (Cloudflare community report, May 2026:
  "XML Static Assets use the text/xml media type instead of application/xml").
- **og-image.png IS producible on this box.** Chromium headless
  `--screenshot --window-size=1200,630` produced a valid `PNG 1200x630`.
  ImageMagick (`magick`) also works; DejaVu Sans is the one installed font
  (`-font` must be passed). The plan's "if blocked" contingency is unnecessary.
- **JSON-LD parses.** The plan's `@graph` block is valid JSON (`JSON.parse` OK).
- **Changelog routing correct.** Root `CHANGELOG.md` header states it covers the
  console + already holds the landing entry ("Zero now has a public home").
  AGENTS.md routes console/marketing surfaces to root, agent to
  `apps/agent-api/CHANGELOG.md`. Root is right.

## Findings

### Blockers
None.

### Concerns

1. **Plan's local pre-deploy verification is not executable on this box.** The
   plan claims: "this box can build and run the asset Worker (no workerd DO
   limitation applies to an asset-only worker)" and instructs
   `pnpm --filter @zero/landing run dev:worker` + `curl localhost:8794`. Proven
   false: `wrangler dev` aborts with `write EPIPE` and
   "Could not start dynamically linked executable ... workerd ... NixOS cannot run
   dynamically linked executables." The limitation is the `workerd` binary
   itself, not Durable Objects, so it applies to the asset-only worker too.
   **Fix:** drop the `dev:worker` content-type check from the pre-deploy path (or
   mark it "workerd-capable machine only"). The real gate is the post-deploy
   production `curl` + Lighthouse rerun, which the plan already has. `vite preview`
   can confirm the file is served (not SPA HTML) but will not reproduce
   Cloudflare's exact Content-Type.

2. **`sitemap.xml` will be served as `text/xml`, not `application/xml`.**
   Acceptance criterion #2 asserts "an XML content-type" (fine) but the test
   strategy comment says "application/xml (or text/xml)". Cloudflare serves `.xml`
   as `text/xml`. Google accepts `text/xml` for sitemaps, so no functional
   problem. **Fix:** state the expected value as `text/xml` so the check does not
   read as a failure.

### Nits

1. **Acceptance criterion #5 (no perf/a11y regression ≥ baseline) is flaky.**
   Lighthouse Performance/Speed Index are noisy run-to-run and unrelated to
   adding a `robots.txt`. A rerun can dip below the recorded mobile perf 96 and
   fail the criterion spuriously. **Fix:** scope the regression gate to the SEO
   category (the only one this change affects), or allow a tolerance and note
   perf variance.

2. **og-image contingency is moot; prefer the chromium path.** The PNG is
   producible here (chromium headless screenshot of a 1200x630 HTML → valid PNG).
   Render the brand design (dark `#0a0a0a` bg + orange ring matching
   `favicon.svg`) via chromium screenshot rather than ImageMagick text (needs an
   explicit `-font`).

3. **JSON-LD `Organization.logo` points at an SVG.** Google's Organization-logo
   rich-result guidance prefers raster formats; an SVG logo may be ignored for
   that feature. Not Lighthouse-scored. Optional: point `logo` at the new
   `og-image.png` (or a dedicated raster logo).

4. **Desktop SEO=92 / robots-txt-only not re-run.** Only the mobile preset was
   re-measured. `robots-txt` is device-independent and the mobile-only SEO audits
   (`font-size`, `tap-targets`) already pass, so desktop 92→100 follows. Noted for
   completeness; the post-deploy plan reruns both presets anyway.

## Acceptance criteria assessment

Objectively checkable and sufficient for the goal (SEO 100 both presets), with
two adjustments: criterion #2 should expect `text/xml`, and criterion #5 should
not gate on noisy Performance numbers. Criteria 1, 3, 4, 6 are sound as written.
