# Plan: drop the old bare console web hosts

> **Supersedes** `docs/plans/redirect-old-console-hosts.md` (and its companion
> `docs/plans/redirect-old-console-hosts-verify.md`). Those planned a
> worker-level 308 redirect from the old bare hosts to the `*.apps` hosts so old
> bookmarks would keep working and login would succeed. There are **no users
> yet**, so preserving old bookmarks has no value. Instead of redirecting, we
> **drop** the old bare web hosts entirely. Delete the two redirect plan files as
> part of this change (see "Clean up superseded plans").

## Goal

Remove the old bare console web hosts `vault.juanibiapina.dev` and
`errors.juanibiapina.dev` so they no longer resolve to the workers. Keep
everything else working:

- Keep `zerovault.juanibiapina.dev` / `zeroerrors.juanibiapina.dev` — the API
  hosts, used by `zerovault-cli` `DEFAULT_BASE_URL` and by `agent-api` as the
  zero-errors `ENDPOINT`.
- Keep the canonical web hosts `vault.apps.juanibiapina.dev` /
  `errors.apps.juanibiapina.dev`.

## Findings (research)

### Each product is a single worker serving SPA + API on every attached host

- `apps/vault-api` builds the `zerovault-api` worker; `apps/errors-api` builds
  the `zeroerrors-api` worker. Each worker's entry (`src/index.ts` ->
  `src/worker.ts`) delegates to a Hono app (`src/app.ts`).
- The SPA is served by the worker's **static-assets binding**, not Pages. The
  `assets` block sets `run_worker_first: ["/ping", "/v1/*", "/api/*"]`: those API
  paths hit the worker, every other path is served from static assets with SPA
  fallback. This is path-based only, with **no host awareness** — all three
  custom domains behave identically (SPA + API) on the same worker.
- Because routing has no host awareness, "which hostnames a worker answers on" is
  determined entirely by `routes[]`. Removing a hostname from `routes[]` (and
  detaching its custom domain) is the only lever that stops that host from
  reaching the worker.

### Both workers attach all three custom domains today

`apps/vault-api/wrangler.jsonc` `routes[]` (errors is symmetric):

```jsonc
"routes": [
  { "pattern": "zerovault.juanibiapina.dev",  "custom_domain": true },  // API host — KEEP
  { "pattern": "vault.juanibiapina.dev",      "custom_domain": true },  // old bare web host — DROP
  { "pattern": "vault.apps.juanibiapina.dev", "custom_domain": true }   // canonical web host — KEEP
]
```

`apps/errors-api/wrangler.jsonc` is identical with `errors` / `zeroerrors`.

### Nothing in the repo depends on the bare `vault.` / `errors.` hosts

Confirmed by grepping the codebase (2026-07-22):

- **Web cross-links:** `packages/ui/src/products.ts` already points at the
  `*.apps` hosts (`PROD_VAULT_URL = "https://vault.apps.juanibiapina.dev"`,
  `PROD_ERRORS_URL = "https://errors.apps.juanibiapina.dev"`). No reference to the
  bare hosts.
- **API consumers** all use the `zerovault.` / `zeroerrors.` API hosts, never the
  bare web hosts: `packages/zerovault-cli/src/index.ts`
  `DEFAULT_BASE_URL = "https://zerovault.juanibiapina.dev"`;
  `apps/agent-api/src/reporting/zero-errors.ts`
  `ENDPOINT = "https://zeroerrors.juanibiapina.dev/v1/errors"` (and its test).
  These are untouched by this change.
- **CORS:** both APIs use `origin: "*"` (`apps/vault-api/src/app.ts`,
  `apps/errors-api/src/app.ts`). No host allowlist to edit.
- **Clerk:** no in-repo Clerk `isSatellite` / `domain` / allowed-origins config
  ties to the bare hosts. Clerk origin config is out-of-repo Dashboard state.
- The only remaining mentions of the bare hosts are **historical**: the
  `CHANGELOG.md` 2026-07-21 entry ("…live at vault.juanibiapina.dev and
  errors.juanibiapina.dev") and several `docs/plans/*.md`. These are history and
  are left as-is (except the doc note below and the two superseded redirect
  files, which are deleted).

So dropping the bare web hosts breaks no in-repo consumer.

### What wrangler does — and does NOT do — on `custom_domain` removal

> **CORRECTION (2026-07-23) — the claim below is DISPROVEN and superseded.**
> The `retire-zerovault-domain` task removed the `zerovault.juanibiapina.dev`
> `custom_domain` route and deployed (version `05a896d0`, 2026-07-23, commit
> `34716c4`). Removing a `custom_domain` route and deploying **auto-deletes** the
> Worker custom domain **and** its auto-created proxied DNS record; the old host
> went NXDOMAIN with no manual delete. So the additive / manual-Cloudflare-delete
> model described below is wrong. The original text is kept for history but must
> not be followed. Durable source: `docs/workers-ops.md`.

Removing a `custom_domain` entry from `routes[]` and redeploying does **not**
automatically detach the custom domain or delete its DNS record. Wrangler
provisions custom domains it finds in config but does **not** tear down a custom
domain that has disappeared from config (a known wrangler gotcha). Result if you
only edit config: config drift (config lists 2 domains, Cloudflare still has 3)
and the old host **keeps resolving to the worker**.

> Source note: this additive / non-tear-down behavior is **observed wrangler
> behavior** (wrangler 4.103.0, per `apps/vault-api/package.json`), not something
> citable from the loaded `cloudflare` skill — its references document *adding*
> `custom_domain` routes but not the removal gotcha. The claim is fail-safe: even
> if a future wrangler auto-detached a dropped domain, the manual dashboard
> removal below is a harmless no-op. Re-check against Cloudflare's "Routes and
> domains" / wrangler custom-domains docs if this ever matters.

Therefore the detach is a **manual Cloudflare action**. When a Worker Custom
Domain is added, Cloudflare auto-creates a proxied DNS record for that hostname;
**removing the custom domain deletes that auto-created DNS record too**. After
the manual removal, `vault.juanibiapina.dev` / `errors.juanibiapina.dev` have no
DNS record and no route, so they stop resolving to the worker.

The config edit is still required — it makes the repo the source of truth and
prevents a future Workers Build deploy from **re-provisioning** the custom domain
after you delete it manually.

### Deploy + local verification model (from `AGENTS.md`)

- Push to `main` auto-deploys both workers via the Cloudflare Workers Builds git
  connector. No manual deploy step for the code change.
- Dev box can't boot whole-repo `workerd` (NixOS). Verify the touched packages
  directly with `pnpm --filter` (commands below); rely on GitHub Actions CI and
  the Cloudflare deploy for `workerd`-backed suites.

## What to change and why

### 1. `apps/vault-api/wrangler.jsonc` — drop the bare web host route

Delete this entry from `routes[]`:

```jsonc
{
  "pattern": "vault.juanibiapina.dev",
  "custom_domain": true
},
```

Keep the `zerovault.juanibiapina.dev` and `vault.apps.juanibiapina.dev` entries.

### 2. `apps/errors-api/wrangler.jsonc` — drop the bare web host route

Delete this entry from `routes[]`:

```jsonc
{
  "pattern": "errors.juanibiapina.dev",
  "custom_domain": true
},
```

Keep the `zeroerrors.juanibiapina.dev` and `errors.apps.juanibiapina.dev`
entries.

No other code changes. The `assets` block, `run_worker_first`, bindings, and the
Hono app are unchanged — this change only narrows which hostnames each worker is
attached to.

## DNS / custom domain: automatic vs manual

**Automatic (on push to `main`):**

- Workers Builds redeploys both workers with the narrowed `routes[]`. This makes
  the repo the source of truth (2 domains each) and stops future deploys from
  re-adding the bare hosts. It does **not** by itself detach the existing custom
  domains — see below.

**Manual (required — do after the deploy lands):**

Delete two Worker Custom Domains in Cloudflare — described by function so the step
survives dashboard relabels:

1. On worker `zerovault-api`, **delete the Worker Custom Domain for
   `vault.juanibiapina.dev`**. This also deletes that hostname's auto-created
   proxied DNS record, so the host stops resolving.
2. On worker `zeroerrors-api`, **delete the Worker Custom Domain for
   `errors.juanibiapina.dev`**. Same DNS side effect.

In today's dashboard these live under Workers & Pages -> the worker ->
Settings -> **Domains & Routes** (the section label has drifted over time —
Triggers / Domains & Routes / Settings — so navigate by "the worker's custom
domains list", not the exact label). Equivalent Cloudflare API
`DELETE .../domains/records/<id>` is an alternative; the Dashboard is simplest
and this is a one-time cleanup.

Do **not** touch the `zerovault.` / `zeroerrors.` or `*.apps` custom domains.

**Order:** merge + deploy the config edit first, then do the manual removals.
Since the config no longer lists the bare hosts, a later deploy will not
recreate them.

## Docs to update

- `docs/plans/subdomain-rename.md` has a "Removing the old custom domains is OUT
  OF SCOPE (deferred)" section that conflates the API hosts with the bare web
  hosts. Add a short note there (near that section and step 5 of "Sequencing")
  recording that the bare **web** hosts `vault.juanibiapina.dev` /
  `errors.juanibiapina.dev` were later dropped by
  `docs/plans/drop-old-console-hosts.md`, while the `zerovault.` / `zeroerrors.`
  **API** hosts remain attached (they still have live consumers). Keep it to a
  couple of lines; don't rewrite the section.

- `tasks.md` (git-tracked — `git ls-files tasks.md` returns it) section **## 1.
  Redirect old console hosts to *.apps** describes the **abandoned redirect**
  approach this plan supersedes. It asserts the bare hosts "still serve the SPA"
  and to "Keep custom domains attached so the redirect can fire" — the exact
  opposite of this change's outcome (hosts dropped, custom domains detached).
  Leaving it makes the repo self-contradictory after this change. **Remove
  section #1 entirely** (it is superseded, not a remaining follow-up), and
  renumber the later sections if the file numbers them sequentially, or replace
  it with a one-line "Done — old bare web hosts dropped, see
  `docs/plans/drop-old-console-hosts.md`". Do this in the same change/commit as
  the wrangler edits. Leave the other `tasks.md` sections untouched.

## Clean up superseded plans

Delete both files — they describe the abandoned redirect approach:

- `docs/plans/redirect-old-console-hosts.md`
- `docs/plans/redirect-old-console-hosts-verify.md`

## Changelog entry plan

This is a console (Vault/Errors) change, so it goes in the **root `CHANGELOG.md`**
(per `AGENTS.md`; the agent changelog is only for `apps/agent-api`). Root
`CHANGELOG.md` is a flat, dated, most-recent-first list. Load the `changelog`
skill before editing. Add a new top entry, user-facing:

```
- 2026-07-22: The old Vault and Errors addresses (vault.juanibiapina.dev, errors.juanibiapina.dev) have been retired; the products now live only at vault.apps.juanibiapina.dev and errors.apps.juanibiapina.dev.
```

Commit the entry together with the wrangler edits in the same change.

## Skills to use during implementation

- `code` — making the two `wrangler.jsonc` edits and the doc note.
- `changelog` — the flat-dated root `CHANGELOG.md` entry.
- `cloudflare` — custom-domain routing and the manual detach/DNS behavior.
- `reproducible-locally` — the post-deploy `curl` proofs below.
- `git-commit` — committing the config + doc + CHANGELOG together.

## Acceptance criteria

- `apps/vault-api/wrangler.jsonc` `routes[]` contains exactly
  `zerovault.juanibiapina.dev` and `vault.apps.juanibiapina.dev` (bare
  `vault.juanibiapina.dev` removed).
- `apps/errors-api/wrangler.jsonc` `routes[]` contains exactly
  `zeroerrors.juanibiapina.dev` and `errors.apps.juanibiapina.dev` (bare
  `errors.juanibiapina.dev` removed).
- After deploy **and** the manual custom-domain removals, the old bare hosts no
  longer route to the worker (they no longer resolve — no DNS record).
- The `*.apps` web hosts still serve the SPA and allow login.
- The API hosts (`zerovault.` / `zeroerrors.`) are unaffected.
- `docs/plans/redirect-old-console-hosts.md` and
  `docs/plans/redirect-old-console-hosts-verify.md` are deleted.
- `docs/plans/subdomain-rename.md` carries the short "bare web hosts dropped"
  note.
- `tasks.md` no longer contains the stale "Redirect old console hosts to *.apps"
  section #1 (removed, or replaced with a one-line "done" pointer). No other
  `tasks.md` section changed.
- Both `wrangler.jsonc` files still parse and validate (see the dry-run /
  JSONC-parse check below) — the route edit did not leave malformed config.
- Root `CHANGELOG.md` has the dated, user-facing entry, committed with the edits.

### Proving it works (post-deploy + after manual removal)

```bash
# Old bare hosts no longer resolve / no longer reach the worker:
curl -sSI https://vault.juanibiapina.dev/   # DNS failure or no-route error, NOT a 200 from the worker
curl -sSI https://errors.juanibiapina.dev/  # DNS failure or no-route error, NOT a 200 from the worker
# (dig should show no record:)
dig +short vault.juanibiapina.dev
dig +short errors.juanibiapina.dev

# Canonical web hosts still serve the SPA (root + deep link) and expose Clerk:
curl -sI https://vault.apps.juanibiapina.dev/          | head -1   # 200
curl -sI https://vault.apps.juanibiapina.dev/projects  | head -1   # 200 (SPA shell)
curl -sI https://errors.apps.juanibiapina.dev/         | head -1   # 200
curl -sI https://errors.apps.juanibiapina.dev/issues   | head -1   # 200 (SPA shell)
# Then in a browser: sign in on each *.apps host completes (session established).

# API hosts unaffected:
curl -s https://zerovault.juanibiapina.dev/ping     # {"ok":true}
curl -s https://zeroerrors.juanibiapina.dev/ping    # {"ok":true}
```

### Local verification (dev box can't boot whole-repo `workerd`, per AGENTS.md)

The change is config-only (route lists). The package test/lint/typecheck runs
below only confirm surrounding code did not regress — they do **not** parse or
validate `wrangler.jsonc`, so a malformed JSONC (e.g. a stray comma from the
route deletion) would pass all of them and only surface at deploy. **Validate the
config edit itself first:**

```bash
# Validate the config the edit actually touched (bundles + parses config, no deploy):
pnpm --filter @zero/vault-api exec wrangler deploy --dry-run --outdir /tmp/vault-dry
pnpm --filter @zero/errors-api exec wrangler deploy --dry-run --outdir /tmp/errors-dry
```

If `wrangler deploy --dry-run` trips the NixOS `workerd` limitation on this box
(see `AGENTS.md` — the dev box can't boot `workerd`), fall back to at least
confirming the JSONC parses, e.g.:

```bash
# JSONC parse fallback (strips comments, then parses):
for f in apps/vault-api/wrangler.jsonc apps/errors-api/wrangler.jsonc; do
  node -e "const s=require('fs').readFileSync('$f','utf8').replace(/\/\/.*$/gm,'').replace(/\/\*[\s\S]*?\*\//g,''); JSON.parse(s); console.log('OK $f')"
done
```

In that fallback case, Cloudflare Workers Builds is the real gate for full config
validation.

Then run the touched packages to confirm nothing else regressed:

```bash
pnpm --filter @zero/vault-api run test && pnpm --filter @zero/vault-api run lint && pnpm --filter @zero/vault-api run typecheck
pnpm --filter @zero/errors-api run test && pnpm --filter @zero/errors-api run lint && pnpm --filter @zero/errors-api run typecheck
```

Rely on GitHub Actions CI and the Cloudflare deploy for the `workerd`-backed
whole-repo suites.
