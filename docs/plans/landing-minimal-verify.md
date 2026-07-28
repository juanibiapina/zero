# Verification: landing minimal redesign

## Verdict

**Not ready to execute as written.** The design is feasible, the main technical claims are grounded, and the local accessibility result reproduces. One acceptance gate has an impossible link count. The palette rationale also contains wrong computed values, and the default Tailwind dependency removal is not worth an all-worker deploy for this change.

## Blocker

### B1. The outbound-link acceptance count cannot be met

The current home page has 10 outbound anchor instances and six unique outbound URLs. The closing CTA is one of the 10 (`apps/landing/src/pages/index.astro:111`). Deleting that section as required by `docs/plans/landing-minimal.md:237` leaves nine outbound anchor instances, not eleven. The acceptance list itself names nine instances: Docs twice, Dashboard twice, Open Vault, Open Errors, two setup guides, and one key CTA (`docs/plans/landing-minimal.md:445-447`). Yet both verification and acceptance require eleven (`docs/plans/landing-minimal.md:369`, `docs/plans/landing-minimal.md:445`).

The real links are at `apps/landing/src/pages/index.astro:55-56`, `apps/landing/src/pages/index.astro:66`, `apps/landing/src/pages/index.astro:84-85`, `apps/landing/src/pages/index.astro:101-102`, `apps/landing/src/pages/index.astro:111`, and `apps/landing/src/pages/index.astro:118-119`. No implementation can both delete the duplicate closing CTA and retain eleven outbound anchors without adding unrelated duplicates.

The acceptance count must match the intended nine anchor instances, or test the six unique destination URLs instead.

## Concerns

### C1. The copied product tokens are exact, but the deviation math and wording are not

The source tokens in `packages/ui/src/styles.css:34-53` match the plan for `--background`, `--foreground`, `--primary`, `--primary-foreground`, `--muted-foreground`, `--border`, `--ring`, `--destructive`, and `--radius`. `rounded-md` resolves to `0.5rem` because `--radius-md` is `calc(var(--radius) - 2px)` (`packages/ui/src/styles.css:10`, `packages/ui/src/styles.css:35`). The product palette table is accurate at the token level.

Three statements in the proposed palette are false or ambiguous:

- `oklch(0.44 0 0)` converts to `#525252`, not `#5b5b5b`. Its stated white contrast, about 7.77:1, is correct (`docs/plans/landing-minimal.md:136`).
- `oklch(0.82 0 0)` converts to `#c4c4c4`, but its white contrast is about 1.75:1, not 2.2:1 (`docs/plans/landing-minimal.md:140`, repeated at `docs/plans/landing-minimal.md:420`). This weakens the claim that the remaining hairlines will be visibly structural.
- `oklch(0.32 0 0)` is not the product primary at 90% over white (`docs/plans/landing-minimal.md:124`). Ordinary encoded-sRGB alpha compositing is about `#2e2e2e`, equivalent to OKLCH lightness about 0.302. Mixing in OKLCH gives lightness 0.2845. The proposed 0.32 is a separate choice. Its stated contrast against `--primary-foreground`, about 12.15:1, is correct.

The claim of only two deviations (`docs/plans/landing-minimal.md:133`, `docs/plans/landing-minimal.md:434-435`) also needs a narrower definition. The design adds a custom hover neutral and replaces the product ring treatment with a foreground outline. Those choices are valid, but they are additional intentional departures from the shared token system.

### C2. Full Tailwind removal is not worth the deploy cost in this change

The Tailwind facts reproduce:

- Import: `apps/landing/src/styles/global.css:1`.
- Vite plugin: `apps/landing/astro.config.mjs:2`, `apps/landing/astro.config.mjs:8`.
- Dev dependencies: `apps/landing/package.json:16`, `apps/landing/package.json:24`.
- Every landing class is backed by handwritten CSS. No Tailwind utility rule is emitted.
- A fresh build produced one 9,157-byte style block. The Tailwind prefix is exactly 4,124 bytes and the CSS from `@font-face` onward is exactly 5,033 bytes.

Removing the CSS import obtains the entire 4,124-byte page saving. Removing the plugin and package declarations adds no further browser-byte saving. Tailwind 4.3.3 remains in the monorepo for `apps/agent-web` and `apps/dashboard-web` (`apps/agent-web/package.json:26`, `apps/agent-web/package.json:33`, `apps/dashboard-web/package.json:16`, `apps/dashboard-web/package.json:24`).

The deploy warning and fallback are correctly surfaced. `pnpm-lock.yaml` is watched by all four workers (`AGENTS.md:131-135`), and an agent deployment can reset an in-flight Durable Object (`AGENTS.md:151-158`). A throwaway worktree probe with the two landing dev dependencies removed and `pnpm install --lockfile-only` changed 394 lockfile lines, mostly peer-resolution normalization unrelated to landing, rather than only removing two importer entries.

For this redesign, the import-only fallback at `docs/plans/landing-minimal.md:350-354` is the better default. Full cleanup makes sense when another planned lockfile change already pays the all-worker deploy cost.

### C3. Several deletions go beyond recoloring and need product approval

The plan preserves unique destinations and accessible names:

- Both SVGs and every arrow are `aria-hidden` (`apps/landing/src/pages/index.astro:55-56`, `apps/landing/src/pages/index.astro:76`, `apps/landing/src/pages/index.astro:93`). Their removal does not remove a link name.
- The closing key link duplicates the hero key link (`apps/landing/src/pages/index.astro:66`, `apps/landing/src/pages/index.astro:111`).
- The Products link is an in-page link (`apps/landing/src/pages/index.astro:54`) and its target is `apps/landing/src/pages/index.astro:71`.

It still deletes visible content and on-page search text: "Secrets management" (`apps/landing/src/pages/index.astro:75`), "Error reporting" (`apps/landing/src/pages/index.astro:92`), and "Add Zero to your projects." (`apps/landing/src/pages/index.astro:110`). It also removes the only in-page navigation item, both product icons, and a second conversion point. These are product and SEO decisions, not required consequences of removing orange. The user asked for a minimal page, so the direction is in scope, but the whole closing-section deletion and product-label deletion should be approved explicitly rather than treated as mechanical cleanup.

### C4. The current color inventory and the proposed color checks are not complete

The exhaustive source inventory is:

- `apps/landing/src/styles/global.css:18-24`: `oklch(0.13 0 0)`, `oklch(0.975 0 0)`, `oklch(1 0 0)`, `oklch(0.82 0 0)`, `oklch(0.42 0 0)`, `oklch(0.64 0.22 33)`, and `oklch(0.69 0.23 33)`.
- Their uses are at `apps/landing/src/styles/global.css:32`, `apps/landing/src/styles/global.css:39-40`, `apps/landing/src/styles/global.css:48`, `apps/landing/src/styles/global.css:58-59`, `apps/landing/src/styles/global.css:74-75`, `apps/landing/src/styles/global.css:109`, `apps/landing/src/styles/global.css:116-117`, `apps/landing/src/styles/global.css:125`, `apps/landing/src/styles/global.css:158-159`, `apps/landing/src/styles/global.css:166`, `apps/landing/src/styles/global.css:190`, `apps/landing/src/styles/global.css:198`, `apps/landing/src/styles/global.css:216`, `apps/landing/src/styles/global.css:232`, `apps/landing/src/styles/global.css:241`, `apps/landing/src/styles/global.css:259`, `apps/landing/src/styles/global.css:265`, and `apps/landing/src/styles/global.css:277`.
- `apps/landing/public/favicon.svg:2-4`: the same current ink and orange plus `oklch(0.975 0 0)` and `fill="none"`.
- `apps/landing/src/pages/index.astro:76` and `apps/landing/src/pages/index.astro:93`: `fill="none"` and `stroke="currentColor"` on the two inline SVGs.
- `apps/landing/src/pages/404.astro` has no local style or color literal. It inherits the orange wordmark, kicker, button, focus, and dark hero from the shared classes.
- There is no `theme-color` meta, manifest, mask icon, Apple touch icon, inline `<style>`, style attribute, hex color, `rgb()` color, or named CSS color in the authored landing source.
- Tailwind expansion currently adds `#0000`, `transparent`, `currentColor`, and `red` inside a `color-mix()` feature probe to the built CSS. Removing the import removes these generated literals.
- `og-image.png` is a valid 1200x630 sRGB PNG with 752 pixel colors. The dominant counts are 687,102 `#070707` pixels, 30,512 `#ff4e29`, 20,427 `#f7f7f7`, and 5,015 `#f4421d`, plus antialiasing colors. The plan's 91% dark and roughly 35,000 exact orange pixels are accurate, but this is not a complete image-color inventory.

The plan never states the current `oklch(0.42 0 0)` muted literal, `currentColor`, `none`, generated Tailwind values, or the image's neutral and antialiasing values. More important, its future check only searches `oklch()` and two known orange hex values (`docs/plans/landing-minimal.md:366-368`). That would not detect a new `rgb()`, arbitrary hex, named color, `currentColor`, SVG paint, or another chromatic PNG pixel. Likewise, showing only the top histogram entries (`docs/plans/landing-minimal.md:338`) cannot prove that every pixel is grayscale.

### C5. The real-404 verification has a local gap

The commands are valid on this box. `build`, `lint`, and `typecheck` passed. `astro preview` started without `workerd`; `/does-not-exist` returned 404 with the generated 404 body. The expected Worker setting remains `not_found_handling: "404-page"` (`apps/landing/wrangler.jsonc:7`).

However, the screenshot step requests `/404` (`docs/plans/landing-minimal.md:383-384`). Under `astro preview`, `/404` and `/404.html` return 200 because they are concrete generated routes. That does not test the missing-path response. This box cannot run the Workers Assets adapter (`AGENTS.md:9`), so the remaining proof must be an unknown production path after deploy. The production step currently audits only the home page.

## Nits

### N1. The HTML byte baseline is stale by 20 bytes

A fresh `pnpm --filter @zero/landing run build` produced `dist/index.html` at 14,758 bytes, not 14,738 (`docs/plans/landing-minimal.md:41`, `docs/plans/landing-minimal.md:371`, `docs/plans/landing-minimal.md:441`). The 9,157, 4,124, and 5,033 CSS figures are exact.

### N2. Deletion counts are wrong even though the intended grep-to-zero result is clear

There are 10 `↗` spans in `index.astro` and one in `404.astro`, not eight (`docs/plans/landing-minimal.md:243`). There are three kickers on the home page plus the 404 kicker, so the change deletes four across the package, not three (`docs/plans/landing-minimal.md:230`, `apps/landing/src/pages/404.astro:21`). The acceptance text later says all arrow spans and separately covers the 404 kicker, so implementation intent is recoverable.

### N3. The exact production performance gate is stricter than its cited precedent

Running Lighthouse 13.4.1 locally reproduced accessibility 0.94, best-practices 1.0, SEO 1.0, one failing `color-contrast` audit, and exactly six failing orange nodes. The selectors and ratios match the plan: two buttons at 3.72, two kickers at 3.07, and two product links at 3.47. This is a strong positive control.

A five-run production median is realistic and has reached 100 before. Requiring exactly 100 is still sensitive to Speed Index variance. The cited prior plan explicitly allows a median of 99 when SI alone oscillates (`docs/plans/landing-perf.md:513-514`), while this plan removes that allowance (`docs/plans/landing-minimal.md:389-390`).

## Confirmed invariants and tooling

- Zero client JavaScript remains grounded. The current build has one script on the home page, `type="application/ld+json"`, and no script on the 404 page. No Astro island or client directive exists.
- CSS remains inline because `build.inlineStylesheets: "always"` is explicit (`apps/landing/astro.config.mjs:6`). Both built pages have one `<style>` and no stylesheet link.
- Canonical, OG, Twitter, and JSON-LD markup exists at `apps/landing/src/pages/index.astro:31-46`. The plan leaves this head markup unchanged.
- `robots.txt` and `sitemap.xml` are committed public assets (`apps/landing/public/robots.txt:1-4`, `apps/landing/public/sitemap.xml:1-6`) and appeared in `dist/` after the build.
- The real 404 configuration is unchanged (`apps/landing/wrangler.jsonc:5-8`), and `404.astro` keeps `noindex` (`apps/landing/src/pages/404.astro:10`).
- Archivo remains self-hosted, variable from 400 through 900, and uses `font-display: swap` (`apps/landing/src/styles/global.css:3-8`). Both pages preload it (`apps/landing/src/pages/index.astro:33`, `apps/landing/src/pages/404.astro:12`).
- No new dependency is proposed.
- Chromium and ImageMagick are available at the paths named by the plan. A throwaway HTML using the committed Archivo font ran through the exact headless Chromium and `magick -strip` sequence and produced a valid 1200x630 grayscale PNG. The regeneration path is runnable.
- Root changelog routing is correct. The redesign is user-visible (`AGENTS.md:13-20`), prior landing entries are in root `CHANGELOG.md:25-27`, and it must not go into the agent changelog.

## Round 2 targeted re-verification

### Verdict

**Not ready to execute as written.** Most round-1 fixes are present and proven, but two acceptance statements still contradict the plan, and the color check does not enforce the plan's ban on all hex literals.

### Blockers

#### R2-B1. One current outbound-link count still says 9 instead of 10

A fresh build produced 14 anchors on the home page: 10 outbound instances across six unique URLs, plus `#main`, two `/` wordmarks, and `#products`. This matches the detailed inventory at `docs/plans/landing-minimal.md:99-109` and the real links in `apps/landing/src/pages/index.astro`. Deleting the closing CTA leaves nine outbound instances across the same six URLs and 12 anchors total, as stated at `docs/plans/landing-minimal.md:109-112`, `docs/plans/landing-minimal.md:562-573`, and `docs/plans/landing-minimal.md:804-806`.

The measured-baseline table still says `14 total: 9 outbound instances` at `docs/plans/landing-minimal.md:94`. That conflicts with the detailed inventory and the built page. Change that cell to `14 total: 10 outbound instances`.

No outbound-link section says eleven. The remaining word `eleven` at `docs/plans/landing-minimal.md:396` and `docs/plans/landing-minimal.md:792` refers to the verified 10 home-page arrow spans plus one 404-page arrow span, which is correct.

#### R2-B2. The four-deviation summary contradicts the hover rationale

The plan now names four departures: muted foreground, border, hover neutral, and focus ring (`docs/plans/landing-minimal.md:260-293`, `docs/plans/landing-minimal.md:782-789`). The computed values are correct:

- `oklch(0.44 0 0)` rounds to `#525252` and has 7.77:1 contrast on white.
- The rejected `oklch(0.82 0 0)` rounds to `#c4c4c4` and has 1.75:1 contrast on white.
- The replacement border, `oklch(0.75 0 0)`, rounds to `#aeaeae` and has 2.23:1 contrast on white.
- `oklch(0.32 0 0)` rounds to `#333333` and has 12.15:1 contrast against `oklch(0.985 0 0)`.

The hover value is also correctly described as an independent choice and as lighter than both product-primary hover calculations at `docs/plans/landing-minimal.md:282-289`. However, the summary says all four departures "move darker, never lighter" at `docs/plans/landing-minimal.md:261-262`, and acceptance criterion 2 says all four are darker than what they replace at `docs/plans/landing-minimal.md:788-789`. Those statements cannot both be true for the named hover value. State that the three actual replacements move darker, while the independent hover neutral is lighter than the product's composited hover but remains a dark chroma-zero neutral. Make the same correction in acceptance criterion 2.

#### R2-B3. The color check permits grayscale hex despite the explicit no-hex rule

The inventory is now complete. It includes `oklch(0.42 0 0)`, all favicon paint and its planned repointing, the inline SVG `currentColor` paint, generated Tailwind paint, and the OG image's measured maximum channel spread (`docs/plans/landing-minimal.md:140-178`). The PNG command checks the maximum channel spread over every pixel rather than a histogram sample.

The checker itself was executed. It reports the documented 34 violations against the current tree. On isolated fixtures it exited 1 for `rgb(10,20,30)`, `#123456`, the named CSS color `tomato`, SVG `currentColor` and `blue` paint, and a PNG with one chromatic pixel. It exited 0 for a clean grayscale fixture. This proves that the named failure paths and full-image check run.

It also exited 0 for authored CSS containing `color: #777777`. That conflicts with the end-state rule "No hex" at `docs/plans/landing-minimal.md:295-297` and does not meet the requirement to catch arbitrary hex. The implementation at `docs/plans/landing-minimal.md:613-625` rejects only hex values whose RGB channels differ. Change it to reject every authored hex literal. The generated Tailwind `#0000` values disappear with the import, so the target output does not need an exception.

### Targeted confirmations

- **Tailwind default:** confirmed. The plan removes only `@import "tailwindcss"` and explicitly leaves `astro.config.mjs`, `package.json`, and `pnpm-lock.yaml` untouched. In a detached throwaway worktree, import removed plus plugin retained produced `dist/index.html` at 10,634 bytes and `dist/404.html` at 5,810 bytes. Removing the plugin import and Vite entry after that produced byte-identical files for both pages. Full dependency cleanup is clearly deferred.
- **Approval gate:** confirmed. `docs/plans/landing-minimal.md:15-54` has an explicit "Product decisions the user must approve" section. Each of the four deletions states its rationale and what is lost without softening the conversion, SEO, identity, or navigation cost.
- **404 proof:** confirmed. Local verification uses an unknown path, warns that `/404` and `/404.html` return 200 under Astro preview, and reserves the real Worker proof for an unknown production URL after deploy (`docs/plans/landing-minimal.md:704-724`).
- **Baselines and deletion counts:** confirmed. A fresh build produced 14,758-byte `index.html` and 9,934-byte `404.html`. Source contains 10 arrow spans on the home page plus one on the 404 page, and three home-page kickers plus one 404 kicker. The plan consistently uses 11 arrows and four kickers apart from the separate outbound typo in R2-B1.
- **Production performance:** confirmed. The plan allows a five-run median of 99 only when Speed Index is the sole sub-perfect metric and requires the five SI values to be recorded. This matches `docs/plans/landing-perf.md:513-514`.
