# Plan: surface the docs site everywhere users look for it

## Goal

The docs site at `https://docs.zeroapps.dev` is now real, live content (ZeroVault
+ ZeroErrors guides), but nothing in the product links to it, so nobody finds it.
Add deliberate, deep-linked pointers on the surfaces where a user would look for
help — the landing page, the two dashboard consoles, and the CLI — without
regressing the landing site's Lighthouse posture and without cluttering the
minimal console UI.

Every link target below was verified to return HTTP 200 on 2026-07-28, and the
pages are real content (not placeholders); the live pages carry no `noindex`
directive and `robots.txt` allows crawling.

## Verified live targets (all 200)

| URL | What it is |
|---|---|
| `https://docs.zeroapps.dev/` | Docs home (both products) |
| `https://docs.zeroapps.dev/vault/getting-started/` | Vault: create project, secret, API key |
| `https://docs.zeroapps.dev/vault/cli/` | Vault CLI reference |
| `https://docs.zeroapps.dev/vault/loading-secrets/` | Using a key to load secrets into any process/CI |
| `https://docs.zeroapps.dev/errors/getting-started/` | Errors: send your first report, see it grouped |

Other live pages not used as targets here: `/vault/overview/`,
`/vault/workers/`, `/errors/overview/`, `/errors/reporter/`,
`/errors/worker-integration/`, `/skills/overview/`.

---

## Per-surface inventory (what exists today)

### 1. Landing page — `apps/landing`

Static Astro, zero client JS, Lighthouse 100 SEO / 100 mobile perf / CLS 0.
Single page: `apps/landing/src/pages/index.astro`, styles in
`apps/landing/src/styles/global.css` (320 lines).

- **Header** (`<header class="site-header">`): wordmark on the left; `<nav>` on the
  right holds two plain `<a>`: `Products` (in-page anchor `#products`) and
  `Dashboard ↗` (`class="header-link"`, points to
  `https://dash.zeroapps.dev/vault/projects`). Nav is flex with a `gap`;
  `.site-header` has a fixed `min-height: 5.5rem`. On mobile, CSS hides the first
  nav child (`.site-header nav > a:first-child { display: none; }`), so only
  `Dashboard ↗` shows.
- **Hero**: one CTA button, `Create an API key ↗` → `…/vault/keys`.
- **Products section**: two `<article class="product">` cards (Vault, Errors).
  Each card body has copy plus one link: `Open Vault ↗` / `Open Errors ↗`.
- **Closing section**: `Add Zero to your projects.` + `Create an API key ↗`.
- **Footer** (`<footer class="site-footer">`): wordmark + one `Dashboard ↗`
  (`class="footer-link"`).

There is no docs link anywhere. The header/footer already carry an external
cross-subdomain link pattern (`Dashboard ↗`) with `class="header-link"` /
`class="footer-link"` and an `aria-hidden` `↗` glyph — a docs link reuses this
exact pattern, adding no new CSS and no new visual language.

### 2. Dashboard consoles — `apps/dashboard-web` + shared `packages/ui`

Shared shell: `packages/ui/src/components/AppLayout.tsx` (Cloudflare-style left
rail: brand, product switcher, nav items; collapses to a top bar + horizontal
nav strip on mobile). Both consoles render through it.

Empty states and first-run gates found:

- **No projects yet** — `apps/dashboard-web/src/products/vault/pages/ProjectsPage.tsx`:
  `"No projects yet. Create one to get started."`
- **No API keys** — `apps/dashboard-web/src/products/vault/pages/KeysPage.tsx`:
  `"No API keys yet."` Plus a success banner after creating a key
  (`New API key created. Copy it now…`) — the moment the user has a key and needs
  to know what to do with it.
- **No secrets** — `apps/dashboard-web/src/products/vault/pages/SecretsPage.tsx`:
  `"No secrets yet."`
- **No issues** — `apps/dashboard-web/src/products/errors/pages/IssuesPage.tsx`:
  `"No issues yet."` (empty because nothing has been reported yet — the key
  activation moment for ZeroErrors).
- **Environments** — `apps/dashboard-web/src/products/vault/pages/EnvironmentsPage.tsx`:
  projects are seeded with `development` + `production`, so this is effectively
  never empty.
- **First-run org gate** — `AppLayout.tsx`, the `!organization` branch renders
  Clerk's `<CreateOrganization>` under "Create your organization to get started".
  This is a rare edge case; the Vault getting-started guide explicitly says an org
  is auto-created on sign-up, so it would *contradict* this gate.

### 3. CLI — `packages/zerovault-cli`

Published npm package (`zerovault-cli`), Commander-based, entry
`packages/zerovault-cli/src/index.ts`.

- `program.description("ZeroVault secrets manager CLI")` — shown in `zv --help`.
  No docs URL anywhere in help output; no `.addHelpText(...)`.
- The **no-API-key** error (in `getClient()`):
  `"Error: no API key. Set ZEROVAULT_API_KEY, pass --api-key, or bind this
  directory to a context with \`zv context use\`."` — tells the user *how to
  supply* a key but not *how to get* one.
- `DEFAULT_BASE_URL = "https://api.zeroapps.dev/vault"` already hardcoded.
- `.version("0.2.1")` in source (published/referenced elsewhere as 0.2.2; a
  publish needs the usual version bump — an existing process concern, not created
  by this change).

### 4. Agent — `apps/agent-api`

System topics: `apps/agent-api/src/store/system-topics.ts` bundles exactly two
read-only topics, `Zero` (pinned identity) and `Changelog`. No `/help` or
`/start` handler surfaces a docs pointer (the "onboarding" code is a Gmail scan,
unrelated).

The docs site documents **ZeroVault and ZeroErrors** — developer products. The
agent (the Zero assistant over Telegram) is a *separate product* with a
non-developer audience ("anyone who wants a personal AI assistant"). A
Vault/Errors docs link inside the assistant's identity topic or its Changelog
would be off-target for that audience. **No genuine fit — see "Surfaces to skip".**

---

## Proposed changes

### A. Landing header nav — global docs entry point

`apps/landing/src/pages/index.astro`. Add one `<a>` in the header `<nav>`, between
`Products` and `Dashboard ↗`, mirroring the existing `Dashboard` link exactly
(same `class="header-link"`, same `↗` treatment):

```html
<a class="header-link" href="https://docs.zeroapps.dev/">Docs <span aria-hidden="true">↗</span></a>
```

- **Target:** `https://docs.zeroapps.dev/` (nav = product-wide entry, so the docs
  home, not a deep link).
- **Placement/order:** Products → Docs → Dashboard reads as browse → learn → use.
- **Copy:** `Docs`, not "Documentation" (shorter, fits the terse nav) and not
  "click here". The `↗` (aria-hidden) already signals an external jump, matching
  `Dashboard ↗`.
- **Mobile note:** the first nav child (`Products`) is hidden on mobile, so mobile
  shows `Docs ↗` and `Dashboard ↗` — both real, both useful. Flex `gap` handles
  the extra item with no new CSS.

### B. Landing footer — symmetric docs link

`apps/landing/src/pages/index.astro`, in `<footer class="site-footer">`, add a
`Docs ↗` before the existing `Dashboard ↗`, reusing `class="footer-link"`:

```html
<a class="footer-link" href="https://docs.zeroapps.dev/">Docs <span aria-hidden="true">↗</span></a>
```

- **Target:** `https://docs.zeroapps.dev/`.
- Footer becomes wordmark · Docs ↗ · Dashboard ↗ — still flex `space-between`,
  no new CSS.

### C. Landing product cards — per-product deep links (recommended)

Each product `<article>` currently has one action link. Add one secondary,
deep-linked docs link per card so a developer evaluating a specific product lands
on that product's getting-started, not the docs home. Reuse the existing
`.product-body a` styling; keep it visually secondary to `Open Vault`/`Open Errors`.

- **Vault card** → `https://docs.zeroapps.dev/vault/getting-started/`, copy:
  `Setup guide ↗`.
- **Errors card** → `https://docs.zeroapps.dev/errors/getting-started/`, copy:
  `Setup guide ↗`.

This is the one landing spot with clutter risk (two `↗` links per card). Keep the
docs link lighter-weight than the primary `Open …` link (it already renders in
the muted product-body link style). If, in build, two links per card reads busy
against the minimal brand, drop C and keep A + B; A is the must-have.

### D. Console: always-available docs link in the shared left rail

`packages/ui/src/components/AppLayout.tsx`. Add a single external docs link pinned
to the bottom of the desktop `<aside>` left rail (after the `<nav>` block, using
`mt-auto` so it sits at the rail's foot), rendered as a plain external anchor
(not a react-router `<Link>`), muted, with the same external affordance as the
rest of the console:

- **Target:** `https://docs.zeroapps.dev/`.
- **Copy:** `Docs ↗` (external `<a target="_blank" rel="noreferrer">`).
- Shared shell means both the Vault and Errors consoles get it for free.
- **Why the rail foot, not a nav item:** a docs entry is not an app route;
  putting it among the `navItems` (Projects, Keys, …) would imply in-app
  navigation and clutter the primary nav. The rail foot is the conventional home
  for a persistent, secondary "docs" affordance.
- **Mobile:** the rail is hidden on mobile; mobile users rely on the contextual
  empty-state links below. Acceptable — do not also stuff it into the mobile nav
  strip (that strip is for routes).

### E. Console empty states — contextual deep links

Add a second sentence with an inline external link to the specific empty states
where a user is stuck and would want the matching guide. Use inline text links
(the muted-foreground paragraph already there gets a follow-on sentence), not
buttons — these are secondary, informational, external.

- **ProjectsPage** (`No projects yet…`) →
  `https://docs.zeroapps.dev/vault/getting-started/`. Copy: append
  `New to ZeroVault? Read the getting-started guide.` with "getting-started guide"
  as the link.
- **KeysPage**, two spots →
  `https://docs.zeroapps.dev/vault/loading-secrets/`:
  - Empty state (`No API keys yet.`): append `Keys authorize the CLI and your
    apps — see loading secrets.`
  - The post-create success banner (`New API key created…`): add a line
    `Use it from the CLI or your app — see loading secrets.` This is the highest-
    intent moment (the user now holds a key and needs the next step).
- **IssuesPage** (`No issues yet.`) →
  `https://docs.zeroapps.dev/errors/getting-started/`. Copy: append `Send your
  first error report — see the getting-started guide.` This is ZeroErrors'
  activation moment (empty because nothing has reported yet).

Link text is the sharp noun ("getting-started guide", "loading secrets"), never
"click here" or a bare "Documentation".

### F. CLI — docs pointers in help and the no-key error

`packages/zerovault-cli/src/index.ts`:

- Add a help epilogue so `zv --help` ends with a docs pointer:
  `program.addHelpText("after", "\nDocs: https://docs.zeroapps.dev/vault/cli/")`.
  - **Target:** `https://docs.zeroapps.dev/vault/cli/` (the CLI reference).
- Extend the no-API-key error to say *how to get* a key, not only how to pass one:
  append `See https://docs.zeroapps.dev/vault/getting-started/ to create one.`
  - **Target:** `https://docs.zeroapps.dev/vault/getting-started/`.

Minimal, high-signal: one URL in help, one in the failure a first-time user hits.

---

## Surfaces to SKIP (and why)

- **Agent (`apps/agent-api`), all of it.** The docs site covers ZeroVault and
  ZeroErrors (developer products); the agent is a separate product for a
  non-developer audience. A Vault/Errors docs link in the `Zero` identity topic or
  the `Changelog` topic would be off-target. No fit — the task explicitly said not
  to force this one.
- **SecretsPage empty state (`No secrets yet.`).** The user is already deep in the
  flow (inside a project/environment, with the add-secret form right above the
  empty message). A docs link here is redundant; adding one over-links the app.
- **EnvironmentsPage.** Projects seed `development` + `production`, so it is
  effectively never empty; no stuck moment to catch.
- **First-run org gate in `AppLayout` (`!organization`).** Rare edge case, and the
  getting-started guide states orgs are auto-created on sign-up, which would
  contradict a "create your org" gate. Linking here would confuse more than help.
- **Landing hero / closing CTAs.** Leave the single `Create an API key ↗` CTA in
  each; a second competing link would dilute the primary action and add clutter.
  Docs is reachable from header + footer.
- **A "Docs" item inside the console primary nav (`navItems`).** Docs is not an app
  route; it belongs at the rail foot (change D), not among Projects/Keys.

---

## Lighthouse preservation argument (landing changes A, B, C)

Constraints to hold: zero client JS, SEO 100, mobile perf 100, CLS 0, a11y ≥ 94.

- **Zero client JS:** every change adds only static `<a href>` anchors in
  `index.astro`. No `<script>`, no client directive, no hydration. Astro ships the
  same zero-JS output.
- **CLS 0:** all links are server-rendered into the static HTML at build time and
  present on first paint; nothing is injected or lazily loaded after load, so there
  is no post-load layout shift. The header keeps its fixed `min-height: 5.5rem`;
  nav/footer are flex with an existing `gap`, absorbing one extra item with no
  reflow of surrounding blocks. CLS stays 0.
- **Mobile perf 100:** no new images, fonts, CSS files, or scripts. Changes A/B
  reuse existing `.header-link` / `.footer-link` rules (no new CSS); C reuses the
  existing `.product-body a` rule. Net payload is a few hundred bytes of inlined
  HTML — no effect on LCP, TBT (no JS), or total bytes at the threshold that moves
  the score.
- **SEO 100:** added links have descriptive, crawlable anchor text ("Docs",
  "Setup guide") with the `↗` glyph `aria-hidden`, so link purpose is
  machine-readable. No change to `<title>`, meta description, canonical, robots, or
  JSON-LD. Descriptive outbound links do not lower the audited page's SEO score.
  (The docs targets themselves are indexable — no `noindex`, robots allows `/`.)
- **a11y ≥ 94:** each new link has discernible text (not icon-only); the `↗` is
  `aria-hidden`. Colors are unchanged from the existing header/footer links
  (`--paper` on `--ink`) and product-body links, which already pass. No new
  interactive patterns, focus traps, or ARIA. Keyboard order is natural DOM order.

If change C ever reads visually busy against the minimal brand, drop C; A + B + the
console/CLI changes still fully satisfy the goal.

---

## Changelog routing (per AGENTS.md)

- **Landing + console changes (A–E)** are console/product changes → one entry in
  the **root `CHANGELOG.md`**, e.g.
  `- 2026-07-28: The landing site, dashboard, and CLI now link to docs.zeroapps.dev — the landing header/footer, contextual "getting started" pointers on empty project/key/issue screens, and a docs link in \`zv --help\` and its no-API-key error.`
- **CLI change (F)** is part of the same console/product surface (the CLI is a
  ZeroVault surface, root changelog), so fold it into the same root entry (as
  above) rather than a second file.
- **Agent (`apps/agent-api/CHANGELOG.md`):** no entry — no agent change is made.

Only the root `CHANGELOG.md` is touched. Zero cross-file split needed because
nothing here changes the agent product.

### Skills-repo sync check (`juanibiapina/zero-skills`)

Change F touches CLI *help text and an error string*, not a documented command's
name, flags, endpoint, payload schema, or user flow. No behavior a skill promises
changes, so no `zero-skills` update is required. Confirm during implementation
that no skill asserts exact `zv --help` output; if one does, update it in the same
change per the AGENTS.md skills rule.

---

## Skills to use (implementation)

- **impeccable** — UI judgment for the empty-state copy, the rail-foot docs link,
  and keeping the landing product cards uncluttered (change C is the clutter-risk
  call).
- **changelog** — when writing the root `CHANGELOG.md` entry.
- **git-commit** — commit code + changelog together (AGENTS.md: changelog ships
  with the change, never as a follow-up).

## Acceptance criteria (objectively checkable)

1. **All link targets return 200** (re-verify at implementation time):
   `https://docs.zeroapps.dev/`, `/vault/getting-started/`, `/vault/cli/`,
   `/vault/loading-secrets/`, `/errors/getting-started/`.
2. **Landing:** header and footer each render a `Docs ↗` link to
   `https://docs.zeroapps.dev/`; if C is kept, each product card links to its
   product getting-started. The built `apps/landing/dist` HTML contains no
   `<script>` (grep), preserving zero client JS.
3. **Landing scores unchanged:** Lighthouse (mobile) on the built landing site
   still reports SEO 100, Performance 100, CLS 0, a11y ≥ 94. (Run in CI /
   `workerd`-capable env per AGENTS.md; this box cannot run `workerd`.)
4. **Console:** the shared left rail shows a `Docs ↗` external link; the
   Projects, Keys (empty + success banner), and Issues empty states each show the
   contextual deep link to the URL specified above. `pnpm -F @zero/dashboard-web`
   (and `@zero/ui`) lint + typecheck + tests pass.
5. **CLI:** `zv --help` output ends with `Docs: https://docs.zeroapps.dev/vault/cli/`;
   the no-API-key error includes `https://docs.zeroapps.dev/vault/getting-started/`.
   `pnpm -F zerovault-cli` tests pass.
6. **Changelog:** one new dated bullet at the top of the root `CHANGELOG.md`;
   `apps/agent-api/CHANGELOG.md` untouched.
7. **No agent change** is present in the diff.
