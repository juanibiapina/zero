# Verification: docs sitemap plan

Verified 2026-07-28 against the repository, a fresh docs build, git history, the installed pnpm graph, and live responses from `https://docs.zeroapps.dev`.

## Overall verdict

**Approve with one scope reduction.** The headline claim is correct: there is no live sitemap or indexing-control defect to fix. The global `noindex` was removed, the last page-level `noindex` was removed from `/skills/overview/` by `14b1b5c`, all 12 live HTML pages are indexable, and the local and live sitemaps contain the same 12 HTML URLs.

The remaining implementation should only correct `AGENTS.md:189`. Drop the optional generated-output test from this change. There are no blockers.

## Findings

### Blocker

None.

### Concern

1. **The optional test is scope creep, and the proposed `test` wiring is not self-contained.** The plan calls the check "optional, recommended" at `docs/plans/docs-sitemap.md:185-201`, but the task has no remaining product defect. The checker would read `dist/`, while Turbo's generic `test` task has no dependency on `build` (`turbo.json:13`). The current whole-repo CI happens to run build before test (`bin/ci:14-15` and `.github/workflows/ci.yml:59-62`), but `pnpm --filter @zero/docs test` on a fresh checkout would have no built output. Making the dependency robust would require extra build/task wiring or a duplicate build. That is not warranted for correcting stale prose.

   **Fix:** remove Step 2 from the implementation scope. If generated docs invariants later cause regressions, add a self-contained check in a separate change with an explicit build prerequisite.

### Nit

1. **"Byte-for-byte" is false.** `docs/plans/docs-sitemap.md:134` says the Markdown twins are byte-for-byte the same as their HTML pages. They contain the same substantive page content in another representation, not the same bytes. For `/skills/overview/`, the fresh build produced a 37,123-byte HTML file and a 1,484-byte Markdown file with different SHA-256 hashes. This does not affect the sitemap decision.

   **Fix:** replace "byte-for-byte the same content" with "alternate Markdown representations of the same page content."

## Evidence

### 1. Source and built output contain no indexing prohibition

- `rg -i 'noindex|nofollow|x-robots|robots|(^|[[:space:]])head:' apps/docs --glob '!dist/**'` returned no matches.
- The 12 source pages under `apps/docs/src/content/docs/` have only `title` and `description` frontmatter. There is no page-level `head` entry.
- `apps/docs/astro.config.mjs:6-12` configures Starlight without a global `head` entry. The file has no `components` override.
- There are no local layout, page, or component overrides under `apps/docs`.
- `pnpm --filter @zero/docs run build` succeeded and generated 12 content HTML pages plus `dist/404.html`. Scanning all 13 built HTML files found no `noindex`, `nofollow`, or robots meta tag.

This checks the authored source and the final output after Starlight and its plugins have run.

### 2. Per-page production results

Each URL was fetched on 2026-07-28. The 12 HTML URLs were also fetched with a `Googlebot` user agent, with the same result: HTTP 200, no robots meta tag, and no `X-Robots-Tag` header.

| Kind | URL | Status | Content-Type | robots meta | X-Robots-Tag |
|---|---|---:|---|---|---|
| HTML | `https://docs.zeroapps.dev/` | 200 | `text/html` | none | none |
| HTML | `https://docs.zeroapps.dev/account/api-keys/` | 200 | `text/html` | none | none |
| HTML | `https://docs.zeroapps.dev/errors/getting-started/` | 200 | `text/html` | none | none |
| HTML | `https://docs.zeroapps.dev/errors/overview/` | 200 | `text/html` | none | none |
| HTML | `https://docs.zeroapps.dev/errors/reporter/` | 200 | `text/html` | none | none |
| HTML | `https://docs.zeroapps.dev/errors/worker-integration/` | 200 | `text/html` | none | none |
| HTML | `https://docs.zeroapps.dev/skills/overview/` | 200 | `text/html` | none | none |
| HTML | `https://docs.zeroapps.dev/vault/cli/` | 200 | `text/html` | none | none |
| HTML | `https://docs.zeroapps.dev/vault/getting-started/` | 200 | `text/html` | none | none |
| HTML | `https://docs.zeroapps.dev/vault/loading-secrets/` | 200 | `text/html` | none | none |
| HTML | `https://docs.zeroapps.dev/vault/overview/` | 200 | `text/html` | none | none |
| HTML | `https://docs.zeroapps.dev/vault/workers/` | 200 | `text/html` | none | none |
| Markdown | `https://docs.zeroapps.dev/index.md` | 200 | `text/markdown` | n/a, no meta markup found | none |
| Markdown | `https://docs.zeroapps.dev/account/api-keys.md` | 200 | `text/markdown` | n/a, no meta markup found | none |
| Markdown | `https://docs.zeroapps.dev/errors/getting-started.md` | 200 | `text/markdown` | n/a, no meta markup found | none |
| Markdown | `https://docs.zeroapps.dev/errors/overview.md` | 200 | `text/markdown` | n/a, no meta markup found | none |
| Markdown | `https://docs.zeroapps.dev/errors/reporter.md` | 200 | `text/markdown` | n/a, no meta markup found | none |
| Markdown | `https://docs.zeroapps.dev/errors/worker-integration.md` | 200 | `text/markdown` | n/a, no meta markup found | none |
| Markdown | `https://docs.zeroapps.dev/skills/overview.md` | 200 | `text/markdown` | n/a, no meta markup found | none |
| Markdown | `https://docs.zeroapps.dev/vault/cli.md` | 200 | `text/markdown` | n/a, no meta markup found | none |
| Markdown | `https://docs.zeroapps.dev/vault/getting-started.md` | 200 | `text/markdown` | n/a, no meta markup found | none |
| Markdown | `https://docs.zeroapps.dev/vault/loading-secrets.md` | 200 | `text/markdown` | n/a, no meta markup found | none |
| Markdown | `https://docs.zeroapps.dev/vault/overview.md` | 200 | `text/markdown` | n/a, no meta markup found | none |
| Markdown | `https://docs.zeroapps.dev/vault/workers.md` | 200 | `text/markdown` | n/a, no meta markup found | none |
| Text | `https://docs.zeroapps.dev/llms.txt` | 200 | `text/plain` | n/a, no meta markup found | none |
| Text | `https://docs.zeroapps.dev/llms-full.txt` | 200 | `text/plain` | n/a, no meta markup found | none |
| Text | `https://docs.zeroapps.dev/llms-small.txt` | 200 | `text/plain` | n/a, no meta markup found | none |

A missing-path probe also returned HTTP 404 with the title `404 | Zero Docs`, no robots meta tag, and no `X-Robots-Tag` header.

### 3. Local and live sitemap match

The fresh build produced:

- `apps/docs/dist/sitemap-index.xml`: one child, `https://docs.zeroapps.dev/sitemap-0.xml`.
- `apps/docs/dist/sitemap-0.xml`: exactly 12 URLs.
- No `.md`, `.txt`, `.xml`, or other non-HTML URL in the URL set.

Exact URL set:

1. `https://docs.zeroapps.dev/`
2. `https://docs.zeroapps.dev/account/api-keys/`
3. `https://docs.zeroapps.dev/errors/getting-started/`
4. `https://docs.zeroapps.dev/errors/overview/`
5. `https://docs.zeroapps.dev/errors/reporter/`
6. `https://docs.zeroapps.dev/errors/worker-integration/`
7. `https://docs.zeroapps.dev/skills/overview/`
8. `https://docs.zeroapps.dev/vault/cli/`
9. `https://docs.zeroapps.dev/vault/getting-started/`
10. `https://docs.zeroapps.dev/vault/loading-secrets/`
11. `https://docs.zeroapps.dev/vault/overview/`
12. `https://docs.zeroapps.dev/vault/workers/`

The live `sitemap-index.xml` and `sitemap-0.xml` were byte-identical to the fresh local files. The sitemap premise is healthy at the built and deployed layers.

### 4. Git attribution and timing

`git log -Snoindex -p -- apps/docs` and commit snapshots show this sequence:

| Commit | Time | Change |
|---|---|---|
| `11a10e4` | 2026-07-27 10:43:03 +02:00 | Added global Starlight `noindex, nofollow` in `apps/docs/astro.config.mjs`. |
| `0fc26b2` | 2026-07-27 12:51:34 +02:00 | Removed the global entry and added page-level `noindex, nofollow` to `apps/docs/src/content/docs/skills/overview.md`. |
| `14b1b5c` | 2026-07-27 14:48:59 +02:00 | Removed the Skills page frontmatter entry while publishing the real Skills content. |

`git grep` finds one source occurrence at `11a10e4`, one at `0fc26b2`, and none at `14b1b5c` or current `HEAD`. The attribution is exact.

The plan records Googlebot's last crawl as 2026-07-27 18:23:34. That is after the `14b1b5c` commit even if the displayed crawl time were UTC rather than +02:00. The plan's URL Inspection result, "Indexing allowed: Yes," is also consistent with Googlebot receiving the post-removal page.

### 5. Option (b) dependency cost

The cost claim is true.

- `apps/docs/package.json:14-29` does not declare `@astrojs/sitemap`.
- The docs importer in `pnpm-lock.yaml:337-369` does not list it.
- `pnpm-lock.yaml:9770-9774` lists `@astrojs/sitemap` under Starlight's dependencies.
- `pnpm --filter @zero/docs why @astrojs/sitemap` resolves it through `@astrojs/starlight`.
- A direct import from `apps/docs` fails with `ERR_MODULE_NOT_FOUND`, which confirms pnpm does not expose Starlight's dependency to the docs package.
- Installed Starlight source checks for an existing integration named `@astrojs/sitemap` before adding its wrapped integration (`node_modules/.pnpm/.../@astrojs/starlight/index.ts:99-108`).
- A throwaway clone test using `pnpm --filter @zero/docs add --save-dev @astrojs/sitemap@3.7.3 --lockfile-only` changed both `apps/docs/package.json` and `pnpm-lock.yaml`, adding an importer entry for version `3.7.3`.

Using the integration's `filter` option directly therefore requires a direct declaration and a lockfile change.

### 6. `AGENTS.md` is stale

Current text at `AGENTS.md:189` says:

> It is currently placeholder content and globally `noindex, nofollow` via Starlight `head` until real docs land; `robots.txt` keeps `Allow: /` so crawlers can reach the noindex directive.

The false parts are:

- "currently placeholder content": the source and build contain 12 written product, account, and Skills pages.
- "globally `noindex, nofollow` via Starlight `head`": `apps/docs/astro.config.mjs` has no such `head`, no page frontmatter has it, built output has none, and production has none.
- "so crawlers can reach the noindex directive": `Allow: /` is true, but there is no noindex directive to reach.

Correcting this line is the right residual scope. The durable facts to retain are that the site is indexable, `robots.txt` allows crawling and names the sitemap index, and the generated sitemap lists only HTML pages.

### 7. robots.txt and 404

- Source `apps/docs/public/robots.txt:1-4` contains `User-agent: *`, `Allow: /`, and `Sitemap: https://docs.zeroapps.dev/sitemap-index.xml`.
- The built `dist/robots.txt` contains the same text.
- The live file returns HTTP 200 and the same text.
- `apps/docs/wrangler.jsonc:5-7` retains `not_found_handling: "404-page"`.
- The build generated `dist/404.html`.
- A live unknown path returned HTTP 404, not a soft 200.

### 8. Search Console arithmetic

The recorded numbers are internally consistent:

- 6 indexed
- 4 Discovered, currently not indexed
- 2 unknown to Google
- Total: 12

The listed per-URL rows match those category counts, and 12 matches the independently measured local and live sitemap count. A two-day-old site having some discovered but not yet crawled URLs is plausible. Nothing in the figures conflicts with the live crawl posture.

I did **not** reopen Search Console. The user allowed relying on the recorded snapshot unless something looked wrong, and no inconsistency triggered another authenticated check. This verification confirms the repository, build, deployment, URL count, and live indexability, but not a new Search Console snapshot.

## Updated implementation plan

1. Edit only the docs-site description at `AGENTS.md:189` so it no longer claims placeholder content or a global `noindex`. State the current repo-controlled crawl posture.
2. Correct the inaccurate "byte-for-byte" wording in this plan if the plan itself is being cleaned up.
3. Do not change docs source, Starlight config, sitemap config, robots.txt, Wrangler config, dependencies, lockfile, or changelog.
4. Do not add the optional `dist` test in this change.
