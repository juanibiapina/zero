# Verify report: sweep-old-host-refs

Verifies `docs/plans/sweep-old-host-refs.md` — the audit claiming **zero live
references** to the dead bare console hosts `vault.juanibiapina.dev` /
`errors.juanibiapina.dev`, with no edits required (no-op confirmation).

## Verdict

**Conclusion holds: YES, zero live references.** The plan is correct. No
blockers, no concerns. The two bare dead hosts survive only in markdown history
(CHANGELOG, tasks.md tracker, `docs/plans/` archive). No source, config,
wrangler route, CI workflow, e2e fixture, `.dev.vars`/`.env`, or CORS allow-list
points at them. The kept API hosts `zerovault.` / `zeroerrors.` are correctly
untouched. No changelog entry is warranted.

## What I re-ran (independent sweep)

### 1. Word-boundary bare-host sweep (substring trap handled)

Pattern `(?<![a-z.])(vault|errors)\.juanibiapina\.dev --pcre2`. The negative
lookbehind excludes `zerovault.`/`zeroerrors.` (preceded by `o`) and
`vault.apps.`/`errors.apps.` (next label is `apps`, not `juanibiapina`).

Bare-host hits (line counts) appear in exactly **10 files, all markdown**:

| File | lines w/ hit | class |
|---|---:|---|
| `CHANGELOG.md` | 2 | (c) historical |
| `tasks.md` | 1 | (c) historical |
| `docs/plans/clerk-repoint.md` | 8 | (c) |
| `docs/plans/console-signin-redirect.md` | 29 | (c) |
| `docs/plans/drop-old-console-hosts.md` | 19 | (c) |
| `docs/plans/drop-old-console-hosts-verify.md` | 3 | (c) |
| `docs/plans/split-agent-changelog.md` | 1 | (c) |
| `docs/plans/subdomain-rename.md` | 19 | (c) |
| `docs/plans/unified-console-design.md` | 8 | (c) |
| `docs/plans/sweep-old-host-refs.md` | 5 | (c) the plan itself |

Cross-check of every `juanibiapina.dev` host form in the repo (broad grep):
`vault.` 18, `zerovault.` 13, `errors.` 13, `zeroerrors.` 9, `zero.` 6,
`vault.apps.` 5, `errors.apps.` 5, `accounts.apps.` 5, `clerk.zerovault.` 1,
`clerk.apps.` 1. The bare-vs-API split is clean; the word-boundary pattern
isolates the dead hosts correctly.

### 2. Live-guidance check (the class the plan might have wrongly dismissed)

Confirmed **no live how-to / setup doc / runbook** sends anyone to the dead host:

- Top-level `docs/*.md` (non-plans): **zero** bare-host hits.
- All `AGENTS.md` files: **zero** bare-host hits.
- All `README` files: **zero** bare-host hits.
- The only non-`docs/plans` hits are `CHANGELOG.md` and `tasks.md`, both
  historical status records, not pointers:
  - `CHANGELOG.md:7` (2026-07-22): announces the retirement, naming the dead
    hosts only to say they are gone and that the products now live at
    `vault.apps` / `errors.apps`. Correct, user-facing, KEEP.
  - `CHANGELOG.md:13` (2026-07-21): superseded dated entry; immutable history.
  - `tasks.md:6`: "Done — the old bare web hosts ... were dropped ..." — a
    tracker line recording completion plus the remaining manual Cloudflare step.
    Factual status, not guidance. KEEP.
- `docs/plans/` is an archive by location/purpose; several files already carry
  an explicit "later dropped by drop-old-console-hosts.md" note (e.g.
  `subdomain-rename.md:242-243`), so the archive is internally consistent. Not
  live guidance.

### 3. Source / config / CI / e2e / env / CORS — nothing missed

- Bare host in non-md, non-docs files: **none** (`rg ... -g '!*.md' -g '!docs/**'`
  → no matches).
- Repeated including hidden **and gitignored** files (`-uu`, covering the four
  `.dev.vars` and the `.env*` files that rg would otherwise skip): still
  **none** outside markdown. The `.dev.vars`/`.env*` files contain no
  `juanibiapina.dev` host at all.
- `apps/*/wrangler.jsonc` routes: only kept API hosts and canonical `*.apps`
  hosts — `zeroerrors.juanibiapina.dev` + `errors.apps.juanibiapina.dev`
  (errors-api), `zerovault.juanibiapina.dev` + `vault.apps.juanibiapina.dev`
  (vault-api), `zero.juanibiapina.dev` (agent-api). No bare dead host.
- `packages/ui/src/products.ts:14-15`: `PROD_VAULT_URL` / `PROD_ERRORS_URL`
  point at `vault.apps.` / `errors.apps.` (canonical). Unchanged.
- CORS: `apps/vault-api/src/app.ts:59` and `apps/errors-api/src/app.ts:60` use
  `origin: "*"` (wildcard). No hardcoded bare-host allow-list.
- `packages/agent-e2e`: **zero** `juanibiapina` references.
- Kept API-host references (`packages/zerovault-cli` `DEFAULT_BASE_URL`,
  `apps/agent-api/src/reporting/zero-errors.ts` `ENDPOINT` + its test) match the
  class (d) list and are correctly out of scope.

### 4. Changelog call

Correct: no code/config/behavior change here (literally zero edits), so nothing
user-observable. Per `AGENTS.md`, no entry. The user-visible retirement was
already captured at `CHANGELOG.md:7` when the hosts were dropped.

## Findings

### Blockers

None.

### Concerns

None.

### Nits

1. **Count wording.** The plan reports "108 occurrences across 9 files" from an
   earlier run; a fresh `rg -c` shows the plan's own file
   (`sweep-old-host-refs.md`, +5 lines) now also matches, so the current tally
   is 10 files. `rg -c` counts matching lines, not raw occurrences, so the exact
   "108" is not reproducible without the original per-line multiplicity. Purely
   cosmetic; does not affect classification or the conclusion.
2. **tasks.md vs Context tension.** `tasks.md:6` lists a still-pending manual
   Cloudflare step ("delete the two Worker Custom Domains ... so the old hosts
   stop resolving"), while the plan's Context says the custom domains + DNS "are
   gone" and hosts "now return 530." This is about external Cloudflare state, not
   any repo reference, so it does not affect the "zero live references in the
   repo" conclusion. Worth reconciling the tracker if the manual deletion has
   since happened.

## Bottom line

- Files with any bare dead-host reference: **10**, all markdown, all class (c)
  historical/subject-matter.
- Live references (source/config/CI/e2e/env/CORS/README/AGENTS/setup docs):
  **0**.
- Blockers: **0**. Concerns: **0**. Nits: **2** (cosmetic).
- The plan's "no-op confirmation / no changelog" call is correct as written.
