# Plan: sweep and clean up dead old-console-host references

## Goal

Zero loose ends: no live code, config, or user-facing doc points at the dead
bare web hosts `vault.juanibiapina.dev` / `errors.juanibiapina.dev`. Every such
reference is either updated to the canonical `*.apps` host or removed as
obsolete. Historical records (past CHANGELOG entries, superseded docs/plans) may
KEEP their mentions but must be clearly historical, not live guidance.

## Context

The old bare console web hosts `vault.juanibiapina.dev` and
`errors.juanibiapina.dev` were dropped in commit `ed9e4c8` (deployed; their
Cloudflare custom domains + DNS are gone, hosts now return 530). The API hosts
`zerovault.juanibiapina.dev` / `zeroerrors.juanibiapina.dev` are KEPT and must
NOT be touched (they back `zerovault-cli` `DEFAULT_BASE_URL` and the agent-api
`zero-errors` reporter `ENDPOINT`). Canonical web hosts are
`vault.apps.juanibiapina.dev` / `errors.apps.juanibiapina.dev`.

## Sweep result — headline

**No live references exist.** Every occurrence of the bare dead hosts is either
a dated CHANGELOG entry, an archived point-in-time plan under `docs/plans/`, or
the `tasks.md` tracker line that records the drop as done. No source code, no
worker config (`wrangler.jsonc`), no CI/workflow yaml, no `.dev.vars`/env
defaults, no CORS/allowed-origins, no test fixture, and no e2e mock server
points at the dead hosts. This plan is therefore a **no-op confirmation**: it
documents what was searched, classifies every hit, and defines acceptance
criteria. No edits are required.

This reconciles with the earlier verify
(`docs/plans/drop-old-console-hosts-verify.md`), which already concluded nothing
depends on the bare hosts and explicitly flagged the one stale historical
CHANGELOG line (2026-07-21) as an accepted, conscious "leave as history" call
(its Nit 3).

## What was searched

Ripgrep across the whole repo for the exact bare hosts, using a word-boundary
pattern that excludes the `zerovault` / `zeroerrors` API hosts and the canonical
`*.apps` hosts:

```
rg -n '(?<![a-z.])(vault|errors)\.juanibiapina\.dev' --pcre2
```

Coverage confirmed for: all source (`apps/*`, `packages/*`), worker configs
(`apps/*/wrangler.jsonc`), CI/workflow yaml, READMEs, `docs/` (including
`docs/plans/`), root `CHANGELOG.md` and `apps/agent-api/CHANGELOG.md`, e2e
package (`packages/agent-e2e`), and the CORS setup in each API's `app.ts`.

Specific negative confirmations:

- Source/config/CI, excluding markdown/docs: **zero** bare-host hits
  (`rg ... -g '!docs/**' -g '!*.md'` → NONE).
- `apps/vault-api/src/app.ts` and `apps/errors-api/src/app.ts` CORS use
  `origin: "*"` (wildcard) — no hardcoded bare-host origin allow-list.
- `packages/ui/src/products.ts` already points at the canonical hosts:
  `PROD_VAULT_URL = "https://vault.apps.juanibiapina.dev"`,
  `PROD_ERRORS_URL = "https://errors.apps.juanibiapina.dev"`.
- `packages/agent-e2e`: no bare-host references.
- `packages/zerovault-cli/src/index.ts:30` and
  `apps/agent-api/src/reporting/zero-errors.ts:16` reference the KEPT API hosts
  (`zerovault.` / `zeroerrors.`) — correct, untouched.

## Full classified hit list

Classification key: (a) LIVE, update to `*.apps`; (b) LIVE, remove as obsolete;
(c) HISTORICAL, leave as-is; (d) API-host false positive, ignore.

Bare-host occurrence counts per file (the only files with any bare-host match):

| File | Bare-host occ. | Class | Notes |
|---|---:|---|---|
| `docs/plans/console-signin-redirect.md` | 32 | (c) | Archived plan; describes the consoles as served on the bare hosts at the time. |
| `docs/plans/subdomain-rename.md` | 23 | (c) | Archived plan that introduced the bare hosts; already carries a "later dropped by drop-old-console-hosts" note (lines ~241–242). |
| `docs/plans/drop-old-console-hosts.md` | 21 | (c) | The plan that dropped the hosts; mentions are the subject matter. |
| `docs/plans/unified-console-design.md` | 11 | (c) | Archived design doc; point-in-time recommendation to move to the bare hosts. |
| `docs/plans/clerk-repoint.md` | 9 | (c) | Archived plan; lists bare hosts as allowed origins during that cutover. |
| `docs/plans/drop-old-console-hosts-verify.md` | 4 | (c) | The verify report for the drop; mentions are the subject matter. |
| `CHANGELOG.md` | 4 | (c) | Two dated entries (see below). |
| `tasks.md` | 2 | (c) | Tracker line recording the drop as done + the remaining manual Cloudflare step. |
| `docs/plans/split-agent-changelog.md` | 2 | (c) | Archived plan quoting the 2026-07-21 changelog line verbatim. |

Total bare-host occurrences: **108**, across **9 files**, all class (c).

`CHANGELOG.md` detail (both lines are dated, immutable history):

- Line 7 (2026-07-22): announces the retirement — "The old Vault and Errors
  addresses (vault.juanibiapina.dev, errors.juanibiapina.dev) have been retired;
  the products now live only at vault.apps.juanibiapina.dev and
  errors.apps.juanibiapina.dev." This is correct, user-facing, and names the
  dead hosts only to say they are gone. KEEP.
- Line 13 (2026-07-21): "Vault and Errors now share the Zero brand and a product
  switcher, and live at vault.juanibiapina.dev and errors.juanibiapina.dev." A
  superseded dated entry; line 7 above it corrects the record. Per changelog
  convention, past dated entries are immutable history. KEEP.

API-host false positives found by the broader (non-word-boundary) grep, listed
here so they are explicitly accounted for and NOT touched — class (d):

- `packages/zerovault-cli/src/index.ts:30` — `DEFAULT_BASE_URL = "https://zerovault.juanibiapina.dev"`.
- `apps/agent-api/src/reporting/zero-errors.ts:16` + `...zero-errors.test.ts:34` — `zeroerrors.juanibiapina.dev/v1/errors`.
- `apps/vault-api/wrangler.jsonc:70` — `zerovault.juanibiapina.dev` route.
- `apps/errors-api/wrangler.jsonc:57` — `zeroerrors.juanibiapina.dev` route.
- `AGENTS.md:69–70`, `docs/secrets.md`, `docs/zeroerrors/design.md`,
  `docs/vault-errors-relocation.md`, and many `docs/plans/*` lines referencing
  `zerovault.` / `zeroerrors.` / `clerk.zerovault.` — all API/Clerk hosts.

## Proposed edits

None. There are no class (a) or class (b) hits.

## Intentionally left (class c / d) and why

- **`docs/plans/*` (8 files):** `docs/plans/` is an archive of point-in-time
  plans and their verify reports. They are historical by location and purpose;
  they are not live guidance and no user or tool reads them as a source of
  current hostnames. Rewriting them would falsify the record of what was decided
  when. Leave as-is. (Several already carry an explicit "later dropped" note, so
  the archive is internally consistent.)
- **`CHANGELOG.md` lines 7 and 13:** dated, immutable changelog history. Line 7
  is the correct retirement announcement; line 13 is superseded by it. Leave as-is.
- **`tasks.md`:** the bare-host mention records that the hosts *were dropped* and
  names the remaining manual Cloudflare cleanup; it is factual/historical status,
  not a pointer telling anyone to use the dead hosts. Leave as-is.
- **All API-host hits (class d):** `zerovault.` / `zeroerrors.` / `clerk.zerovault.`
  are KEPT hosts (or superseded Clerk-domain history) and are out of scope by the
  task's explicit constraint. Do not touch.

## Changelog

**No changelog entry warranted.** There is no code, config, or behavior change
in this task — nothing a user can observe. Per `AGENTS.md`, purely internal
work (and here, literally zero changes) gets no entry. The user-visible
retirement was already captured in `CHANGELOG.md` line 7 (2026-07-22) at the
time the hosts were dropped.

## Acceptance criteria

- A final sweep `rg -n '(?<![a-z.])(vault|errors)\.juanibiapina\.dev' --pcre2`
  returns hits ONLY in: `docs/plans/*.md`, `CHANGELOG.md`, and `tasks.md`
  (historical), plus API-host lines (`zerovault.` / `zeroerrors.` /
  `clerk.zerovault.`, class d) — and **none** in `apps/*` source, `packages/*`
  source, any `wrangler.jsonc`, any `.github/workflows/*.yml`, any `.dev.vars`
  example, or `packages/agent-e2e`.
- `packages/ui/src/products.ts` continues to point at
  `vault.apps.juanibiapina.dev` / `errors.apps.juanibiapina.dev`.
- The KEPT API-host references (`zerovault-cli` `DEFAULT_BASE_URL`, agent-api
  `zero-errors` `ENDPOINT` + its test, both API `wrangler.jsonc` routes) are
  unchanged.

## Skills to use

- None required — this is a documentation/confirmation deliverable with no code
  change. If a future decision reverses the "leave archives as-is" call, load
  `changelog` before touching any changelog file and `git-commit` when committing.
