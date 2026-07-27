# Plan: docs site scaffold (`apps/docs`, `docs.zeroapps.dev`)

Status: plan only. No code changed. The approach is already approved (see
`docs/plans/docs-platform.md`); this is the implementation plan. Do not
re-litigate subdomain-vs-path, package choice, or skipping `Accept:
text/markdown` — those are settled.

## Goal

Ship a public product-docs site for ZeroVault and ZeroErrors at
`docs.zeroapps.dev`:

- New `apps/docs` (`@zero/docs`) Astro + Starlight app.
- Asset-only Cloudflare Worker `zero-docs`, `custom_domain` route
  `docs.zeroapps.dev`, real 404 page.
- Agent-friendly output: per-page raw-markdown twins with a Copy Markdown button,
  plus `/llms.txt`, `/llms-full.txt`, `/llms-small.txt`.
- Its own Workers Builds connector with a **package-scoped** build and deploy
  (never the whole-repo build).
- Placeholder content: index page + nav sections for ZeroVault, ZeroErrors, and
  Skills.
- SEO from day one: sitemap, robots.txt, canonical URLs.
- Leave a seam for later auto-generating Skills pages from a top-level `skills/`
  dir. Do not build that generator now.

Landing (`apps/landing` / `zero-landing`) and its SEO must be 100% unaffected.

## Research findings (verified, not assumed)

All of the following was proven in a throwaway project in `/tmp/docs-poc` on the
exact pinned versions, and against this repo's wrangler build. Reproduce with the
same steps if in doubt.

### Packages resolve and build together on Astro 7.1.3

Installed and built clean:
`@astrojs/starlight@0.41.4`, `starlight-page-actions@0.7.0`,
`starlight-llms-txt@0.11.0`, `astro@7.1.3`, `@astrojs/check@0.9.9`,
`typescript@6.0.3`. `astro build` succeeds and `astro check` reports 0
errors/0 warnings/0 hints.

`@astrojs/sitemap@3.7.3` ships as a dependency **inside** `@astrojs/starlight` and
Starlight auto-configures it whenever `site` is set. No need to add it or list it
in `astro.config` integrations. It emits `sitemap-index.xml` + `sitemap-0.xml`.

### Proven `dist` layout (this is the load-bearing finding)

From the poc build (`site: "https://docs.zeroapps.dev"`, pages `index.mdx`,
`vault/overview.md`, `errors/overview.md`):

```
dist/index.html
dist/index.md                      <- home twin
dist/vault/overview/index.html
dist/vault/overview.md             <- page twin (bare .md, sibling of the dir)
dist/errors/overview/index.html
dist/errors/overview.md
dist/404.html                      <- Starlight ships this automatically
dist/llms.txt                      <- curated index -> links to the two below
dist/llms-full.txt
dist/llms-small.txt
dist/sitemap-index.xml
dist/sitemap-0.xml
dist/_astro/*                      <- hashed CSS/JS (Starlight ships JS; fine)
dist/pagefind/*                    <- client search index (wasm + fragments)
```

**`.md` twin URL shape:** `starlight-page-actions` emits a **bare
`<page-path>.md`** next to the page directory, i.e. the HTML page
`/vault/overview/` has its markdown twin at **`/vault/overview.md`**, and the
home page twin is **`/index.md`**. This is NOT Cloudflare's
`.../<page>/index.md` convention. The in-page Copy Markdown control links to
`href="/vault/overview.md"`. Acceptance criteria and any docs must use the
`<page>.md` form, not `<page>/index.md`.

The twin content is clean raw markdown: frontmatter stripped, the page title
rendered as a top-level `#` heading, then the body. Example
`dist/vault/overview.md`:

```
# ZeroVault Overview

ZeroVault stores secrets for your Workers.
```

The rendered HTML carries the page-actions UI (verified by grepping the built
HTML): a **Copy Markdown** button (`copy-markdown`) and an **Open in
ChatGPT / Claude / View in Markdown** dropdown.

`llms.txt` is a curated index that links to `llms-full.txt` and
`llms-small.txt` using absolute URLs built from `site`
(`https://docs.zeroapps.dev/llms-full.txt`).

### `.md` twins serve as `text/markdown` on the asset-only worker

Cloudflare Workers Assets infers Content-Type from extension using wrangler's
bundled mime table. That table (in
`node_modules/.pnpm/wrangler@4.103.0*/node_modules/wrangler/wrangler-dist/cli.js`)
maps `"text/markdown": ["md", "markdown"]`. So `/vault/overview.md` is served
with `Content-Type: text/markdown` by the asset-only worker, no runtime worker
and no header override needed. (Consistent with Cloudflare's own docs site
serving its `.md` twins as `text/markdown`.)

### 404 handling for a Starlight static build

Starlight ships a real `dist/404.html` (a full themed "Page not found" page,
~10 KB) automatically — no custom 404 needed, unlike landing which hand-writes
one. Set `assets.not_found_handling: "404-page"` in `wrangler.jsonc` (same as
landing) so Workers Assets serves that `404.html` with a 404 status on unknown
paths. Confirmed the file exists in the poc build.

### DNS / route mechanics for `docs.zeroapps.dev`

The zone `zeroapps.dev` already exists (zone id
`c02ad38b8272d974f23778c93c594703`) and carries a Google Search Console
verification TXT record that must not be touched.

Per `docs/workers-ops.md`: a `custom_domain: true` route provisions a Worker
custom domain **and its proxied DNS record automatically on deploy**, and
removing it tears both down (evidence: the `retire-zerovault-domain` task; the
apex `zeroapps.dev` is the live example on `zero-landing`). So the only DNS work
for `docs.zeroapps.dev` is adding `routes: [{ pattern: "docs.zeroapps.dev",
custom_domain: true }]` to `wrangler.jsonc` and deploying. Cloudflare creates the
proxied record for the `docs` host. This does not touch the apex `zeroapps.dev`
record or the Search Console TXT record (they are separate DNS entries on the
same zone).

### Google Search Console coverage

The existing property is a **Domain property** (`sc-domain:zeroapps.dev`). A
Google Domain property covers **all subdomains** (`docs.`, `www.`, `m.`, …) and
both `http`/`https` — this is Google's documented behavior for Domain
properties. So `docs.zeroapps.dev` is already inside the property; no new
property or verification step is required. Recommended follow-up (not blocking):
submit `https://docs.zeroapps.dev/sitemap-index.xml` under the same property so
Google discovers docs pages faster. No agent action needed on Search Console to
ship.

### Tailwind decision: do NOT add Tailwind

Starlight ships its own complete theme and CSS. The poc built and looked correct
with zero Tailwind. Landing uses Tailwind because it is a bespoke marketing
page; docs is a themed Starlight site and does not need it. Omit
`tailwindcss` and `@tailwindcss/vite` from `apps/docs`. If a one-off style
tweak is ever needed, use Starlight's `customCss` option with a plain CSS file,
not Tailwind.

### Dev port

`AGENTS.md` port table currently lists web (Vite) ports 5176 (agent), 5178
(dashboard), 5180 (landing) and worker ports 8790 / 8792 / 8794. Next free,
following the pattern: **docs web 5182, docs worker 8796**. Inspector: n/a
(asset-only, like landing). Add a `docs` row to the table.

## Risks found

1. **Peer-dep warning `vite-plugin-virtual` wants vite ≤7, Astro 7.1.3 ships
   vite 8.** A transitive dep of `starlight-page-actions` prints
   `unmet peer vite@"...^7.0.0": found 8.1.5` on install. It is **cosmetic
   today** — build, `.md` twin emission, and `astro check` all succeed on vite
   8. Risk is a future starlight-page-actions/vite bump breaking the twin
   emission. Mitigation: the acceptance criteria fetch a real `.md` twin in
   production, so a regression is caught. Do not try to pin vite to silence the
   warning (fights Astro's bundled vite).

2. **`.assetsignore` / `*.md` trap.** Cloudflare's own static-assets guidance
   suggests excluding `*.md` from asset uploads to save time. We depend on the
   opposite — the `.md` twins MUST ship. Do **not** add an `.assetsignore` (or if
   one is ever added, never list `*.md`). Astro does not create one by default,
   so the default is safe; this is a "don't regress it" note.

3. **Docs ships client JS (Starlight + Pagefind).** Unlike the deliberately
   zero-JS landing page, Starlight bundles JS and a Pagefind search index
   (`dist/_astro/*`, `dist/pagefind/*`). This is expected and fine for a docs
   site; do not try to strip it. Keep the two apps' "zero-JS" expectations
   separate — the landing zero-JS invariant does not apply to docs.

4. **Whole-repo build breaks docs, same bite as landing.** `pnpm run build`
   fails because `@zero/dashboard-web` needs `VITE_CLERK_PUBLISHABLE_KEY`. The
   docs connector build/deploy MUST be package-scoped
   (`pnpm -F @zero/docs ...`), exactly like `zero-landing`. This is called out
   again in the connector section so it is not lost.

## Ordered implementation steps

Paths are repo-relative. Pin the exact versions proven above.

### 1. `apps/docs/package.json`

```json
{
  "name": "@zero/docs",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev --port 5182",
    "dev:worker": "wrangler dev --port 8796",
    "build": "astro build",
    "lint": "eslint .",
    "typecheck": "astro check",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@astrojs/starlight": "0.41.4",
    "starlight-llms-txt": "0.11.0",
    "starlight-page-actions": "0.7.0"
  },
  "devDependencies": {
    "@astrojs/check": "^0.9.9",
    "@zero/eslint-config": "workspace:*",
    "@zero/typescript-config": "workspace:*",
    "astro": "^7.1.3",
    "astro-eslint-parser": "^3.0.0",
    "eslint": "10.7.0",
    "eslint-plugin-astro": "^3.0.1",
    "eslint-plugin-jsx-a11y": "^6.10.2",
    "typescript": "6.0.3",
    "wrangler": "4.103.0"
  }
}
```

Notes: script names (`build`/`deploy`/`dev`/`lint`/`typecheck`) match landing
so the turbo pipeline and the connector find them. No Tailwind. The three docs
packages are runtime `dependencies` (Astro integrations), not devDependencies.
Keep `wrangler` pinned to `4.103.0` to match the repo's patched wrangler.

### 2. `apps/docs/astro.config.mjs`

```js
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightPageActions from "starlight-page-actions";

export default defineConfig({
  site: "https://docs.zeroapps.dev",
  server: { port: 5182 },
  integrations: [
    starlight({
      title: "Zero Docs",
      plugins: [starlightLlmsTxt(), starlightPageActions()],
      sidebar: [
        {
          label: "ZeroVault",
          items: [{ label: "Overview", slug: "vault/overview" }],
        },
        {
          label: "ZeroErrors",
          items: [{ label: "Overview", slug: "errors/overview" }],
        },
        {
          label: "Skills",
          items: [{ label: "Overview", slug: "skills/overview" }],
        },
      ],
    }),
  ],
});
```

`site` must be `https://docs.zeroapps.dev` — it drives canonical URLs, the
sitemap `loc`s, and the absolute links inside `llms.txt`. Do not add
`@astrojs/sitemap` to `integrations`; Starlight configures it internally when
`site` is set.

### 3. `apps/docs/src/content.config.ts`

Required by Starlight 0.41 (the build fails without it — proven in the poc: the
docs collection is "empty" and the sidebar slug lookup throws).

```ts
import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
```

### 4. Placeholder content under `apps/docs/src/content/docs/`

Every sidebar `slug` must resolve to a file or the build fails. Ship:

- `index.mdx` — landing/home page:

  ```mdx
  ---
  title: Zero Docs
  description: Documentation for ZeroVault and ZeroErrors.
  template: splash
  ---

  Documentation for ZeroVault (secrets for your Workers) and ZeroErrors (error
  tracking for your apps). Use the navigation to get started.
  ```

- `vault/overview.md`:

  ```md
  ---
  title: ZeroVault Overview
  description: What ZeroVault is and what it does.
  ---

  ZeroVault stores secrets for your applications and serves them to your
  Workers at deploy and runtime. Full guides are coming soon.
  ```

- `errors/overview.md`:

  ```md
  ---
  title: ZeroErrors Overview
  description: What ZeroErrors is and what it does.
  ---

  ZeroErrors collects and surfaces errors reported by your applications. Full
  guides are coming soon.
  ```

- `skills/overview.md` (this page is the seam for future auto-generation):

  ```md
  ---
  title: Skills
  description: Installable agent skills for ZeroVault and ZeroErrors.
  ---

  Installable agent skills for ZeroVault and ZeroErrors will be listed here.
  This section will later be generated from the repository's top-level
  `skills/` directory.
  ```

Content is deliberately thin placeholder copy written for users (no internal
module names, per `AGENTS.md`). Seeding richer content from `docs/secrets.md`
etc. is a later task, out of scope for the scaffold.

**Skills seam (leave, do not build):** the top-level `skills/` dir does not
exist yet. Do not create it and do not build a generator. The
`skills/overview.md` page and the "Skills" sidebar section are the placeholder
seam; a later task will point a build-time generator at `skills/` and emit one
page per skill here.

### 5. `apps/docs/public/robots.txt`

Starlight does NOT emit robots.txt (verified: none in the poc `dist`). Add one.
Note the sitemap file is `sitemap-index.xml`, not `sitemap.xml`:

```
User-agent: *
Allow: /

Sitemap: https://docs.zeroapps.dev/sitemap-index.xml
```

### 6. `apps/docs/wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "zero-docs",
  "compatibility_date": "2026-06-24",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "404-page"
  },
  "routes": [{ "pattern": "docs.zeroapps.dev", "custom_domain": true }]
}
```

Mirrors landing exactly except `name` and the route host. `not_found_handling:
"404-page"` serves Starlight's `dist/404.html`. The `custom_domain` route
provisions the `docs.zeroapps.dev` DNS record on first deploy.

### 7. `apps/docs/eslint.config.js`, `tsconfig.json`, `.gitignore`, `src/env.d.ts`

Copy landing's verbatim (they are already correct for an Astro app; the eslint
config must ignore `.astro`):

- `eslint.config.js`:
  ```js
  import base from "@zero/eslint-config";
  import astro from "eslint-plugin-astro";

  export default [{ ignores: [".astro"] }, ...base, ...astro.configs.recommended];
  ```
- `tsconfig.json`:
  ```json
  { "extends": "astro/tsconfigs/strict", "include": [".astro/types.d.ts", "**/*"], "exclude": ["dist"] }
  ```
- `.gitignore`:
  ```
  # generated by astro
  .astro/
  ```
- `src/env.d.ts`:
  ```ts
  /// <reference types="astro/client" />
  ```

No stray sourcemaps: Astro static build emits none by default; do not enable
them. `dist/` is git-ignored transitively via the repo root ignore (confirm it
is not tracked after build).

### 8. Wire into the workspace / turbo

- `pnpm-workspace.yaml` already globs `apps/*`, so `@zero/docs` is picked up with
  no edit.
- Run `pnpm install` at the repo root to resolve the new package and update the
  lockfile.
- Turbo needs no per-task edit: `build`, `lint`, `typecheck`, `dev`, `deploy`
  are generic tasks in `turbo.json` keyed by script name, and the docs scripts
  use those names. No `@zero/docs#...` special-case is needed (docs has no
  cross-package build dependency, unlike the dashboard/agent deploy tasks).

### 9. Update `AGENTS.md` dev-port table

Add a `docs` row and mention `pnpm turbo dev` now also launches docs:

```
| docs | 8796 (Workers Assets) | n/a | 5182 |
```

Also add `5182` and `8796` to the port-kill loop in the "Dev Server" section
(`for p in 5176 5178 5180 5182 8790 8792 8794 8796; ...`).

### 10. Changelog

Per `AGENTS.md` routing: the docs site is a user-facing surface for **ZeroVault
and ZeroErrors** (console products), so the entry goes in the **root
`CHANGELOG.md`**, not `apps/agent-api/CHANGELOG.md`. Load the `changelog` skill
before editing. Add, most recent first:

```
- 2026-07-27: ZeroVault and ZeroErrors now have a documentation site at docs.zeroapps.dev, with a "Copy Markdown" button on every page for pasting into AI assistants.
```

(Adjust the date to the implementation date. Keep it user-facing: no package or
plugin names.)

Commit the changelog entry in the same change as the code.

## Skills to use during implementation

- `cloudflare` — for the `wrangler.jsonc` custom_domain route and asset-only
  worker config, and to sanity-check `not_found_handling`.
- `changelog` — load before editing the root `CHANGELOG.md`.
- `git-commit` — when committing.
- `reproducible-locally` — to drive the acceptance criteria after deploy;
  note the NixOS box cannot run `wrangler dev`/`workerd`, so local verification
  is limited to `astro build` + `astro check`; the HTTPS/`.md`/`/llms.txt`/404
  checks run against production `docs.zeroapps.dev` after the connector deploys.

## Verification before deploy (runnable on this box)

`workerd`/`wrangler dev` cannot run on this NixOS box, but the static build can:

- `pnpm --filter @zero/docs run build` succeeds and `dist/` contains
  `index.md`, `vault/overview.md`, `errors/overview.md`, `skills/overview.md`,
  `404.html`, `llms.txt`, `llms-full.txt`, `llms-small.txt`, `sitemap-index.xml`.
- `pnpm --filter @zero/docs run typecheck` (`astro check`) reports 0 errors.
- `pnpm --filter @zero/docs run lint` passes.
- Grep the built `dist/vault/overview/index.html` for `Copy Markdown` and
  `href="/vault/overview.md"`.
- Confirm landing is untouched: `pnpm --filter @zero/landing run build` still
  produces its `dist` with its own `robots.txt`/`sitemap.xml`/`404.html`, and no
  files under `apps/landing` changed in the diff.

## Cloudflare dashboard: Workers Builds connector for `zero-docs`

Create a new Workers Builds git connector on repo `juanibiapina/zero`, branch
`main`, root dir `/` (same as the other three), for the `zero-docs` Worker:

- **Build command:** `pnpm -F @zero/docs run build`
- **Deploy command:** `pnpm -F @zero/docs run deploy`
- **Build variables:** none. Do NOT set `VITE_CLERK_PUBLISHABLE_KEY`. The
  package-scoped build never touches `@zero/dashboard-web`, so it does not need
  it — and using the whole-repo `pnpm run build` would fail on the missing Clerk
  key, the exact failure that bit the landing connector.
- **Secrets:** none (asset-only worker, no runtime secrets).

This mirrors the `zero-landing` connector (attached 2026-07-26). After the
connector is attached and `main` has the `apps/docs` code, the first push
deploys `zero-docs` and provisions `docs.zeroapps.dev`.

## Acceptance criteria (objectively checkable in production)

After the connector deploys from `main`:

1. `curl -sI https://docs.zeroapps.dev/` returns `200` over HTTPS with
   `content-type: text/html`.
2. `curl -s https://docs.zeroapps.dev/vault/overview.md` returns `200` with
   `content-type: text/markdown` and a body that is raw markdown (starts with
   `# ZeroVault Overview`).
3. `curl -sI https://docs.zeroapps.dev/llms.txt` returns `200`
   (`text/plain`), and `/llms-full.txt` and `/llms-small.txt` also return `200`.
4. The rendered HTML at `/vault/overview/` contains the `Copy Markdown` control
   and a link to `/vault/overview.md` (grep the fetched HTML for `Copy Markdown`
   and `href="/vault/overview.md"`).
5. `curl -sI https://docs.zeroapps.dev/does-not-exist` returns HTTP `404` and
   the body is the themed Starlight 404 page (real 404, not the home page and
   not a soft 200).
6. `curl -s https://docs.zeroapps.dev/sitemap-index.xml` returns `200` and lists
   the docs pages with `https://docs.zeroapps.dev/...` locs; `/robots.txt`
   returns `200` and references the sitemap.
7. The connector deploys unattended on push to `main` (no manual step); the
   build uses `pnpm -F @zero/docs run build` and does not require any Clerk
   build variable.
8. Landing unaffected: `https://zeroapps.dev/` still `200`s, its
   `/robots.txt`, `/sitemap.xml`, and 404 behavior are unchanged, and no
   `apps/landing` file changed in the diff.
```