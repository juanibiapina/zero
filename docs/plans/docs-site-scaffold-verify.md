# Verification: docs site scaffold (`apps/docs`, `zero-docs`, `docs.zeroapps.dev`)

Reviewer stance: adversarial. Trust nothing asserted; every load-bearing claim
below was re-proven against this repo's source, this repo's installed wrangler,
and a fresh throwaway Astro+Starlight build on the exact pinned versions
(`/tmp/docs-verify`, since the plan's `/tmp/docs-poc` no longer exists).

## Verdict

**No blockers.** The plan is buildable as written and its repo-integration and
production-risk claims hold. Two **concerns** (SEO/noindex for placeholder
content, and an implicit lockfile-commit step that will hard-fail CI if missed)
and a few nits. Fix the two concerns before shipping.

Every load-bearing research claim was independently reproduced (see Evidence).

---

## Findings

### Concern 1 — Publishing thin placeholder pages to a public domain with index+sitemap is a real SEO cost

The plan ships four placeholder pages, sets `site`, emits a sitemap that lists
all of them, ships `robots.txt` with `Allow: /`, and (non-blocking) *recommends
submitting the sitemap* to Search Console. That is the wrong posture for v1
placeholder copy.

Evidence (reproduced build):

```
dist/sitemap-0.xml locs:
  https://docs.zeroapps.dev/
  https://docs.zeroapps.dev/errors/overview/
  https://docs.zeroapps.dev/skills/overview/
  https://docs.zeroapps.dev/vault/overview/
```

Thin, near-empty pages ("Full guides are coming soon") getting indexed hurts the
domain: Google can index them, they add low-quality URLs under `zeroapps.dev`,
and de-indexing later is slow. The `.md` twins are **not** in the sitemap
(verified: `0` `.md` entries), so the twin concern is limited to the HTML pages.

**Fix (v1):** make the whole site `noindex` until real content lands, using
Starlight's global `head` config (crawlable but not indexable — do **not**
`Disallow` in robots.txt, or Google can't crawl to see the noindex):

```js
starlight({
  head: [{ tag: "meta", attrs: { name: "robots", content: "noindex, nofollow" } }],
  // ...
})
```

Keep `robots.txt` `Allow: /` and keep the sitemap file, but **do not submit the
sitemap** to Search Console until the placeholder copy is replaced. Remove the
`noindex` head entry in the same change that lands real content. Recommend
adding "site is noindex until real content ships" to the plan's acceptance
criteria (criterion: `curl -s /vault/overview/ | grep 'noindex'`).

### Concern 2 — Lockfile commit is implicit; CI runs `--frozen-lockfile` and will hard-fail without it

The plan (step 8) says "Run `pnpm install` at the repo root to resolve the new
package and update the lockfile" but never says to **commit** the updated
`pnpm-lock.yaml`. CI installs with `pnpm install --frozen-lockfile`
(`.github/workflows/ci.yml`, both jobs). If the new `@zero/docs` deps aren't in
the committed lockfile, both CI jobs fail at install before any lint/build.

**Fix:** make "commit the updated `pnpm-lock.yaml` in the same change" an
explicit step. Note `pnpm install` also patches `wrangler@4.103.0` (the repo has
`patchedDependencies`); docs pins that exact version, so the patch applies
cleanly — confirmed the pin matches.

### Nit 1 — Benign build log line will look like a failure

The reproduced build prints:

```
/404.htmlEntry docs → 404 was not found.
```

The build still **completes** and `dist/404.html` (a themed ~9.9 KB page) is
produced. This is a known harmless Starlight/Astro log about the 404 route
entry, not an error. Call it out in the plan so the implementer doesn't chase
it.

### Nit 2 — `Ignored build scripts: esbuild` on install — already handled

Fresh install warns esbuild's build script is ignored. In this repo
`pnpm-workspace.yaml` `onlyBuiltDependencies` already lists `esbuild`, so it is
approved repo-wide and the docs build works regardless. No action; noting so it
isn't mistaken for a new problem.

### Nit 3 — Changelog date

Plan uses `2026-07-27`; adjust to the real implementation date (plan already
says to). Routing to root `CHANGELOG.md` is correct per `AGENTS.md` (console
product surface, not the agent).

---

## Answers to the six verification questions

### 1. Monorepo wiring — matches conventions, `pnpm install` and turbo will work

Compared line-by-line against `apps/landing`:

- **package.json**: script names (`dev`/`dev:worker`/`build`/`lint`/`typecheck`/
  `deploy`) match landing exactly, so turbo's generic tasks pick them up. Same
  devDeps stack (`@astrojs/check`, `astro-eslint-parser`, `eslint 10.7.0`,
  `eslint-plugin-astro`, `eslint-plugin-jsx-a11y`, `typescript 6.0.3`,
  `wrangler 4.103.0`, `@zero/eslint-config`, `@zero/typescript-config`). Correct
  divergence: no Tailwind (landing has it; docs shouldn't). The three Starlight
  packages as runtime `dependencies` is right (they're Astro integrations).
- **tsconfig / eslint.config.js / .gitignore / env.d.ts**: byte-identical to
  landing's, which is correct for an Astro app. There is **no root
  `eslint.config.*`** and no project-reference wiring — each package owns its
  flat config and imports the shared `@zero/eslint-config`. So copying landing's
  is exactly right; nothing at the root needs editing.
- **pnpm resolve**: `pnpm-workspace.yaml` globs `apps/*` (no edit needed). No
  `.npmrc`, no `overrides`/`resolutions`, and pnpm's default
  `strict-peer-dependencies` is `false`. Reproduced: `pnpm install` **succeeds**
  with only a peer *warning* (see Q5).
- **turbo**: `build` has global `outputs: ["dist/**"]`; docs builds to `dist`,
  so caching is correct with no per-package edit. `lint`/`typecheck` are generic.
  The special-cased tasks (`@zero/agent-api#deploy`,
  `@zero/dashboard-api#deploy/#test`) exist because those have cross-package web
  builds; docs has none, so it needs no special case. Plan's "no turbo edit"
  claim is correct.

### 2. bin/ci and the deploy dry-run — safe, mirrors landing

`bin/ci` runs `pnpm run deploy -- --dry-run` = `turbo run deploy -- --dry-run`.
Turbo forwards `--dry-run` to **every** package's `deploy` script. Today three
workers have a `deploy` script (agent-api, landing, vault-api), each
`wrangler deploy`; landing already runs `wrangler deploy --dry-run` here and in
CI. Adding docs adds one more `wrangler deploy --dry-run` for `zero-docs`,
gated behind `build` (turbo `deploy dependsOn build`), so `dist/` exists first.

`wrangler deploy --dry-run` bundles/validates locally and does **not** hit the
Cloudflare API, create the worker, or provision the `custom_domain` route. So it
needs no `CLOUDFLARE_API_TOKEN` and cannot touch DNS or existing workers. In
GitHub Actions the `build` job runs `bin/fetch-secrets` then the dry-run; docs
has no secrets, so nothing new is required. On the NixOS dev box the dry-run
does not start `workerd` (no `wrangler dev`), so it runs. **Adding docs does not
break the dry-run locally or in CI.**

### 3. First-deploy ordering — no chicken-and-egg; existing surfaces untouched

There is no chicken-and-egg: `wrangler deploy` in a single shot uploads the
worker **and** provisions the `custom_domain` route + its proxied DNS record. So
the connector's first build both creates `zero-docs` and provisions
`docs.zeroapps.dev`. You do **not** pre-create the worker.

Correct order of operations (mirrors how `zero-landing` was attached 2026-07-26):

1. **Land the `apps/docs` code on `main` first** (package.json, astro.config,
   content.config, content, wrangler.jsonc, robots.txt, lockfile). CI's
   dry-run for `zero-docs` runs safely even though the worker doesn't exist yet
   (dry-run makes no API call). If you attach the connector before the code
   exists, its first build runs `pnpm -F @zero/docs run build` against a missing
   package and fails — so code must be on `main` first.
2. **Attach the Workers Builds connector** for `zero-docs` on
   `juanibiapina/zero`, branch `main`, root `/`: build `pnpm -F @zero/docs run
   build`, deploy `pnpm -F @zero/docs run deploy`, **no build variables** (never
   `VITE_CLERK_PUBLISHABLE_KEY`), no secrets.
3. **First build/deploy** (attaching triggers one, or push a trivial commit).
   That single `wrangler deploy` creates the `zero-docs` worker and provisions
   the `docs.zeroapps.dev` custom domain + proxied DNS record.

Alternative if you want to decouple from the dashboard step: run
`pnpm -F @zero/docs run deploy` once manually (scoped, from a box with
`CLOUDFLARE_API_TOKEN`) to create the worker + domain, then attach the connector
for future auto-deploys. Do **not** use `bin/deploy` for this — it runs the
unscoped `pnpm run deploy` across all workers.

Cannot disturb existing surfaces:
- `zero-landing` is a **separate worker**; deploying `zero-docs` never touches
  its script or its `zeroapps.dev` route.
- The **apex `zeroapps.dev`** custom domain lives on `zero-landing`; provisioning
  `docs.zeroapps.dev` creates a **new** DNS record for the `docs` host only.
  Per `docs/workers-ops.md`, custom_domain add/remove affects only that host;
  other hosts on the zone are unaffected.
- The **Search Console TXT** record is a separate DNS entry on the zone;
  custom_domain provisioning only creates/updates the `docs` proxied record and
  does not read or modify the TXT record.

### 4. The `.md` twin claim — CONFIRMED (both halves), and 404-page does not interfere

Reproduced build (`/tmp/docs-verify`, `site: https://docs.zeroapps.dev`):

- **Bare `<page>.md` twins**, siblings of the page dir, confirmed:
  `dist/vault/overview.md` exists; `dist/vault/overview/index.md` does **not**.
  Home twin is `dist/index.md`. Content is clean raw markdown with the title as a
  top-level `#` heading:
  ```
  # ZeroVault Overview

  ZeroVault stores secrets for your applications.
  ```
- **`text/markdown` on the asset-only worker**, confirmed at the source of truth:
  the repo's installed patched `wrangler@4.103.0` bundles
  `"text/markdown": ["md", "markdown"]` in its mime table
  (`node_modules/.pnpm/wrangler@4.103.0_patch_hash=.../wrangler-dist/cli.js`). So
  `/vault/overview.md` serves as `text/markdown` with no runtime worker.
- **HTML carries the control**: `dist/vault/overview/index.html` contains
  `Copy Markdown` and `href="/vault/overview.md"` (both grepped from the built
  HTML). Acceptance criteria using the `<page>.md` form are correct.
- **`not_found_handling: "404-page"` interaction — safe.** The `.md` twins and
  the `llms*.txt` files are **real files in `dist`**, so Workers Assets serves
  them by exact asset match; `not_found_handling` only fires for paths with **no**
  matching asset. So `/vault/overview.md`, `/llms.txt`, `/llms-full.txt`,
  `/llms-small.txt` all serve their assets first; only genuinely-unknown paths
  fall through to the themed `dist/404.html` (present, ~9.9 KB, contains "404").

### 5. Peer/version risk — cosmetic, and cannot fail install here

Reproduced: on `pnpm install`, pnpm prints exactly one peer warning —

```
starlight-page-actions 0.7.0
└─┬ vite-plugin-virtual 0.5.0
   └── ✕ unmet peer vite@"...^7.0.0": found 8.1.5
```

Install **completes successfully** and `vite@8.1.5` is used. The build is **not**
a silent no-op: the log shows `[vite-plugin-static-copy] Copied 4 items.` and the
four `.md` twins are physically present in `dist`. So vite 8 emits the twins.
Nothing in the repo escalates the warning to an error: **no `.npmrc`**, pnpm's
default `strict-peer-dependencies` is `false`, and there are **no
`overrides`/`resolutions`** in the root `package.json`. CI's
`--frozen-lockfile` does not change peer strictness. So the warning stays
cosmetic. The plan's mitigation (an acceptance test that fetches a real `.md`
twin in production) is the right guard against a future regression; do not pin
vite to silence it.

### 6. Content plan sanity — hold indexing back, don't hold the deploy

Deploying the scaffold is fine; **publishing it to search is not** while the copy
is placeholder. See Concern 1. Recommendation for v1: ship the site, add a global
`noindex, nofollow` via Starlight `head`, keep `robots.txt` `Allow: /` (so
crawlers can reach the pages and see the noindex), and **do not submit the
sitemap** to Search Console until real content lands. Flip off `noindex` and
submit the sitemap in the same change that replaces the placeholders.

---

## Evidence log (independently reproduced)

- Fresh install on pinned versions (`@astrojs/starlight@0.41.4`,
  `starlight-llms-txt@0.11.0`, `starlight-page-actions@0.7.0`, `astro@7.1.3`):
  succeeds with one cosmetic vite peer warning; `vite@8.1.5` resolved.
- `astro build`: completes; `dist` contains `index.md`, `vault/overview.md`,
  `errors/overview.md`, `skills/overview.md` (bare `.md` siblings — no
  `.../index.md`), `404.html` (~9.9 KB, themed), `llms.txt` / `llms-full.txt` /
  `llms-small.txt`, `sitemap-index.xml` + `sitemap-0.xml`.
- `llms.txt` uses absolute `https://docs.zeroapps.dev/...` links (driven by
  `site`).
- Sitemap lists the four HTML pages; **no** `.md` twins in the sitemap.
- `dist/vault/overview/index.html` contains `Copy Markdown` and
  `href="/vault/overview.md"`.
- No `dist/robots.txt` from the build (plan correctly adds one).
- wrangler `4.103.0` mime table maps `md`/`markdown` → `text/markdown`.
- Repo config: no `.npmrc`, no root `eslint.config.*`, no overrides/resolutions;
  `pnpm-workspace.yaml` globs `apps/*`; `patchedDependencies` pins
  `wrangler@4.103.0`; turbo `build` outputs `dist/**`.
- `.github/workflows/ci.yml`: installs `--frozen-lockfile`; `build` job runs
  `pnpm run deploy -- --dry-run` after `bin/fetch-secrets`.
