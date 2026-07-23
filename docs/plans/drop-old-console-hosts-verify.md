# Verify: drop the old bare console web hosts

Adversarial review of `docs/plans/drop-old-console-hosts.md`, verified against the
repo (2026-07-22), the `cloudflare` skill, and known wrangler behavior.

**Verdict:** the plan is sound and safe to execute. No blockers. Two concerns
(one omission, one framing), three nits.

Counts: **0 blocker / 2 concern / 3 nit**.

---

## Verified correct

### Route entries to delete + entries to keep (plan check #1) — CORRECT

`apps/vault-api/wrangler.jsonc:69-80` has exactly three routes:

```jsonc
{ "pattern": "zerovault.juanibiapina.dev",  "custom_domain": true },  // KEEP (API)
{ "pattern": "vault.juanibiapina.dev",      "custom_domain": true },  // DROP (bare web)
{ "pattern": "vault.apps.juanibiapina.dev", "custom_domain": true }   // KEEP (canonical web)
```

`apps/errors-api/wrangler.jsonc:56-67` is symmetric (`zeroerrors.` / `errors.` /
`errors.apps.`). The plan's drop/keep classification matches the files exactly.

### Nothing in-repo depends on the bare hosts (plan check #3) — CORRECT

Grep across the repo (excluding `docs/plans`) confirms:

- **CORS:** both APIs use `origin: "*"` — `apps/vault-api/src/app.ts:58-59`,
  `apps/errors-api/src/app.ts:59-60`. No host allowlist to touch.
- **Web cross-links:** `packages/ui/src/products.ts:14-15` point at the `*.apps`
  hosts. No bare-host reference.
- **API consumers** all use the API hosts, never the bare web hosts:
  `packages/zerovault-cli/src/index.ts:30` (`zerovault.`),
  `apps/agent-api/src/reporting/zero-errors.ts:16` + its test (`zeroerrors.`).
- **No in-repo Clerk** `isSatellite`/`domain`/allowed-origins config references
  the bare hosts (Clerk origin state is out-of-repo dashboard config).
- **No redirect code exists** in either worker (`rg` for `redirect|308|301|Location`
  in `apps/*-api/src` returns nothing). The redirect approach this plan supersedes
  was only ever planned, never built — so there is no worker code to remove.

Dropping the bare hosts breaks no in-repo consumer. Confirmed.

### Automatic-vs-manual DNS claim (plan check #2) — CORRECT

> **DISPROVEN (2026-07-23):** this verdict was later disproven. Removing a
> `custom_domain` route and deploying auto-deletes the domain and its DNS record;
> no manual delete is needed. See the correction in `drop-old-console-hosts.md`
> and `docs/workers-ops.md`.


The plan claims: removing a `custom_domain` entry from `routes[]` and redeploying
does **not** auto-detach the custom domain or delete its DNS; the detach is a
manual dashboard action; deleting the Worker Custom Domain also deletes the
auto-created proxied DNS record. This matches known wrangler behavior
(wrangler 4.103.0 here, per `apps/vault-api/package.json:35`):

- `wrangler deploy` is **additive** for custom domains: it provisions custom
  domains present in config, but does not tear down a custom domain that has
  disappeared from config. The orphaned domain keeps resolving to the worker.
- A Worker Custom Domain auto-creates a proxied DNS record when added; removing
  the custom domain deletes that record, so the host stops resolving.

The claim is also **fail-safe**: even if a future wrangler auto-detached the
dropped domain, the manual dashboard removal would be a harmless no-op. The
config-first / manual-removal-second ordering is right — leaving the host in
config would let the next Workers Build deploy re-provision it.

Caveat recorded as nit #2 below: the loaded `cloudflare` skill references do not
explicitly document this removal gotcha, so the claim rests on general wrangler
behavior rather than a citable skill line.

### Deploy safety (plan check #7) — CORRECT

Routes are independent. Dropping one `custom_domain` entry does not affect the
kept entries or the `*.apps` serving. A deploy with narrowed `routes[]` succeeds:
wrangler provisions the two remaining domains and ignores the extra domain still
attached in Cloudflare (extra/orphaned domains do not fail a deploy). No risk to
the deploy or to `*.apps` serving.

### Changelog routing (plan check #4) — CORRECT

This is a console change, so the root `CHANGELOG.md` is right (per `AGENTS.md`;
agent changelog is only for `apps/agent-api`). The proposed entry's date
(`2026-07-22`) and `- YYYY-MM-DD: ...` format match the existing top entries
(`CHANGELOG.md:7-11`). Goes on top, above the current 2026-07-22 lines.

### Superseded redirect plan files (plan check #6) — CORRECT

Both `docs/plans/redirect-old-console-hosts.md` and
`docs/plans/redirect-old-console-hosts-verify.md` exist and the plan deletes both
explicitly.

### Host-awareness reasoning — CORRECT

Both workers serve SPA + API on every attached host via the assets binding with
`run_worker_first: ["/ping", "/v1/*", "/api/*"]` (path-based, no host awareness).
So which hostnames a worker answers on is governed only by `routes[]`. The plan's
core premise holds.

---

## Concerns

### Concern 1 — `tasks.md` item #1 is the same abandoned redirect approach and is not cleaned up

`tasks.md:5-9` ("## 1. Redirect old console hosts to *.apps") is a live, open
follow-up that:

- describes the **abandoned redirect** approach this plan supersedes,
- asserts the bare hosts "still serve the SPA" and "Keep custom domains attached
  so the redirect can fire" — the exact opposite of this plan's outcome.

The plan cleans up the two superseded redirect **plan files** and adds a note to
`subdomain-rename.md`, but omits `tasks.md`. After this change, `tasks.md` #1 is
stale and directly contradicts the shipped reality (hosts dropped, not
redirected; custom domains detached, not kept).

**Fix:** in the same change, remove `tasks.md` section #1 (or rewrite it to
"Done — old bare web hosts dropped, see `docs/plans/drop-old-console-hosts.md`").
Add this to the plan's "Docs to update" and to the acceptance criteria.

### Concern 2 — local verification does not exercise the actual change

The only thing this change touches is `wrangler.jsonc` `routes[]`. The plan's
local commands (`pnpm --filter ... test/lint/typecheck` on the two `-api`
packages) do not parse or validate the wrangler config at all — they only confirm
unrelated code did not regress. So the "local verification" proves nothing about
the edit itself; a malformed JSONC (e.g. a stray/removed comma) would pass all
listed local checks and only surface at deploy time.

**Fix:** add a config-parse check that does not need whole-repo `workerd`, e.g.
`pnpm --filter @zero/vault-api exec wrangler deploy --dry-run --outdir /tmp/vault-dry`
(and the errors equivalent). Dry-run bundles/validates config without deploying.
If even dry-run trips the NixOS `workerd` limitation on this box, at minimum
validate the JSONC parses (`node -e` / `jsonc` lint) and state that Cloudflare
Workers Builds is the real gate. Note this is a nit-adjacent concern: the
post-deploy `curl`/`dig` proofs do cover the real outcome.

---

## Nits

### Nit 1 — dashboard nav labels drift; describe the manual step by function too

The manual step names "Settings -> Domains & Routes". Cloudflare dashboard labels
have changed repeatedly (Triggers / Domains & Routes / Settings). Correct today;
add the functional description ("remove the Worker Custom Domain for
`vault.juanibiapina.dev` on worker `zerovault-api`; this also deletes its proxied
DNS record") so the step survives a UI relabel. The plan already states the DNS
side effect — reinforce it in the step itself.

### Nit 2 — the wrangler removal behavior is not citable from the loaded `cloudflare` skill

The `cloudflare` skill references document adding `custom_domain` routes
(`references/wrangler/configuration.md:47`) but not the "removal is not
auto-detached" gotcha the plan leans on. The behavior is correct (see verified
section) but the plan presents it as settled fact. Consider a one-line source
(Cloudflare "Routes and domains" docs, or the wrangler custom-domains page) next
to the claim so a future reader can re-check it. Non-blocking; the claim is
fail-safe.

### Nit 3 — historical CHANGELOG line left stale (acknowledged, acceptable)

`CHANGELOG.md:12` (2026-07-21) still reads products "live at
vault.juanibiapina.dev and errors.juanibiapina.dev". The plan deliberately leaves
historical dated entries as-is, and line 7 already supersedes it. Correct call;
flagged only so it is a conscious decision, not an oversight. No change needed.

---

## Acceptance-criteria assessment (plan check #5)

Sufficient and provable, with the Concern-1 addition:

- Old hosts no longer resolve: `curl -sSI` (expect DNS/no-route failure, not a
  200) + `dig +short` (expect empty). Provable post-deploy + post-manual-removal.
- `*.apps` still serve SPA (root + deep link) + login: `curl -sI` for 200s;
  login itself needs a manual browser check (cannot be curl'd — inherent, fine).
- API hosts intact: `curl -s .../ping` -> `{"ok":true}`. Provable.
- File-state criteria (routes contain exactly the two kept hosts; redirect plan
  files deleted; subdomain-rename note; CHANGELOG entry) are all checkable in the
  diff. **Add:** `tasks.md` #1 removed/updated (Concern 1).

Local-verification path is right in principle given the dev-box `workerd`
limitation, but strengthen it per Concern 2 so the config edit itself is
validated, not just the surrounding packages.
