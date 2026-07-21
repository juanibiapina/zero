# ZeroVault / ZeroErrors relocation

ZeroVault (`zerovault-api` + web) and ZeroErrors (`zeroerrors-api` + web) live
in this monorepo under `@zero/{vault,errors}-*`, plus shared `@zero/auth`,
`@zero/ui`, and the published `zerovault-cli`. Worker names, KV ids, DO classes,
migration tags, rate limits, and custom domains are copied verbatim from
trippycards so the live production state is untouched.

## Ops context

- Workers: `zerovault-api` (`zerovault.juanibiapina.dev`), `zeroerrors-api`
  (`zeroerrors.juanibiapina.dev`).
- Shared KV `APIKEYS` id `7c218b09...` (same id on both workers, intentional).
- DOs: vault `OrgDO` + `ProjectVaultDO` (migrations v1/v2/v3, v3 deletes the old
  `VaultDO`); errors `ErrorsDO` (migration v1). Never rename these or the
  migration tags: doing so orphans production data.
- Secrets projects (ZeroVault): `zerovault` / `zerovault-web` and `zeroerrors` /
  `zeroerrors-web`, wired in `bin/fetch-secrets` and `bin/sync-secrets-to-cloudflare`.
  `MASTER_KEY` on `zerovault-api` encrypts every stored secret; do not rotate it.

## Deploy cutover (Phase 6) — DONE

Both workers auto-deploy from `zero` `main` via this repo's Cloudflare Workers
Builds connection. Build configs (per worker): branch `main`, build
`pnpm run build`, deploy `pnpm -F @zero/vault-api run deploy` /
`pnpm -F @zero/errors-api run deploy`, root `/`, non-production-branch builds
off. Pushing `main` triggers a build per worker and updates the existing workers
in place (names/bindings unchanged, so DO state, KV, and secrets persist).
Verified live: `zerovault.juanibiapina.dev/ping` and
`zeroerrors.juanibiapina.dev/ping` return `{"ok":true}`.

Note: trippycards never used Workers Builds for these; it deploys them via its
own `wrangler` CI (`Manually deployed` in the version history). So there was no
trippycards build trigger to disable — trippycards stops deploying them once
Phase 7 removes the source and `bin`/CI references there.

**Build-time web env vars.** The dashboards read `VITE_CLERK_PUBLISHABLE_KEY`
(baked into the bundle by Vite at build time). The Workers Build runs
`pnpm run build` but not `bin/fetch-secrets`, so this must be set as a **Workers
Build variable** on each api's build config (as `zero-api` does), not just in
ZeroVault. Both `zerovault-api` and `zeroerrors-api` build configs have
`VITE_CLERK_PUBLISHABLE_KEY = pk_live_...` (the public key shared by both
dashboards' Clerk instance). Missing it makes the deployed dashboard throw "Add
your Clerk Publishable Key". GitHub CI's `Build & Validate` is unaffected: it
runs `bin/fetch-secrets` first, which writes the web apps' `.env.production`.

## Pending
## Remove from trippycards (Phase 7) — DONE

trippycards PR #155 removed the 8 product dirs (kept `zerovault-cli`), their
`turbo.json` edges, `bin/*` references, and stale docs; merged to trippycards
`main` with CI green. trippycards no longer builds or deploys these products.

## Follow-up

- **ESLint convergence — DONE.** All relocated packages now use the strict
  shared `@zero/eslint-config` / `./react` presets; the `legacy*` presets are
  deleted. Root cause of the earlier blocker: the mobile app's `jest-expo` pulls
  `@types/jsdom` into the monorepo, and eslint's `projectService` (tsserver)
  loads its `/// <reference lib="dom" />`, typing `Response.json()` as DOM's
  `any` in test files (tsc correctly sees `unknown`). This can't be blocked by a
  `tsconfig` `types` array or a separate test tsconfig (the reference is forced
  by any loaded `@types/jsdom`), and aligning `jsdom` is a mobile risk. Chosen
  fix: worker **source** gets full strict type-aware linting (real issues fixed —
  floating promises, redundant assertions, Clerk context variance); worker **test
  files** relax only the `res.json()`-affected rules (`no-unnecessary-type-assertion`,
  `no-unsafe-*`) with a documented override. React web apps use the strict
  `./react` preset with the newer experimental react-hooks rules
  (`set-state-in-effect`, `purity`, `immutability`, `preserve-manual-memoization`)
  set to **warn** — the standard migration posture. Remaining as warnings (not
  blocking): a few `set-state-in-effect` / `exhaustive-deps` in the web pages,
  worth a focused pass with the apps running.
- **zerovault-cli dedup — DONE.** Both repos consume the published
  `zerovault-cli@0.2.0` via `pnpm dlx`; trippycards' local copy is removed
  (trippycards PR). The CLI source is the `zero` repo's copy — publish future
  changes from there (one cosmetic lint fix in `vault-transfer.ts` is currently
  ahead of the published `0.2.0`; publish a patch when convenient).
- **Worker test secrets (`.dev.vars`) — root cause.**
  `@cloudflare/vitest-pool-workers` loads only `main`, compatibility settings,
  and bindings/`vars` from the wrangler config; it has **no `.dev.vars`/dotenv
  handling** (confirmed against the package and the Jul 2026 config docs). So the
  relocated tests could not get `MASTER_KEY` from the fetched `.dev.vars`. Fix
  (applied): a deterministic test `MASTER_KEY` in `apps/vault-api/wrangler.test.jsonc`
  `vars` — self-contained and the supported mechanism. Guidance: any future
  worker test needing a secret must put a **test value in the test config `vars`**,
  never rely on `.dev.vars`.
- **Wrangler/toolchain skew.** vault/errors run wrangler `4.103.0` and
  `@cloudflare/vitest-pool-workers` `0.18.5` (pinned to keep the existing patch
  valid and match the committed `worker-configuration.d.ts`). Realign when the
  agent app moves off the 4.103 patch.
