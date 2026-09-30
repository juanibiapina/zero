# Landing page: minimal, product-palette rework

## Goal

zeroapps.dev (`apps/landing`) is built around an accent color the product does
not have: an orange/red `--signal` (`oklch(0.64 0.22 33)` / `oklch(0.69 0.23 33)`)
that carries the button fill, the hero's second line, the wordmark dot, three
uppercase kickers, the in-content links, and the focus ring. The console
(`packages/ui`, `apps/dashboard-web`) is grayscale: chroma 0 everywhere except a
red `--destructive` for delete affordances and two status tints. Repoint the
landing page to the product's own palette — black and white, no reds — and strip
the design back to minimalism. **Minimalism is the goal, not a side effect: this
change deletes elements, it does not only recolor them.**

## Product decisions the user must approve

**Read this section before implementing anything.** Removing the orange is a
color decision and needs no approval. The four items below are not: each deletes
visible content, and none of them is a required consequence of dropping the
accent. They are in the plan because the brief asked for a minimal page, but
they are product and SEO calls, not mechanical cleanup. If the user rejects an
item, keep the element and restyle it in the new palette; nothing else in the
plan depends on these four.

1. **Delete the entire closing section**, including the visible headline text
   **"Add Zero to your projects."** and the second `Create an API key` button.
   *Rationale:* it is a verbatim duplicate of the hero CTA
   (`apps/landing/src/pages/index.astro:111` repeats `:66`), and it exists
   partly to justify a third background band that this change removes.
   *What is lost:* one headline of visible copy, its on-page keyword text
   ("Add Zero to your projects"), and **the page's second conversion point** —
   after this, a visitor who scrolls past the hero has no button to click. On a
   page this short the hero CTA stays on screen for most of the scroll, which is
   why the plan accepts the loss; it is still a real loss.
2. **Delete the product labels "Secrets management" and "Error reporting"**
   (`index.astro:75`, `:92`). *Rationale:* they are uppercase tracked kickers,
   the template tell this rework is removing, and the h2 plus the statement line
   below already say what each product does. *What is lost:* two lines of
   visible copy and the only on-page occurrences of the phrases "secrets
   management" and "error reporting" — the generic category terms someone might
   search for. The page keeps "Secrets", "Vault", "Errors", "failures", and
   "stack trace", and the `<title>`/meta description are untouched.
3. **Delete both product icons** (the inline lucide shield and bug in the two
   h2s). *Rationale:* at `0.72em` of a display heading they are ornament next to
   the words "Vault" and "Errors"; the console keeps them where they earn their
   place (nav rows, `packages/ui/src/products.ts`). *What is lost:* the two
   product marks and ~1.2KB of markup. Both are `aria-hidden` today, so no
   accessible name changes.
4. **Delete the "Products" header nav item** and the `id="products"` it targets.
   *Rationale:* it is already hidden below 680px, and the page is two screens
   long. *What is lost:* **the only in-page navigation item on the site**; the
   header nav becomes two outbound links. The `#main` skip link stays.

Everything else in "What gets deleted" is either a color, a wrapper element, or
a duplicate of information stated elsewhere, and needs no product sign-off.

## Current state (verified, not assumed)

`apps/landing` is a static Astro 7 site, `build.inlineStylesheets: "always"`,
self-hosted Archivo variable woff2 (preloaded), served by the asset-only Worker
`zero-landing` on `zeroapps.dev`, `not_found_handling: "404-page"`.

Files: `src/pages/index.astro`, `src/pages/404.astro`, `src/styles/global.css`,
`astro.config.mjs`, `public/{favicon.svg,og-image.png,robots.txt,sitemap.xml,_headers,fonts/}`.

Live page (screenshotted at 1440x940 and iPhone 14 during research):

- **Header** (black band): wordmark `Zero.` with an orange period, `Products`
  (in-page anchor, hidden below 680px), `Docs ↗`, `Dashboard ↗`.
- **Hero** (black band, `min-height: min(680px, 100svh - 5.5rem)`): orange
  all-caps kicker `FOR INDIE DEVELOPERS AND SMALL TEAMS`, h1 `One API key.` in
  white / `Every Zero product.` in orange, one orange filled CTA to
  `dash.zeroapps.dev/keys`.
- **Products** (`oklch(0.975)` band): two hairline-separated rows, each with an
  orange all-caps kicker, a display h2 with a large inline lucide SVG (shield /
  bug), a bold statement, a gray paragraph, and a right-hand column with an
  orange `Open Vault` / `Open Errors` link plus a gray `Setup guide` link to
  `docs.zeroapps.dev/{vault,errors}/getting-started/`.
- **Closing** (white band): a second h2 CTA `Add Zero to your projects.` with a
  second, identical orange button to `/keys`.
- **Footer** (black band): wordmark, `Docs ↗`, `Dashboard ↗`.

### Measured baseline (re-measured; every figure below is exact)

| figure | value |
|---|---|
| `dist/index.html` | **14,758 bytes** |
| `dist/404.html` | **9,934 bytes** |
| inline `<style>` (identical on both pages) | 9,157 bytes |
| — Tailwind prefix inside it | 4,124 bytes |
| — hand-written CSS inside it | 5,033 bytes |
| `<script>` on `/` | 1 (JSON-LD) |
| `<script>` on `/404` | 0 |
| anchors on `/` | 14 total: 10 outbound instances / 6 unique URLs… see below |
| `↗` spans | 10 in `index.astro`, 1 in `404.astro` = **11** |
| uppercase kickers | 3 in `index.astro`, 1 in `404.astro` = **4** |

Anchor inventory on `/` today (14 `<a>`): `#main` (skip link), `/` ×2
(wordmarks), `#products` ×1, and **10 outbound instances across 6 unique URLs**:

| URL | instances today | instances after |
|---|---|---|
| `https://docs.zeroapps.dev/` | 2 (header, footer) | 2 |
| `https://dash.zeroapps.dev/vault/projects` | 3 (header, footer, Open Vault) | 3 |
| `https://dash.zeroapps.dev/keys` | 2 (hero CTA, closing CTA) | **1** |
| `https://docs.zeroapps.dev/vault/getting-started/` | 1 | 1 |
| `https://dash.zeroapps.dev/errors/issues` | 1 | 1 |
| `https://docs.zeroapps.dev/errors/getting-started/` | 1 | 1 |
| **total** | **10 instances / 6 unique** | **9 instances / 6 unique** |

Deleting the closing CTA is the only change to this table. After the change `/`
has **12 anchors**: `#main`, `/` ×2, and 9 outbound. `/404` has 2 anchors
(`/` ×2) before and after.

So landing is *not* purely hand-written CSS today: `astro.config.mjs` loads
`@tailwindcss/vite` and `global.css` starts with `@import "tailwindcss"`, but
**no Tailwind utility class is used in any landing markup** — Tailwind
contributes only a reset and unused theme variables.

### The accessibility 94 is entirely the accent color

Measured during research with `npx lighthouse@13.4.1` against a local
`astro preview` of the current build (`--only-categories=accessibility`):
score **0.94**, one failing audit (`color-contrast`), six failing nodes, **all
six orange**:

| node | fg | bg | ratio |
|---|---|---|---|
| `a.button` (hero) | `#ffffff` | `#f4421d` | 3.72 |
| `a.button` (closing) | `#ffffff` | `#f4421d` | 3.72 |
| `.product-title > p` (x2 kickers) | `#ff4e29` | `#f7f7f7` | 3.07 |
| `.product-actions > a` (x2) | `#f4421d` | `#f7f7f7` | 3.47 |

No other accessibility audit fails. **Removing the accent removes the only
accessibility defect**, so this plan targets **accessibility 100**, not 94.

### Complete color inventory of `apps/landing` today

This is the exhaustive list. The check in Verification must drive all of it to
`oklch(L 0 0)` (or, for pixels, to gray), and must be able to catch anything new
that is not on it.

**`src/styles/global.css` `:root` (7 literals, lines 18–24)**

| literal | token | sRGB |
|---|---|---|
| `oklch(0.13 0 0)` | `--ink` | `#070707` |
| `oklch(0.975 0 0)` | `--canvas` | `#f7f7f7` |
| `oklch(1 0 0)` | `--paper` | `#ffffff` |
| `oklch(0.82 0 0)` | `--soft-line` | `#c4c4c4` |
| `oklch(0.42 0 0)` | `--muted` | `#4d4d4d` |
| `oklch(0.64 0.22 33)` | `--signal` | `#f4421d` |
| `oklch(0.69 0.23 33)` | `--signal-hot` | `#ff4e29` |

Used across ~18 rules in the same file. **No hex, `rgb()`, `hsl()`, or named
color appears anywhere in the authored landing source.**

**`public/favicon.svg`** — `fill="oklch(0.13 0 0)"` (square),
`stroke="oklch(0.64 0.22 33)"` (ring, the orange), `fill="oklch(0.975 0 0)"`
(dot), plus `fill="none"`. **The favicon must be repointed in this change**; it
is the third place the orange ships, after the CSS and the OG image.

**`src/pages/index.astro`** — the two inline lucide SVGs carry `fill="none"` and
`stroke="currentColor"` (`:76`, `:93`). Both SVGs are deleted, so `currentColor`
leaves the page with them.

**`src/pages/404.astro`** — no local style and no color literal at all; it
inherits the orange wordmark dot, kicker, button, focus ring, and dark hero from
the shared classes. That is why it must change in the same commit.

**Generated CSS (Tailwind prefix only)** — the built stylesheet additionally
contains `#0000` ×2, `transparent` ×2, `currentColor`/`currentcolor` ×2, and
`red` ×2 inside a `@supports (color: color-mix(in lab, red, red))` placeholder
probe. All eight vanish when the `@import` goes.

**`public/og-image.png`** — 1200x630 sRGB, 752 distinct colors: 687,102 px
`#070707`, 30,512 px `#ff4e29`, 20,427 px `#f7f7f7`, 5,015 px `#f4421d`, and the
rest antialiasing. Measured max per-pixel channel spread: **0.843137** (must
become exactly 0).

**Not present and must stay absent:** `theme-color` meta, web manifest, mask
icon, Apple touch icon, inline `<style>` blocks, `style=` attributes.

### The product's real palette

`packages/ui/src/styles.css` `:root` (shadcn "neutral", every value chroma 0
except `--destructive`):

| token | value | sRGB |
|---|---|---|
| `--background` | `oklch(1 0 0)` | `#ffffff` |
| `--foreground` | `oklch(0.145 0 0)` | `#0a0a0a` |
| `--primary` | `oklch(0.205 0 0)` | `#171717` |
| `--primary-foreground` | `oklch(0.985 0 0)` | `#fafafa` |
| `--muted` / `--secondary` / `--accent` | `oklch(0.97 0 0)` | `#f5f5f5` |
| `--muted-foreground` | `oklch(0.556 0 0)` | `#737373` |
| `--border` / `--input` | `oklch(0.922 0 0)` | `#e5e5e5` |
| `--ring` | `oklch(0.708 0 0)` | `#a1a1a1` |
| `--destructive` | `oklch(0.577 0.245 27.325)` | `#e7000b` |
| `--radius` | `0.625rem` (buttons use `rounded-md` = `calc(0.625rem - 2px)` = 8px) | |

So yes: **the product is black and white.** Color survives in exactly three
places, all of them state, none of them brand: `--destructive` (delete buttons,
`ConfirmDialog`'s destructive variant, `AsyncState` error text, `text-destructive`
trash icons), a green success box on `KeysPage`, and an amber warning badge in
`apps/dashboard-web/src/products/errors/components/badges.tsx`. **Landing has no
destructive, success, or warning state, so landing ships zero chroma.** That is
a hard, greppable invariant for this change (see Acceptance criteria).

Dark mode: `packages/ui/src/styles.css` defines a `.dark` block, but nothing in
`apps/dashboard-web` ever applies the class — no theme toggle, no `dark` on
`<html>` in `index.html`. **The console ships light-only, so landing stays
light-only**: keep `color-scheme: light`, add no `prefers-color-scheme` block.
Explicit non-goal.

The console uses the Tailwind default system font stack (no `font-family`
declaration anywhere in `packages/ui` or `apps/dashboard-web`). Landing keeps
Archivo — see "Typography" below. That difference already ships today and is
retained deliberately; it is not counted among the deviations below, which are
about color.

`apps/docs` (Starlight) uses stock Starlight theming with no custom CSS. Out of
scope, unchanged, and noted only so nobody "aligns" it in this change.

## Design direction

Named reference for the color strategy: **Vercel pure-black monochrome** — one
white surface, near-black type, hairline rules, a single black filled control.
The register reference's reflex-reject lanes apply to greenfield choices; here
the palette is dictated by an existing product identity, so identity
preservation wins. Do not re-introduce "voice" through a gimmick (gradient,
grain, stripes, decorative grid, sketchy SVG). The voice is Archivo at display
size, extreme white space, and 1px rules. Nothing else.

The brand register warns that a text-only page where typography carries all the
visual weight is a failure mode, and that answer is rejected here on purpose:
the product itself is a grayscale console with no illustration system, and the
honest surface for it is type and rules. The counter to flatness is scale and
space (an 88px h1 against 16px prose, one black button on white), **never**
added chroma or added ornament. If the page reads flat at the screenshot step,
fix the spacing and the type scale.

### Tokens (landing `:root`, replacing the current seven)

```css
:root {
  color-scheme: light;
  --background: oklch(1 0 0);             /* product --background */
  --foreground: oklch(0.145 0 0);         /* product --foreground */
  --primary: oklch(0.205 0 0);            /* product --primary */
  --primary-foreground: oklch(0.985 0 0); /* product --primary-foreground */
  --primary-hover: oklch(0.32 0 0);       /* landing-only, see deviation 3 */
  --muted-foreground: oklch(0.44 0 0);    /* darker than product, see deviation 1 */
  --border: oklch(0.75 0 0);              /* darker than product, see deviation 2 */
  --gutter: clamp(1.25rem, 5vw, 4rem);
  --page: 68rem;
}
```

Four of these seven color values are the product's tokens byte for byte. **The
other three, plus the focus-ring rule, are four deliberate departures from the
shared token system.** All four stay on the product's own neutral ramp
(chroma 0) and none is chromatic. Three of them replace a product value with a
**darker** one: `--muted-foreground` (0.44 vs 0.556), `--border` (0.75 vs 0.922),
and the focus ring (`--foreground` 0.145 vs `--ring` 0.708). The fourth,
`--primary-hover`, replaces nothing — the console has no such token — and is a
hair **lighter** than the console's composited `hover:bg-primary/90` (see
deviation 3). Every computed value below was converted and contrast-checked, not
estimated:

1. **`--muted-foreground` is `oklch(0.44 0 0)` = `#525252`, 7.77:1 on white**,
   instead of the product's `oklch(0.556 0 0)` = `#737373`, 4.73:1. The console
   uses that gray for dense table metadata; landing uses it for a paragraph of
   prose at 16px. 4.73 passes AA by 0.23 — too close to ship on a page whose
   whole point is legibility.
2. **`--border` is `oklch(0.75 0 0)` = `#aeaeae`, 2.23:1 on white**, instead of
   the product's `oklch(0.922 0 0)` = `#e5e5e5`, 1.26:1. *This value was
   re-picked during verification.* The earlier draft said `oklch(0.82 0 0)` and
   claimed 2.2:1 for it; `oklch(0.82 0 0)` is `#c4c4c4` and is actually
   **1.75:1**, which does not support the claim that the hairlines are visibly
   structural. Since the rules are the **only** structural device left once the
   color bands are deleted, the fix is the value, not the claim: `0.75` is the
   ramp step that genuinely delivers ~2.2:1. It is darker than the `--soft-line`
   landing ships today (`0.82`), which is correct — today the bands carry the
   structure, after this change the rules do. (WCAG 1.4.11's 3:1 does not apply:
   these are decorative separators, not UI components or meaningful graphics.
   2.23:1 is a design floor, not a conformance one.)
3. **`--primary-hover` is `oklch(0.32 0 0)` = `#333333`**, giving 12.15:1 against
   `--primary-foreground`. *This is an independent choice, not a derivation.* An
   earlier draft called it "product primary at 90% over white"; it is not. The
   console's `hover:bg-primary/90` composites to about `#2e2e2e` (OKLCH L≈0.302)
   in encoded sRGB, or L≈0.2845 mixed in OKLCH. `0.32` is a hair lighter than
   both, chosen so a large filled button visibly lifts on hover without the
   change reading as a second color. It is landing-only; the console has no such
   token.
4. **Focus ring is `2px solid var(--foreground)`** (19.79:1 against the page),
   not the product's `--ring`. `oklch(0.708 0 0)` = `#a1a1a1` is only 2.59:1 on
   white, invisible on this surface. One rule for every focusable element, with
   `outline-offset: 3px` so the ring falls on white even around the black button.

**The color rule, stated once here and enforced exactly by the check in
Verification step 4: every color literal that ships from `apps/landing` is
written `oklch(L 0 0)`, and every PNG pixel is gray. Nothing else is a color
literal on this page.** That means no hex — *including* a grayscale one like
`#777777` — no `rgb()`/`hsl()`/`lab()`/`color-mix()`, no named CSS color, no
`currentColor`, no `transparent`. This is stricter than "no chroma" on purpose:
the end state genuinely uses none of those notations (the only hex shipping
today is the Tailwind prefix's `#0000`, which leaves with the `@import`), so a
single notation is enforceable with no exception list, and any second notation
is a regression to catch whether or not that particular value happens to be
gray.

### Typography

Keep self-hosted Archivo (variable, 400–900, preloaded, `font-display: swap`).
It is already shipping, costs nothing new, is not on the reflex-reject list, and
after the color is gone it is the only thing carrying identity. Do not add a
second family. **Closed weight set: 400 (prose), 600 (links, lede, button), 800
(display headings and wordmark).** No other weight.

| role | size | weight | tracking | line-height |
|---|---|---|---|---|
| h1 | `clamp(2.75rem, 8vw, 5.5rem)` | 800 | `-0.03em` | 0.95 |
| h2 (product name) | `clamp(2rem, 4.5vw, 3rem)` | 800 | `-0.02em` | 1.0 |
| lede / product statement | `clamp(1.125rem, 1.1vw + 0.9rem, 1.375rem)` | 600 | 0 | 1.3 |
| body prose | `1rem` | 400 | 0 | 1.6 |
| nav / secondary link | `0.9375rem` | 600 | 0 | 1.4 |
| wordmark | `1.25rem` | 800 | `-0.03em` | 1 |

Steps are ≥1.25 apart (16 → 22 → 48 → 88). `text-wrap: balance` on h1/h2,
`text-wrap: pretty` on prose, prose `max-width: 60ch`, hero lede `max-width: 46ch`.
Display letter-spacing stays at or above the `-0.04em` floor (the current h1 is
already `-0.04em`; go to `-0.03em`).

### Layout and spacing rhythm

One surface (`--background`) for the entire document. No bands, no fills, no
shadows, no card boxes. Structure is: `--page: 68rem` centered, `--gutter`
inline padding, 1px `--border` rules, and varied vertical space.

| region | rhythm |
|---|---|
| header | `min-height: 4.5rem`, `border-bottom: 1px solid var(--border)` |
| hero | `padding-block: clamp(5rem, 12vw, 9rem) clamp(4rem, 9vw, 7rem)`; lede `margin-top: 1.25rem`; CTA `margin-top: 2.5rem` |
| each product row | `border-top: 1px solid var(--border)`, `padding-block: clamp(3rem, 6vw, 4.5rem)` |
| footer | `border-top: 1px solid var(--border)`, `padding-block: 2.5rem` |

Product row grid (≥900px): `grid-template-columns: 16rem minmax(0, 1fr)` with
`gap: clamp(1.5rem, 5vw, 5rem)` — product name left, copy right. Below 900px it
collapses to one column (`grid-template-columns: 1fr`, `gap: 1rem`) with the
name above the copy. **The right-hand actions column is deleted**: the two links
sit on one line under the paragraph (`display: flex; flex-wrap: wrap; gap: 1.5rem`).

Two breakpoints only, both already present: 900px (row collapse) and 680px
(gutter to `1.25rem`, footer stacks). No third breakpoint.

### Links and buttons with no accent

Color cannot signal interactivity, so the rules are:

- **In-content links** (product row links) are always underlined:
  `color: var(--foreground)`, weight 600, `text-decoration: underline`,
  `text-underline-offset: 0.25em`, `text-decoration-thickness: 1px`; hover/focus
  thickens to 2px.
- **Secondary in-content link** (`Setup guide`): same, but weight 400 and
  `color: var(--muted-foreground)` (7.77:1).
- **Navigation links** (header, footer): weight 600, `color: var(--foreground)`,
  no underline at rest, underline on hover/focus. Standard convention, keeps the
  header quiet.
- **The one button** (hero CTA): `background: var(--primary)`,
  `color: var(--primary-foreground)` (17.16:1), `border-radius: 0.5rem` (matches
  the console's `rounded-md`), `padding: 0.875rem 1.375rem`, 1rem/600, no border,
  no shadow. Hover: `background: var(--primary-hover)` (12.15:1 against
  `--primary-foreground`),
  `transition: background-color 120ms ease-out`. **It is the only filled surface
  and the only border-radius on the page** — that inversion is the entire
  hierarchy mechanism.
- **Focus**: `:focus-visible { outline: 2px solid var(--foreground); outline-offset: 3px; }`
  — see deviation 4 above.

### Motion

What is left: the 120ms button background fade and the link underline-thickness
transition. Keep the existing `@media (prefers-reduced-motion: reduce)` block.
No entrance animation, no scroll reveal, no transform.

## What gets deleted

Items 4, 5, 6 and 7 are the approval-gated ones; see "Product decisions the user
must approve".

1. `--signal` and `--signal-hot` and **every** use: button fill, in-content link
   color, three kicker colors, wordmark dot color, h1 span color, focus outline.
2. `--canvas` and `--paper`. One surface, `--background: oklch(1 0 0)`.
3. The inverted black bands: black header, black hero, black footer, and the
   `oklch(0.975)` products band. Also `html { background: var(--ink) }`.
4. **All four uppercase tracked kickers**: `.intro` ("FOR INDIE DEVELOPERS AND
   SMALL TEAMS") and both `.product-title > p` ("SECRETS MANAGEMENT", "ERROR
   REPORTING") in `index.astro`, plus the `404` kicker in `404.astro`. Three on
   the home page, one on the 404 page. *(Approval item 2 covers the two product
   labels.)*
5. Both inline lucide SVGs (shield, bug) in the product h2s. ~1.2KB of markup
   goes. *(Approval item 3.)*
6. **The entire `.closing` section** — headline plus the duplicate CTA plus the
   only reason a third background band existed. `/keys` stays reachable from the
   hero CTA, which becomes the page's single primary action, and the
   `dash.zeroapps.dev/keys` URL therefore stays in the outbound set (2 instances
   → 1). *(Approval item 1.)*
7. The `Products` header anchor and the `id="products"` it targets, and with it
   `html { scroll-behavior: smooth }`. *(Approval item 4.)*
8. **All eleven `↗` glyph spans**: 10 in `index.astro` (one of which goes with
   the closing section, so 9 are removed by hand) and 1 in `404.astro`. After (7)
   every link on the page except the wordmark and the skip link is outbound, so
   the marker carries no information. `rg -F '↗' apps/landing` must return
   nothing.
9. `.button:hover { transform: translateY(-2px) }`.
10. The hero's `min-height: min(680px, calc(100svh - 5.5rem))` viewport-filling
    rule (it existed to make the black band fill the screen).
11. `.product-body` / `.product-actions` wrapper divs (the right-aligned third
    column).
12. **The `@import "tailwindcss"` line in `src/styles/global.css`** — and
    nothing else Tailwind-related; see "Tailwind: import-only removal" below.
    Replace the preflight it provided with the minimal reset landing actually
    needs:

    ```css
    *, *::before, *::after { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; background: var(--background); }
    body, h1, h2, p { margin: 0; }
    a { color: inherit; }
    ```

    (No `<img>`, `<svg>`, or form element remains in the markup after (5), so
    the rest of preflight has nothing to normalize.)

**Kept deliberately**: the wordmark's period (`Zero.` renders as plain
foreground text with no `<span>`) and the ring mark in the favicon — a logo is
identity, and identity preservation beats deletion. The `.skip-link` stays
(restyled: `background: var(--background)`, `color: var(--foreground)`,
`1px solid var(--foreground)`), and so does its `#main` target.

## Tailwind: import-only removal

**Remove the `@import "tailwindcss"` from `global.css`. Do not touch
`apps/landing/astro.config.mjs` and do not touch `apps/landing/package.json`.**
This was measured, not reasoned:

- Deleting the import alone drops the built stylesheet from 9,157 to **5,033
  bytes** and `dist/index.html` from 14,758 to **10,634 bytes** — the entire
  4,124-byte saving. Removing the plugin and the two devDependencies adds
  **zero** further browser bytes.
- With the import gone, **the `@tailwindcss/vite` plugin emits nothing.**
  Verified by building twice: import removed / plugin kept, and import removed /
  plugin and its config entry removed. The two `dist/index.html` files are
  **byte-identical** (10,634 bytes each, `cmp` clean). Leaving the plugin
  configured has no build-output effect at all; it costs one no-op Vite plugin
  at build time and two unused devDependencies on disk.
- Removing the devDependencies would edit `pnpm-lock.yaml`, which sits in the
  build watch paths of **all four** Workers Builds connectors. A throwaway
  worktree probe (`pnpm install --lockfile-only` with the two deps removed)
  produced a **394-line** lockfile diff, almost all of it unrelated
  peer-resolution churn. That would rebuild and redeploy `zero-api`, and a
  `zero-api` deploy resets any mid-turn `UserDO` ("Durable Object reset because
  its code was updated") and aborts in-flight agent turns. Paying that for a
  0-byte win on a landing-page restyle is the wrong trade.

Tailwind 4.3.3 stays in the monorepo regardless, for `apps/agent-web` and
`apps/dashboard-web`.

**Deferred follow-up (do not do it in this change):** drop `@tailwindcss/vite`
and its import from `apps/landing/astro.config.mjs` and drop `tailwindcss` and
`@tailwindcss/vite` from `apps/landing/package.json`. Ride it along with the
next change that already has to touch `pnpm-lock.yaml`, so the all-worker
redeploy is paid once for something that needs it. Until then, the dead plugin
config is a known, documented leftover — note it in the commit message so the
next lockfile change can pick it up.

**Follow-up completed:** the landing Tailwind plugin and both direct
Tailwind dependencies have been removed. See [the landing site documentation](../landing.md)
for current styling and build behavior.

## Copy changes (minimal, each justified)

This is a visual rework; the only copy edits are consequences of deletions.

1. `For indie developers and small teams` moves from an all-caps colored kicker
   to a normal-case lede sentence under the h1, with a period added. Words
   unchanged. (The pattern it leaves behind — a tracked uppercase eyebrow above
   every section — is a template tell independent of the color.)
2. `Secrets by product and environment` gains a full stop, matching the Errors
   statement, which already has one.
3. The closing headline `Add Zero to your projects.` is deleted with its section
   (approval item 1).
4. The 404 page loses its `404` kicker (the HTTP status and the
   `<h1>Page not found.</h1>` already say it) and keeps one link home, styled as
   the button.

Nothing else changes: h1, meta description, `og:*`/`twitter:*` titles and
descriptions, product paragraphs, and the `<title>` stay exactly as they are.

## Files to change

| file | change |
|---|---|
| `apps/landing/src/styles/global.css` | rewritten around the token block above; drop the `@import "tailwindcss"`; expected ~2.5–3KB raw |
| `apps/landing/src/pages/index.astro` | markup deletions (4,5,6,7,8,11) + restructured product rows; head untouched |
| `apps/landing/src/pages/404.astro` | uses the same header/hero classes, must be updated in the same change or it breaks; loses its kicker and its `↗` |
| `apps/landing/public/favicon.svg` | recolor, see below |
| `apps/landing/public/og-image.png` | regenerate, see below |
| `docs/landing.md` | update the og-image description ("Zero wordmark on the brand dark background" is no longer true) and add a short design note: palette comes from `packages/ui` tokens, chroma-0 invariant, no Tailwind CSS in the output, light-only |
| `CHANGELOG.md` (root) | the bullet below |

**Explicitly not changed**: `apps/landing/astro.config.mjs`,
`apps/landing/package.json`, `pnpm-lock.yaml` (see "Tailwind: import-only
removal"), and `robots.txt`, `sitemap.xml`, `_headers`, `wrangler.jsonc`,
`public/fonts/*`, the font preload, the canonical link, every OG/Twitter tag,
the JSON-LD `Organization` + `WebSite` block, and all six outbound URLs.

### favicon.svg

Currently a black square with an orange ring and a near-white dot. Recolor,
same geometry: `rect` fill `oklch(0.145 0 0)`, ring `stroke` `oklch(1 0 0)`
(width 10), dot `fill` `oklch(0.145 0 0)` — the dot now reads as a gap punched
in the white ring. Keep `fill="none"` on the ring circle. Keep the black square
so the mark stays legible on both light and dark tab bars.

### og-image.png

The current card is 91% `#070707` with ~35k orange pixels: the wordmark dot, the
kicker, and the whole second headline line. **It must be regenerated in the same
commit**, or every shared link keeps showing the old accent. It was originally
made by screenshotting HTML with headless Chromium; do the same, no new
dependency:

1. Write a throwaway `/tmp/og.html`: 1200x630, `background: #ffffff`, Archivo
   loaded via `@font-face` from `file:///…/apps/landing/public/fonts/archivo-latin.woff2`,
   the recolored mark + `Zero.` wordmark at the top left in `oklch(0.145 0 0)`,
   and `One API key.` / `Every Zero product.` below it in the same black at
   weight 800, matching the hero's tracking and line-height. No kicker.
2. `chromium --headless --disable-gpu --no-sandbox --hide-scrollbars --window-size=1200,630 --screenshot=/tmp/og.png file:///tmp/og.html`
   (`/run/current-system/sw/bin/chromium` exists on this box).
3. `magick /tmp/og.png -strip apps/landing/public/og-image.png`
4. Verify size and grayscale — see Verification step 6. A rehearsal of exactly
   this sequence (black Archivo text on white, headless Chromium, `magick
   -strip`) produced a 1200x630 PNG with max channel spread **0**, so grayscale
   antialiasing is the default here. If a run ever yields a non-zero spread, add
   `--disable-lcd-text` to the Chromium flags rather than post-converting.

## Deploy impact (read before pushing)

Because no dependency and no lockfile changes, the changed paths are
`apps/landing/**`, `docs/landing.md`, and root `CHANGELOG.md`. Of those, only
`apps/landing/*` is in any connector's build watch paths, and it belongs to
`zero-landing` alone. **So this push rebuilds and redeploys only `zero-landing`.
`zero-api` is not rebuilt and no agent turn is interrupted.** That is the main
reason the full Tailwind cleanup is deferred.

## Verification

This box cannot run `workerd`, so there is no `wrangler dev` for landing — but
`astro preview` works and was used during research, so everything except the
production performance score and the real Worker 404 is verifiable locally.

1. `pnpm --filter @zero/landing run build`, `run lint`, `run typecheck` all pass.

2. **Build output, against `dist/index.html` and `dist/404.html`:**
   - exactly one `<script` on `/`, and it is `type="application/ld+json"`; zero
     `<script` on `/404`;
   - exactly one `<style>` block per page and no `<link rel="stylesheet">`;
   - `rg -F '↗' apps/landing/src apps/landing/dist` returns nothing;
   - `rg -F '#products' apps/landing/src apps/landing/dist` returns nothing;
   - **byte gate:** `dist/index.html` **< 10,634 bytes** (the measured
     import-only floor with today's CSS; the markup deletions guarantee more).
     Baseline 14,758. Record the actual number in the PR/commit; expect ~8KB.
     Also record `dist/404.html` (baseline 9,934, import-only floor 5,810,
     expect ~4KB).
   - `robots.txt`, `sitemap.xml`, `og-image.png`, `favicon.svg`, `fonts/` are in
     `dist/`.

3. **Outbound links** on `dist/index.html`, extracted with
   `rg -o '<a\b[^>]*href="([^"]+)"' -r '$1'` (or the equivalent one-liner):
   - the set of unique `https://` hrefs is **exactly these six**:
     `https://docs.zeroapps.dev/`,
     `https://docs.zeroapps.dev/vault/getting-started/`,
     `https://docs.zeroapps.dev/errors/getting-started/`,
     `https://dash.zeroapps.dev/vault/projects`,
     `https://dash.zeroapps.dev/errors/issues`,
     `https://dash.zeroapps.dev/keys`;
   - the count of `https://` anchor **instances** is exactly **9** (baseline 10;
     the closing CTA is the only one removed);
   - total anchors on `/` is **12** (`#main`, `/` ×2, the 9 outbound); `/404`
     has **2** (`/` ×2).

4. **Color check — must be able to fail.** Run this script from the repo root
   with `apps/landing/dist` built. It scans authored source, build output, and
   every PNG. It enforces the rule stated in "Tokens" above, exactly: it exits 1
   on chromatic `oklch()`, any `rgb()`/`hsl()`/`lab()`/`color-mix()` function,
   **any hex literal at all — grayscale hex like `#777777` fails too**, any named
   CSS color / `currentColor` / `transparent` in a paint context, and any PNG
   with a non-zero max per-pixel channel spread.

   ```python
   #!/usr/bin/env python3
   """Fail if apps/landing ships any color literal other than oklch(L 0 0),
   or any non-gray pixel."""
   import re, subprocess, sys, pathlib

   ROOTS = ["apps/landing/src", "apps/landing/public", "apps/landing/dist"]
   TEXT_EXT = {".css", ".astro", ".svg", ".html", ".mjs", ".ts", ".js"}
   PAINT_ATTR = r"(?:style|fill|stroke|color|stop-color|flood-color|lighting-color)"
   NAMED = set("""aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond
   blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk
   crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta
   darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray
   darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick
   floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey
   honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon
   lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink
   lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow
   lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple
   mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue
   mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
   palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
   powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen
   seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal
   thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen currentcolor
   transparent""".split())

   fails = []

   def scan_any(where, text):
       for m in re.finditer(r"oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)", text, re.I):
           if float(m.group(2).rstrip("%")) != 0:
               fails.append(f"{where}: chromatic oklch -> {m.group(0)})")
       for m in re.finditer(r"\b(rgba?|hsla?|hwb|lab|lch|oklab|color-mix)\s*\(", text, re.I):
           fails.append(f"{where}: color function {m.group(1)}()")
       # Any hex at all, gray included: the end state uses no hex notation.
       for m in re.finditer(r"#([0-9a-fA-F]{3,8})\b", text):
           fails.append(f"{where}: hex literal #{m.group(1)}")

   def scan_keywords(where, text):
       for m in re.finditer(r"[A-Za-z-]+", text):
           if m.group(0).lower() in NAMED:
               fails.append(f"{where}: color keyword '{m.group(0)}'")

   def paint_regions(text):
       yield from re.findall(r"<style[^>]*>(.*?)</style>", text, re.S | re.I)
       yield from re.findall(r"<svg\b.*?</svg>", text, re.S | re.I)
       yield from (m.group(1) for m in
                   re.finditer(PAINT_ATTR + r"\s*=\s*[\"']([^\"']*)[\"']", text, re.I))

   for root in ROOTS:
       if not pathlib.Path(root).exists():
           continue
       for p in sorted(pathlib.Path(root).rglob("*")):
           if not (p.is_file() and p.suffix.lower() in TEXT_EXT):
               continue
           text = p.read_text(errors="ignore")
           scan_any(str(p), text)
           if p.suffix.lower() in {".css", ".svg"}:
               scan_keywords(str(p), text)
           else:
               for region in paint_regions(text):
                   scan_keywords(str(p), region)

   for root in ROOTS:
       if not pathlib.Path(root).exists():
           continue
       for p in sorted(pathlib.Path(root).rglob("*.png")):
           spread = subprocess.run(
               ["magick", str(p), "-colorspace", "sRGB", "-separate",
                "(", "-clone", "0-2", "-evaluate-sequence", "max", ")",
                "(", "-clone", "0-2", "-evaluate-sequence", "min", ")",
                "-delete", "0-2", "+swap", "-compose", "difference", "-composite",
                "-format", "%[fx:maxima]", "info:"],
               capture_output=True, text=True).stdout.strip()
           if spread != "0":
               fails.append(f"{p}: non-gray pixels, max channel spread {spread} (must be 0)")

   for f in fails:
       print("COLOR VIOLATION:", f)
   print(f"{len(fails)} violations")
   sys.exit(1 if fails else 0)
   ```

   **Positive control (run it before making the change):** against the current
   tree it must report violations in all five families — chromatic `oklch` in
   `global.css`, `favicon.svg` and both built pages; `color-mix()`,
   `currentColor`, `transparent` and `red` from the Tailwind prefix and the
   inline SVGs; the hex literal `#0000` ×2 in each built page, also from the
   Tailwind prefix; and `max channel spread 0.843137` on `public/og-image.png`
   and `dist/og-image.png`. It was run against the current tree: **38
   violations** (34 of them before the hex rule was tightened to reject gray hex
   too, plus the four `#0000`), and 0 on a fixture built to the target palette
   (prose containing the words "red", "gold", "orange" outside paint contexts,
   `prefers-reduced-motion`, `#main`, `#products`, `fill="none"` and
   `color: inherit` all correctly ignored). Re-injecting a
   `border: 1px solid red`, a `#ff4e29`, a `color: #777777`, an `rgb(10,20,30)`,
   an SVG `fill="tomato"`, and a chromatic PNG made it fail on all six.

   **After the change it must print `0 violations` and exit 0.** Requires
   `magick` (ImageMagick), present on this box.

5. **Local Lighthouse**, deterministic categories, against
   `pnpm --filter @zero/landing exec astro preview --port 5181`:
   ```
   CHROME_PATH=/run/current-system/sw/bin/chromium \
   npx --yes lighthouse@13.4.1 http://localhost:5181/ \
     --only-categories=accessibility,seo,best-practices \
     --output=json --output-path=/tmp/lh.json \
     --chrome-flags="--headless --no-sandbox --disable-gpu" --quiet
   ```
   Accessibility must be **1.0** with zero `color-contrast` nodes (baseline
   measured the same way today: 0.94, six orange nodes). SEO and best-practices
   must stay **1.0**.

6. **og-image**: `magick identify` reports `1200x630`, and the spread check from
   step 4 reports exactly `0` for `apps/landing/public/og-image.png`. Do **not**
   accept a top-N histogram as proof; it cannot rule out a stray chromatic pixel.

7. **Missing-path behavior, locally.** Against the same `astro preview`:
   ```
   curl -s -o /tmp/nf.html -w '%{http_code}\n' http://localhost:5181/definitely-missing-path-98765
   ```
   must print `404` and `/tmp/nf.html` must contain `Page not found.`.
   **Do not check `/404` for this**: under `astro preview`, `/404` and
   `/404.html` are concrete generated routes and return **200** (verified), so
   hitting them proves nothing about the missing-path response. `/404` is still
   the right URL for the *visual* screenshot in step 8.

8. **Screenshots** with the browse skill at 1440x940 and iPhone 14, for `/` and
   `/404`: no overflow of the h1 at any breakpoint, hairlines visible at
   `#aeaeae`, product rows readable in one column on mobile, focus ring visible
   when tabbing, and heading/paragraph margins unchanged by the preflight
   removal (compare against the pre-change screenshots).

9. **After the `zero-landing` build finishes on `main`**, against production:
   - **Real 404:** `curl -sS -o /tmp/prod404.html -w '%{http_code}\n' https://zeroapps.dev/no-such-path-98765`
     must print **404** (this is the Worker's `not_found_handling: "404-page"`,
     which cannot run on this box) and `/tmp/prod404.html` must contain
     `Page not found.` and `<meta name="robots" content="noindex">`.
   - **Lighthouse mobile**, the same command the earlier perf work used
     (`docs/plans/landing-perf.md`): run performance **5 times**; the **median
     must be 100**, with one documented allowance carried over from that plan
     (`docs/plans/landing-perf.md:513-514`): a median of **99 whose only
     sub-perfect metric is Speed Index** (SI score oscillating 0.98–1.00) is the
     known residual variance, not a defect — record the five SI values and move
     on. Any 99 caused by anything other than SI is a defect. SEO,
     best-practices, and accessibility must each be **100**.

## Changelog

Root `CHANGELOG.md` (this is the console/product changelog; landing entries
already live there, e.g. the 2026-07-27 "landing page loads faster" bullet).
Add as the newest entry, above the current top bullet:

```
- 2026-07-28: The zeroapps.dev home page is now plain black on white, the same as the dashboard: the orange is gone, there is one clear "Create an API key" button instead of two, and each product is just its name, what it does, and where to go next. It also loads a little lighter, and its text now meets contrast requirements everywhere.
```

## Skills to use

- `impeccable` — the build itself; this plan's design direction is its input.
- `changelog` — before touching `CHANGELOG.md`.
- `browse` — the screenshot checks in step 8.
- `reproducible-locally` — steps 1–8 are the local proof; step 9 is the
  post-deploy proof (the real 404 and the perf score can only be measured there).
- `git-commit` — one commit for the rework (code + changelog + docs + og-image),
  mentioning the deferred Tailwind config/devDependency cleanup.

## Risks

- **Preflight removal changes defaults.** Mitigated by the explicit reset above
  and by the before/after screenshot comparison in step 8. Watch for heading and
  paragraph margins, which preflight currently zeroes globally.
- **Stale social card.** If `og-image.png` is not regenerated in the same commit,
  shared links keep showing orange while the site is monochrome.
- **The page reads too plain.** The counter is hierarchy through size and space,
  not color: the 88px h1, the single black button, and the 1px rules at 2.23:1.
  If it reads flat after step 8, fix it with spacing and scale, never by adding
  chroma back.
- **Hairlines at `oklch(0.75 0 0)` may read heavy** next to an otherwise very
  quiet page — the opposite risk of the one they were darkened for. Judge it in
  step 8; if it is too strong, the move is one step lighter on the same ramp
  (`0.78` = `#b7b7b7`, 2.00:1), not back to the product's 1.26:1.
- **Dead Tailwind config is left behind on purpose.** Verified to have no
  build-output effect. The cost is one stale plugin entry and two unused
  devDependencies until the deferred follow-up lands.
- **Perf regression is unlikely** (the change ships strictly fewer bytes and no
  new resources), but step 9 is still measured against production before calling
  it done.

## Acceptance criteria

1. **Zero chroma, one notation.** The color check in Verification step 4 prints `0 violations`
   and exits 0 against source, `dist/`, and every PNG. `--signal`,
   `--signal-hot`, and both orange values are gone from the CSS, the favicon,
   the built output, and the OG image.
2. **Palette is the product's, with four named deviations.**
   `--background`, `--foreground`, `--primary`, and `--primary-foreground` are
   byte-identical to `packages/ui/src/styles.css`. The four deviations are
   exactly: `--muted-foreground` `oklch(0.44 0 0)`, `--border`
   `oklch(0.75 0 0)`, `--primary-hover` `oklch(0.32 0 0)` (a landing-only token,
   not a derivation of the product primary), and the `2px solid var(--foreground)`
   focus ring in place of the product `--ring`. All four are chroma 0. The three
   that replace a product value (`--muted-foreground`, `--border`, the focus
   ring) are darker than what they replace; `--primary-hover` replaces nothing
   and is a hair lighter than the console's composited `hover:bg-primary/90`
   (`#2e2e2e`). Each carries a one-line comment in the stylesheet.
3. **Every deletion in "What gets deleted" (1–12) is done**, including the
   closing section, all four kickers, both inline SVGs, all eleven `↗` spans,
   the `Products` anchor and its target, and the `@import "tailwindcss"`.
   `rg -F '↗' apps/landing` and `rg -F '#products' apps/landing` both return
   nothing.
4. **The four approval-gated deletions were approved by the user before
   implementation** (or the rejected ones were kept and restyled instead).
5. **Build output.** `dist/index.html` ships exactly one `<script>` (the JSON-LD)
   and one inlined `<style>`; `dist/404.html` ships zero scripts and one inlined
   `<style>`; neither has a `<link rel="stylesheet">`;
   `build.inlineStylesheets: "always"` is still set; `dist/index.html` is
   **under 10,634 bytes** (down from the 14,758-byte baseline) and the actual
   size is recorded.
6. **Links.** `dist/index.html` contains exactly **9 outbound anchor instances**
   across exactly the **6 unique URLs** listed in Verification step 3, and 12
   anchors in total; all six URLs resolve.
7. **Head and assets unchanged.** `robots.txt`, `sitemap.xml`, `_headers`, the
   canonical link, every OG/Twitter tag, the font preload, and the JSON-LD block
   are untouched; `og-image.png` is still exactly 1200x630 and its max per-pixel
   channel spread is exactly 0.
8. **404.** `404.astro` renders correctly in the new system, keeps its `noindex`,
   and an unknown path returns a real HTTP 404 with the 404 page body — proven
   locally under `astro preview` (step 7) and again against production
   `zeroapps.dev` after deploy (step 9).
9. **Untouched by design:** `apps/landing/astro.config.mjs`,
   `apps/landing/package.json`, and `pnpm-lock.yaml` have no diff, so the push
   redeploys `zero-landing` only.
10. **Local quality gates.** `build`, `lint`, and `typecheck` pass for
    `@zero/landing`; local Lighthouse gives accessibility **1.0** with zero
    `color-contrast` nodes (up from 0.94 / six nodes), SEO **1.0**,
    best-practices **1.0**.
11. **Production gates after deploy.** Lighthouse mobile: SEO 100,
    best-practices 100, accessibility 100, and performance median of 5 runs =
    **100**, or **99 with Speed Index as the sole sub-perfect metric**, with the
    five SI values recorded (the allowance from
    `docs/plans/landing-perf.md:513-514`).
12. **Same commit.** The root `CHANGELOG.md` bullet above and the `docs/landing.md`
    update (og-image no longer dark-background; design note added) ship with the
    code, and the commit message names the deferred Tailwind config/devDependency
    cleanup.
