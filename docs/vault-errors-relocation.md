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

## Pending (not done in the code move)

- **Deploy cutover (Phase 6).** In this repo's Cloudflare Workers Builds
  connection, add a build config for each existing worker (`zerovault-api`,
  `zeroerrors-api`): branch `main`, build `pnpm run build`, deploy
  `pnpm -F @zero/vault-api run deploy` / `pnpm -F @zero/errors-api run deploy`.
  These target the already-existing workers by name (in-place update, no new
  namespaces). Then disable the trippycards build triggers for these two workers
  so both connectors do not race. Verify with `wrangler deployments list` and the
  build log (watch for a silent `No projects matched`). Smoke-test `/ping` on both
  domains. Deploy vault first (the repo bootstraps secrets from it).
- **Remove from trippycards (Phase 7).** Delete the 9 dirs there, their
  `turbo.json` edges, `bin/*` references, and connector triggers; confirm
  trippycards CI still passes. Separate commit in that repo.

## Follow-up

- **ESLint convergence.** The relocated packages use the looser
  `@zero/eslint-config/legacy` and `legacy-react` presets (non-type-checked),
  matching the config they were written under. Converge them onto the strict
  shared `.` / `./react` presets (`recommendedTypeChecked`) and delete
  `packages/eslint-config/legacy*.js`. The strict pass surfaces floating/misused
  promises, unsafe-any at `cloudflare:test`/JSON boundaries, and react
  set-state-in-effect.
- **Wrangler/toolchain skew.** vault/errors run wrangler `4.103.0` and
  `@cloudflare/vitest-pool-workers` `0.18.5` (pinned to keep the existing patch
  valid and match the committed `worker-configuration.d.ts`). Realign when the
  agent app moves off the 4.103 patch.
