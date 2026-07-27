# Docs platform for ZeroVault & ZeroErrors (research + recommendation)

Status: research only. No app scaffolded, no code changed. This file is left
untracked; a later stage commits it.

Goal: ship public product documentation for ZeroVault and ZeroErrors with
agent-friendly output ("copy to markdown" per page, predictable raw-markdown
URLs, optional llms.txt).

Everything below was verified by fetching real URLs and by querying this repo's
package registry with `pnpm view`. Versions are what this environment resolves
today.

---

## 1. What Cloudflare actually does (verified)

Cloudflare's developer docs at `https://developers.cloudflare.com` are built
with **Astro + Starlight**, fronted by a **custom Worker** that serves the
AI/markdown endpoints. Sources:

- Repo `github.com/cloudflare/cloudflare-docs` (`production` branch). Its
  `package.json` pins `"astro": "^7.0.2"` and uses `@astrojs/markdown-remark`,
  `remark`, `rehype`. Code is MIT, content is CC-BY-4.0.
- DeepWiki's index of the repo describes Starlight component overrides (`Head`,
  `Header`, `Sidebar`, `PageTitle`) in `astro.config.ts` and a `worker/index.ts`
  that "handles request routing, redirects, and serving specialized AI
  endpoints like llms-full.txt." (`https://deepwiki.com/cloudflare/cloudflare-docs`)
- Their own style guide documents the convention:
  `https://developers.cloudflare.com/style-guide/components/markdown/`

Verified endpoints (HTTP status / content-type / size from `curl`):

| URL | Result |
|---|---|
| `GET /llms.txt` | 200 `text/plain`, ~15 KB. An **index** whose entries link to each product's own `.../llms.txt` (e.g. `/workers/llms.txt`). |
| `GET /llms-full.txt` | 200 `text/markdown`, **~56 MB**. The entire docs corpus as one markdown file. |
| `GET /workers/index.md` | 200 `text/markdown`, ~6 KB. Per-directory markdown twin. |
| `GET /workers/get-started/guide/index.md` | 200 `text/markdown`, ~10 KB. Per-page markdown twin. |
| `GET /workers.md` (bare `.md`) | **404**. The pattern is `.../index.md`, not `page.md`. |
| `GET /workers/get-started/guide/` with `Accept: text/markdown` | 200 `text/markdown`. **Content negotiation** returns the markdown twin for the same URL. |

The rendered HTML page carries **"Copy Page" / "Copy as Markdown" / "View as
Markdown"** controls (confirmed by grepping the page HTML) and points readers at
the product `llms.txt`.

Takeaways that matter for us:
- The real, working conventions are: **per-page `index.md` twins**, an
  **`llms.txt` index**, an **`llms-full.txt` dump**, **`Accept: text/markdown`
  content negotiation**, and **in-page copy/view-as-markdown buttons**.
- The `index.md` twins are plain static files (serveable by an asset-only
  worker). The `Accept: text/markdown` negotiation is the only piece that needs
  a **runtime worker** — Cloudflare does it in `worker/index.ts`.

---

## 2. Starlight + agent-docs packages that really exist (verified with `pnpm view`)

This repo already runs **Astro 7.1.3** (`apps/landing/node_modules/astro` =
`7.1.3`, registry `astro` latest also `7.1.3`). Compatibility below is against
that.

| Package | Version | Astro/Starlight peers | Modified | Fit |
|---|---|---|---|---|
| `@astrojs/starlight` | **0.41.4** | `astro ^7.0.2`, `@astrojs/markdown-remark ^7.2.0` | 2026-07-22 | ✅ Works with our astro 7.1.3. Same major Cloudflare uses. |
| `starlight-llms-txt` | **0.11.0** | `@astrojs/starlight >=0.41.0`, `astro ^7.0.0` | 2026-07-01 | ✅ By **delucis** (Chris Swithinbank, Starlight's core maintainer). Emits `llms.txt`, `llms-full.txt`, `llms-small.txt`. Repo `github.com/delucis/starlight-llms-txt`, docs `delucis.github.io/starlight-llms-txt`. |
| `starlight-page-actions` | **0.7.0** | `@astrojs/starlight >=0.36.0`, `astro >=5.6.0` | 2026-07-13 | ✅ By dlcastillop. Adds a **"Copy Markdown"** button + an **"Open"** dropdown (ChatGPT, Claude, …). Uses `vite-plugin-static-copy` to emit `.md`/`.mdx` twins as static files, so it works on an **asset-only worker**. Docs `starlight-page-actions.dlcastillop.com`. |
| `@wave-rf/starlight-llm-tools` | 0.3.1 | starlight `>=0.36.0`, astro `>=5.0.0`, **`starlight-glossary >=1.0.0`** | 2026-06-09 | ⚠️ Bundles `.md` twins + llms.txt/full/small + copy/open buttons in one plugin, but forces a hard peer on `starlight-glossary`. Heavier and less mainstream than the two above. |
| `starlight-copy-button` | — | — | — | ❌ **Not in registry** (`pnpm view` NOT FOUND). Mentioned in awesome-starlight under a different handle; do not rely on it. |
| `starlight-view-modes` | 0.13.1 | — | — | Unrelated (theme view modes), not agent docs. |

So the maintained, verified building blocks are **`@astrojs/starlight` +
`starlight-llms-txt` + `starlight-page-actions`**. All three resolve in this
repo's registry and are peer-compatible with the installed Astro 7.

---

## 3. The llms.txt convention itself

`llms.txt` is a community proposal from Jeremy Howard / Answer.AI
(`llmstxt.org`): a curated markdown index at the site root that points LLMs at
the pages worth reading, with an optional `llms-full.txt` that inlines
everything.

Honest read of adoption (2026):
- **Google has publicly said it does not use `llms.txt`** for Search or AI
  Overviews (multiple confirmations, e.g. Search Engine Journal 2026-05,
  `llmtxt.info`, `lbntechsolutions.com`). It is **not standardized** and has no
  enforcement.
- No major model provider treats it as a guaranteed discovery mechanism.
  Adoption is inconsistent and provider-controlled.
- Where it actually pays off: **coding agents and doc-aware assistants** that
  are pointed at a docs site, plus humans who paste it into a chat. The real,
  reliable win reported by practitioners is **raw markdown at a predictable
  URL** (the `.md` twins) — that is what agents fetch and what "copy as
  markdown" produces. `llms.txt` is a nice curated index on top.

Conclusion: emit `llms.txt` (+ `llms-full.txt`) because a plugin makes it
free, but do not oversell it. The load-bearing feature is the per-page markdown
twins and the copy button.

---

## 4. Recommendation for this repo

### 4.1 Where docs live — new `apps/docs` Starlight app on a subdomain

**Recommend: a new `apps/docs` (`@zero/docs`) Starlight app, its own asset-only
worker `zero-docs`, on `docs.zeroapps.dev`, with its own Workers Builds
connector.** This mirrors Cloudflare's own stack (Astro + Starlight) and keeps
concerns clean.

Options considered:

- **A. Separate `apps/docs` Starlight app, subdomain `docs.zeroapps.dev`
  (recommended).**
  - Pros: Starlight is a full Astro integration that owns its own theme,
    sidebar, and routing — it wants to *be* the site, which fits a dedicated
    app. Copy-markdown and llms.txt scope cleanly. Independent build/deploy;
    docs changes don't redeploy the landing worker. Same asset-only worker
    pattern as `apps/landing`, so the ops story is already understood.
  - Cons: new worker + new DNS record + new custom_domain route + new Workers
    Builds connector + a new turbo target. (Costs itemized in 4.5.)

- **B. Fold docs into `apps/landing` under `zeroapps.dev/docs` (same
  worker).** Rejected. Starlight expects to control layout/routing for its
  section and ships more CSS/JS than the deliberately zero-JS landing page;
  mixing a bespoke marketing Astro site and Starlight in one Astro project is
  awkward and couples every docs edit to a landing redeploy. Saves a worker and
  a DNS record but at real integration cost.

- **C. Plain markdown in-repo only.** Rejected as the product-docs answer. The
  existing `docs/` folder is internal engineering notes, not user-facing product
  docs, and there is no site, no copy-markdown UX, and no discoverability for
  users. (It can still *seed* the new site — see 4.4.)

Routing implications (per `AGENTS.md`):
- Subdomain `docs.zeroapps.dev` = a `custom_domain` route on the new worker
  (`routes: [{ pattern: "docs.zeroapps.dev", custom_domain: true }]`) plus a DNS
  record Cloudflare manages for the custom domain. This is exactly how
  `zero-landing` binds `zeroapps.dev` today.
- Path `zeroapps.dev/docs` would instead require either folding into the landing
  worker (option B) or a route carve-out; more coupling, not worth it.
- The Workers Builds connector runs **per-worker** build/deploy commands. Like
  `zero-landing`, scope the build to the package so it does **not** pull the
  Clerk/dashboard build: build `pnpm -F @zero/docs run build`, deploy
  `pnpm -F @zero/docs run deploy`. No `VITE_CLERK_*` build var needed (docs has
  no auth).

### 4.2 "Copy to markdown" per page — concretely

Use **`starlight-page-actions`**. At build it runs `vite-plugin-static-copy` to
emit a raw `.md`/`.mdx` twin for every page into `dist`, and it renders a **Copy
Markdown** button plus an **Open in ChatGPT / Claude** dropdown in the page
header. Because the twins are static files, they serve fine from the asset-only
`zero-docs` worker — **no runtime worker needed**.

We match Cloudflare's `index.md` twin pattern and copy button this way without
writing any worker code. We would **not** implement the `Accept: text/markdown`
content negotiation for v1 — that is the one piece that needs a runtime worker,
and the static twins already cover the agent use case.

### 4.3 Emit llms.txt / llms-full.txt

Yes, via **`starlight-llms-txt`**. One plugin line produces `/llms.txt`,
`/llms-full.txt` (and `/llms-small.txt`). Near-zero cost, matches Cloudflare's
surface. Treat it as a curated index, not an SEO lever (see section 3).

### 4.4 Keeping docs accurate

- The docs must document **verified-working** steps only. Seed them from the
  existing internal notes that already reflect reality — `docs/secrets.md`,
  `docs/workers-ops.md`, `docs/console-auth.md` — but rewrite for a
  product/user audience (no internal module names, per `AGENTS.md`
  communication rules). The internal `docs/` folder stays engineering-facing;
  the new site is the user-facing surface.
- Any user-observable docs change still follows the changelog rule in
  `AGENTS.md` (console-facing docs → root `CHANGELOG.md`).

### 4.5 Surfacing the planned top-level `skills/` directory

The repo will grow a top-level `skills/` of installable agent skills for Vault
and Errors (not present yet — verified `skills/` does not exist today). Skills
are themselves markdown, so they fit the copy-as-markdown model perfectly.

Recommendation: give the docs site a **"Skills"** section that documents each
skill (what it does, how to install, how to invoke) and links to a **stable,
downloadable copy of the skill file**. Two ways to source it, to be decided:
either **generate** the skill pages from `skills/` at build (single source of
truth, no drift) or **hand-write** doc pages that link to the raw files on
GitHub. Generating is better for accuracy; hand-writing is faster to start.

### 4.6 Cost

- **New worker** `zero-docs`: asset-only, same shape as `zero-landing`. Free
  tier is fine.
- **New DNS + custom domain**: one `docs.zeroapps.dev` custom_domain route +
  the DNS record Cloudflare provisions for it.
- **New Workers Builds connector**: one more per-worker connector on
  `juanibiapina/zero` (branch `main`), build `pnpm -F @zero/docs run build`,
  deploy `pnpm -F @zero/docs run deploy`, scoped to the package (no Clerk build
  var).
- **CI / turbo**: adds `build` / `lint` / `typecheck` targets for `@zero/docs`.
  `typecheck` would be `astro check` (Starlight). Note the NixOS-box limitation
  from `AGENTS.md`: `wrangler dev`/`dev:worker` can't run here, but `astro
  build` (static output) does, so the package build/lint/typecheck are locally
  runnable; only the local worker preview is not.
- **Dependencies**: `@astrojs/starlight` 0.41.4, `starlight-llms-txt` 0.11.0,
  `starlight-page-actions` 0.7.0 — all verified compatible with the installed
  Astro 7.1.3.

---

## 5. Rough shape of the implementation (not a step-by-step plan)

1. Scaffold `apps/docs` (`@zero/docs`) as an Astro + Starlight app (mirror
   `apps/landing`'s package/tsconfig/eslint wiring and dev-port convention).
2. Add `@astrojs/starlight`, `starlight-llms-txt`, `starlight-page-actions` and
   wire the two plugins in `astro.config`.
3. Author initial docs for ZeroVault and ZeroErrors, seeded from
   `docs/secrets.md`, `docs/workers-ops.md`, `docs/console-auth.md`, rewritten
   for users.
4. Add a "Skills" section for the top-level `skills/` (generation vs hand-write
   is an open question — see below).
5. Add `apps/docs/wrangler.jsonc`: asset-only, `custom_domain` route for
   `docs.zeroapps.dev`, `not_found_handling: 404-page` (as landing does).
6. Create the `zero-docs` Workers Builds connector (build/deploy scoped to the
   package). Add the DNS/custom-domain record.
7. Confirm turbo picks up the new package for build/lint/typecheck.

---

## 6. Open questions for the user

1. **Subdomain vs path**: `docs.zeroapps.dev` (recommended, own worker +
   connector) or `zeroapps.dev/docs` (folded into landing)?
2. **v1 content scope**: which products/pages ship first, and how much is seeded
   from the internal `docs/` notes vs written fresh?
3. **Skills surfacing**: generate skill pages from `skills/` at build (single
   source of truth) or hand-write pages linking to raw files? Where do users
   download the skill files from (docs worker assets vs GitHub)?
4. **`Accept: text/markdown` negotiation**: skip for v1 (static `.md` twins
   only, asset-only worker) — confirm that's acceptable, or accept a runtime
   worker to match Cloudflare exactly.
5. **Ownership / review cadence** for keeping the user docs accurate over time.
