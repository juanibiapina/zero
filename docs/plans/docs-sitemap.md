# docs.zeroapps.dev sitemap: Search Console state and the noindex/sitemap contradiction

## Goal

Confirm from Search Console that the `docs.zeroapps.dev` sitemap is fully
processed, resolve the reported contradiction between `sitemap-0.xml` listing
`/skills/overview/` and that page shipping `noindex`, and leave the repo's
written description of the docs site's crawl posture true.

## Part A: Search Console state (measured 2026-07-28)

Property: `sc-domain:zeroapps.dev` (one domain property; it covers both
`zeroapps.dev` and `docs.zeroapps.dev`). There is no separate URL-prefix
property for either host. Signed in as `juanibiapina@gmail.com`.

**Sitemaps report**

| Sitemap | Type | Submitted | Last read | Status | Discovered pages |
|---|---|---|---|---|---|
| `https://docs.zeroapps.dev/sitemap-index.xml` | Sitemap index | Jul 27, 2026 | Jul 28, 2026 | Success | 12 |
| `https://zeroapps.dev/sitemap.xml` | Sitemap | Jul 26, 2026 | Jul 27, 2026 | Success | 1 |

Drilldown on the docs index: "Sitemap index processed successfully", total
discovered pages 12. Child `https://docs.zeroapps.dev/sitemap-0.xml`, last read
Jul 28, 2026, status **Success**, 12 discovered URLs.

**The "Couldn't fetch / 0 pages" state described in the task is gone.** It was
the expected pending state minutes after submission. Both the index and the
child are Success, and the discovered count (12) equals the URL count in the
live `sitemap-0.xml`. The sitemap side of this is healthy and needs no work.

**Page indexing report:** the aggregate report ("Why pages aren't indexed"),
both unfiltered and filtered by the docs sitemap, still says *"Processing data,
please check again in a day or so"*. The property was verified Jul 26, so no
aggregate breakdown exists yet. Per-URL state below comes from URL Inspection
(Google's index, not a live test), which is the only source available today.

**Per-URL indexing state, all 12 sitemap URLs plus the landing URL**

| URL | State |
|---|---|
| `docs.zeroapps.dev/` | Indexed |
| `docs.zeroapps.dev/skills/overview/` | **Indexed** |
| `docs.zeroapps.dev/vault/getting-started/` | Indexed |
| `docs.zeroapps.dev/vault/loading-secrets/` | Indexed |
| `docs.zeroapps.dev/errors/overview/` | Indexed |
| `docs.zeroapps.dev/errors/worker-integration/` | Indexed |
| `docs.zeroapps.dev/vault/cli/` | Not indexed: Discovered - currently not indexed |
| `docs.zeroapps.dev/vault/workers/` | Not indexed: Discovered - currently not indexed |
| `docs.zeroapps.dev/errors/getting-started/` | Not indexed: Discovered - currently not indexed |
| `docs.zeroapps.dev/errors/reporter/` | Not indexed: Discovered - currently not indexed |
| `docs.zeroapps.dev/vault/overview/` | Not indexed: URL is unknown to Google |
| `docs.zeroapps.dev/account/api-keys/` | Not indexed: URL is unknown to Google |
| `zeroapps.dev/` (landing) | Indexed |

Totals: **6 of 12 indexed, 4 "Discovered - currently not indexed", 2 "URL is
unknown to Google". Zero URLs excluded by a `noindex` tag. Zero crawl errors.**

The four "Discovered - currently not indexed" URLs all show
`Discovery > Sitemaps: https://docs.zeroapps.dev/sitemap-index.xml`, i.e. Google
has them from the sitemap and has simply not chosen to crawl/index them yet on a
two-day-old site. That is a scheduling state, not a defect, and no code change
influences it.

The two "URL is unknown to Google" entries show "No referring sitemaps detected"
in the per-URL cache, which lags the sitemap report. `/account/api-keys/` only
landed on 2026-07-28 (commit `432b86e`), so it is genuinely new.
`/vault/overview/` is older and its per-URL record is stale; it is present in the
live sitemap that Google read on Jul 28.

Detail for `/skills/overview/` specifically (URL Inspection): **Page is
indexed**; last crawl Jul 27, 2026, 6:23:34 PM as Googlebot smartphone; Crawl
allowed **Yes**; Page fetch Successful; **Indexing allowed: Yes**; user-declared
canonical is itself; referring page `https://docs.zeroapps.dev/`.

**Landing property:** nothing regressed. `https://zeroapps.dev/sitemap.xml` is
Success with its 1 URL, and `https://zeroapps.dev/` is indexed. Overview shows
3 HTTPS pages / 0 non-HTTPS and 0 web search clicks so far.

## Part B: the contradiction no longer exists

The premise ("`/skills/overview/` ships a `noindex` meta tag") was true at
scaffold time and is **false now**. Verified three ways:

1. **Source:** no page under `apps/docs/src/content/docs/` has a `head:` /
   `robots` frontmatter entry, and `apps/docs/astro.config.mjs` has no global
   `head` robots entry. `rg -i 'noindex|nofollow' apps/docs` returns nothing.
2. **Live production:** fetching all 12 pages, every one returns 200 and none
   contains a `robots` meta tag; `curl -I` shows no `X-Robots-Tag` header.
3. **Google:** URL Inspection on `/skills/overview/` reports "Indexing allowed:
   Yes" and the page is indexed.

History: the site-wide `noindex, nofollow` was added by the scaffold
(`11a10e4`, per `docs/plans/docs-site-scaffold-verify.md`, deliberately, because
the pages were thin placeholders). It was lifted from the eight real pages in
`0fc26b2`, which left a **page-level** `noindex` on the then-empty Skills page.
That page-level `noindex` was removed in `14b1b5c` ("Publish ZeroVault and
ZeroErrors agent skills", 2026-07-27) when the page got real content, install
instructions, and its sidebar entry. Googlebot's crawl at Jul 27 18:23 already
saw the post-`14b1b5c` page.

### Decision: option (a), and it is already implemented

**Take (a): no `noindex` on `/skills/overview/`, keep it in the sitemap.** It is
a real public page with real content pointing at a public repo, it is reachable
from the sidebar and the home page, and it is the canonical install instruction
for `npx skills add juanibiapina/zero-skills`. Sitemap and page now agree.
Nothing to change; (a) shipped in `14b1b5c` and Google acted on it.

Nothing else on the site should stay `noindex`. All twelve pages are real,
public, non-duplicated content. There is no admin, staging, or gated area.

**What option (b) would have cost.** Starlight injects `@astrojs/sitemap`
itself, only if the user has not already added an integration named
`@astrojs/sitemap` (see `node_modules/@astrojs/starlight/index.ts` around the
`allIntegrations.find` checks, and `integrations/sitemap.ts`). `@astrojs/sitemap`
is therefore a **transitive** dependency, not declared in
`apps/docs/package.json`. Using its `filter` option means importing it directly,
which under pnpm's non-hoisted layout means declaring it as a direct dependency,
which means editing `pnpm-lock.yaml`. All four Workers watch `pnpm-lock.yaml`,
so a docs-only sitemap tweak would have forced a redeploy of `zero-api`,
`zerovault-api`, and `zero-landing` too, resetting in-flight agent turns. (b) was
both the wrong answer on the merits and the expensive one.

**Option (c), a `_headers` file adding `X-Robots-Tag: noindex` to the `.md`
twins:** rejected, see below.

### `.md` twins and `/llms*.txt` in the sitemap

They are **not** in the sitemap, and they **should not be**. Confirmed against
both the live `sitemap-0.xml` and a local build: the sitemap contains exactly the
12 HTML page URLs, no `.md`, no `llms*.txt`.

The `.md` twins are byte-for-byte the same content as their HTML page. A sitemap
is a request to index; asking Google to index both forms invites a duplicate
pair where the HTML page is the one that should win, and `text/markdown` cannot
carry a `rel=canonical`. Keeping them out is correct.

Observed but deliberately not acted on: each HTML page links its twin with a real
`<a href="/<page>.md">` (the Copy Markdown action from `starlight-page-actions`),
so the twins are crawlable even though they are not advertised. `/llms.txt`,
`/llms-full.txt` and `/llms-small.txt` are not linked from any HTML page at all.
URL Inspection on `https://docs.zeroapps.dev/skills/overview.md` and
`https://docs.zeroapps.dev/llms.txt` returns "URL is unknown to Google" for both:
Google has not crawled either and there is no duplicate-content problem to fix.
Adding an `X-Robots-Tag` header for `*.md` would be a speculative fix for a
problem with no evidence, so do not.

## What to change

One change, and it is documentation.

### 1. Fix the stale docs-site description in `AGENTS.md` (required)

`AGENTS.md` line 189 (the "**Docs site:**" bullet under Architecture) still
says:

> It is currently placeholder content and globally `noindex, nofollow` via
> Starlight `head` until real docs land; `robots.txt` keeps `Allow: /` so
> crawlers can reach the noindex directive.

Both halves of the first clause are false: the content is real (twelve written
pages across ZeroVault, ZeroErrors, Account and Skills) and there is no global
`noindex`. Leaving it is the actual live hazard here, because the next agent
reading it may "restore" a `noindex` that was intentionally removed, or assume
the site is not meant to be indexed.

Replace that sentence with the true posture, keeping the rest of the bullet
intact. Suggested wording (adjust as needed, but it must state: content is real,
the site is indexable, no page carries `noindex`, `robots.txt` is `Allow: /` and
points at the sitemap index, the sitemap lists only the HTML pages, and the
sitemap is submitted):

> The content is real and the site is indexable: no page carries a `noindex`
> meta tag, `robots.txt` is `Allow: /` and points at
> `https://docs.zeroapps.dev/sitemap-index.xml`, and that sitemap (submitted to
> Google Search Console under `sc-domain:zeroapps.dev`) lists only the HTML
> pages, never the `.md` twins or the `llms*.txt` files.

Do not touch `docs/plans/docs-content-getting-started.md` or
`docs/plans/docs-site-scaffold-verify.md`. Those are historical records of
decisions taken at the time; their `noindex` statements were true when written.
This plan file is the current record.

### 2. Guard the invariant in the build (optional, recommended)

Nothing today catches a regression where a `noindex` sneaks back onto a page or
a non-HTML URL enters the sitemap. If you want that guard, add a small Node
script under `apps/docs/` (no new dependency, `node:fs` only, so
`pnpm-lock.yaml` stays untouched) that runs against `dist/` after a build and
fails when:

- any `dist/**/*.html` contains `noindex`;
- `dist/sitemap-0.xml` contains a `loc` that is not a trailing-slash HTML page
  URL (i.e. rejects any `.md`, `.txt`, or `.xml` entry);
- `dist/robots.txt` does not contain `Allow: /`;
- `dist/404.html`, `dist/llms.txt`, `dist/llms-full.txt`, `dist/llms-small.txt`
  and the per-page `.md` twins are missing.

Wire it as `apps/docs`'s `test` script so the Turbo pipeline and GitHub Actions
run it. This is the only code change this plan permits; skip it if you want the
smallest possible diff, but nothing else in the plan is optional.

### 3. No sitemap or page change

Do not edit `apps/docs/astro.config.mjs`, any page frontmatter,
`apps/docs/public/robots.txt`, or `apps/docs/wrangler.jsonc`. There is no defect
to fix there. Do not resubmit the sitemap: it is Success, read Jul 28, 12/12
discovered. Do not "Request indexing" on the six pending URLs; they are queued
correctly and manual requests do not help a two-day-old property.

## Changelog

**No entry.** Per `AGENTS.md`, a changelog bullet is for something a user can
observe changing. Nothing user-visible changes here: the actual user-visible
change (the Skills page becoming public and indexable) already shipped in
`14b1b5c` and already has its bullet, `- 2026-07-27: ZeroVault and ZeroErrors now
ship installable agent skills...`. Step 1 is an internal correction to agent
instructions and Step 2 is a test. Both are explicitly "purely internal" under
the AGENTS.md rule.

## Tests

- Step 1 has no test; it is prose.
- Step 2 is itself the test. Prove it fails: temporarily add
  `head: [{ tag: meta, attrs: { name: robots, content: noindex } }]` to one page's
  frontmatter, rebuild, see the check fail, revert.

## Deploy scoping

Step 1 touches repo-root `AGENTS.md`, which is **not** in any Worker's build
watch paths, so it triggers no deploy. Step 2 touches only `apps/docs/*`, which
is `zero-docs`'s watch path and nobody else's. Neither step touches
`pnpm-lock.yaml`, `package.json` at the repo root, `turbo.json`, or
`pnpm-workspace.yaml`. A push carrying only these two steps redeploys at most
`zero-docs`.

## Verification

This box cannot run `workerd`, so there is no local Worker to hit. Verify with a
build plus `dist/` inspection, then against production after deploy.

Local (already run once while researching, re-run after any change):

```bash
pnpm --filter @zero/docs run build
pnpm --filter @zero/docs run lint
pnpm --filter @zero/docs run typecheck
cd apps/docs
rg -l noindex dist --glob '*.html'          # expect: no matches
rg -o '<loc>[^<]+' dist/sitemap-0.xml | wc -l   # expect: 12
ls dist/404.html dist/robots.txt dist/llms.txt dist/llms-full.txt dist/llms-small.txt
fd -e md . dist | wc -l                      # expect: 12 twins
```

The current build already produces exactly this: 12 sitemap `loc` entries
matching the 12 live URLs, no `noindex` in any HTML, all three `llms*.txt`, a
real `404.html`, `robots.txt` with `Allow: /`, and 12 `.md` twins.

Production (after deploy, only needed if Step 2 lands):

```bash
curl -s https://docs.zeroapps.dev/skills/overview/ | rg -i noindex   # expect: no matches
curl -s https://docs.zeroapps.dev/sitemap-0.xml | rg -o '<loc>' | wc -l  # expect: 12
curl -s https://docs.zeroapps.dev/robots.txt
curl -s -o /dev/null -w '%{http_code}\n' https://docs.zeroapps.dev/nope  # expect: 404
```

## Skills to use

- `plan`: already applied to produce this file.
- `browse`: for any further Search Console reads; the aggregate Page indexing
  report is worth re-checking in a few days, once it stops saying "Processing
  data".
- `vocabulary`: when discussing the docs site's shape in prose.
- `git-commit`: when committing Step 1 (and Step 2 if taken).

## Acceptance criteria

1. Part A is recorded as fact in this file: both sitemaps Success, docs
   `sitemap-0.xml` last read Jul 28 2026 with 12/12 URLs discovered, 6 indexed,
   4 "Discovered - currently not indexed", 2 "URL is unknown to Google", **0
   excluded by `noindex`**, and the landing property unregressed.
2. `rg -i 'noindex|nofollow' apps/docs` returns no matches, and
   `pnpm --filter @zero/docs run build` produces a `dist/` with no `noindex` in
   any HTML file. (Already true; the criterion is that it stays true.)
3. `dist/sitemap-0.xml` contains exactly the 12 HTML page URLs and no `.md`,
   `llms*.txt`, or other non-HTML URL.
4. `apps/docs` still ships all 12 per-page bare `.md` twins, `/llms.txt`,
   `/llms-full.txt`, `/llms-small.txt`, a real `404.html`, and a `robots.txt`
   containing `Allow: /` and the sitemap-index line.
5. The `AGENTS.md` docs-site bullet no longer claims placeholder content or a
   global `noindex`, and instead states the real crawl posture.
6. `git diff --name-only` on the change touches nothing outside `AGENTS.md`,
   `apps/docs/`, and `docs/plans/`. In particular `pnpm-lock.yaml` is untouched,
   so no Worker other than `zero-docs` is redeployed.
7. No root `CHANGELOG.md` entry is added, and the plan says why.
8. `pnpm --filter @zero/docs run lint` and
   `pnpm --filter @zero/docs run typecheck` pass.
