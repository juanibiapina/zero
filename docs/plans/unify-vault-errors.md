# Plan: bring ZeroVault and ZeroErrors into the `zero` monorepo

## Goal

Move the ZeroVault and ZeroErrors products (4 apps + their support packages) out
of `juanibiapina/trippycards` and into this `zero` repo, renamed onto the
`@zero/*` scope, so all three "zero" products (agent, vault, errors) live in one
monorepo and deploy from it. The two workers are **live in production**
(`zerovault.juanibiapina.dev`, `zeroerrors.juanibiapina.dev`) with real Durable
Object state, KV, and secrets. The move must preserve that state: same worker
names, binding IDs, DO class names, and migration tags. This is a source
relocation and deploy-pipeline cutover, not a rebuild.

**End state:** all three workers (`zero-api`/agent, `zerovault-api`,
`zeroerrors-api`) **auto-deploy on push to `zero` `main`** via this repo's
Cloudflare Workers Builds git connector, exactly as `zero-api` already does. Each
worker keeps its **existing production resources** - same Worker (updated in
place, not recreated), same DO namespaces, KV, secrets, custom domains. No new
Cloudflare resources are created; trippycards stops deploying these two workers.
Success = a push to `main` bumps the live version of all three workers in place,
with vault/errors DO state, KV, and secrets intact.

## Background found during research

**The zero-family subgraph in trippycards is self-contained.** These packages
depend only on each other and on the two shared config packages; nothing in
travel/transit/houses depends on them, and they don't depend on `@repo/core`. So
they lift out cleanly.

Move set (trippycards -> new name/dir in zero):

| trippycards package | trippycards dir | -> zero name | -> zero dir |
|---|---|---|---|
| `@repo/zerovault-api` | `apps/zerovault-api` | `@zero/vault-api` | `apps/vault-api` |
| `@repo/zerovault-web` | `apps/zerovault-web` | `@zero/vault-web` | `apps/vault-web` |
| `@repo/zeroerrors-api` | `apps/zeroerrors-api` | `@zero/errors-api` | `apps/errors-api` |
| `@repo/zeroerrors-web` | `apps/zeroerrors-web` | `@zero/errors-web` | `apps/errors-web` |
| `@repo/zerovault-core` | `packages/zerovault-core` | `@zero/vault-core` | `packages/vault-core` |
| `@repo/zeroerrors-core` | `packages/zeroerrors-core` | `@zero/errors-core` | `packages/errors-core` |
| `@repo/zero-auth` | `packages/zero-auth` | `@zero/auth` | `packages/auth` |
| `@repo/zero-ui` | `packages/zero-ui` | `@zero/ui` | `packages/ui` |
| `zerovault-cli` (unscoped, published to npm) | `packages/zerovault-cli` | **keep** `zerovault-cli` | `packages/zerovault-cli` |

Dependency edges within the set: `*-api` -> `@zero/auth` + its `*-core`; `*-web`
-> `@zero/ui` + its `*-core`. All also use the shared `@zero/eslint-config` and
`@zero/typescript-config` (already in this repo).

**Keep `zerovault-cli`'s published name unchanged.** This repo's
`bin/fetch-secrets` already consumes it as `pnpm dlx zerovault-cli@0.1.0`, and
ZeroVault is the secret store the whole repo bootstraps from. Renaming its npm
identity would be a breaking change to an external consumer.

**Version skew is small.** This repo was forked from the same base: it already
uses eslint 10.7.0, typescript 6.0.3, react 19.2.7, vite 8.1.5, vitest 4.1.10,
hono 4.12, zod 4, `do-orm@github:juanibiapina/do-orm`, matching the incoming
apps. The one real mismatch is **wrangler**: this repo pins `^4.103.0` with an
exact-version patch (`patches/wrangler@4.103.0.patch`), the incoming apps declare
`^4.111.0`. A single lockfile resolves one wrangler version; if it lands on 4.111
the 4.103 patch stops applying. Must align all apps to one wrangler version.

**The patch is Docker-only and inert here.** `patches/wrangler@4.103.0.patch`
only rewrites container image platform handling (`platform: "linux/amd64"`).
`agent-api` uses no containers, and neither do vault/errors, so the patch affects
nothing in this repo today. Retargeting it to 4.111 is not mechanical (context
offsets shift; likely needs a fresh `pnpm patch`). **Primary path: pin the
incoming apps down to `^4.103.0`** so the existing patch key stays valid and
untouched. Fallback: drop the patch entirely (safe, since nothing uses it) and
move everything to `^4.111.0`.

**Shared config content differs - the real friction point.**
`typescript-config` presets are byte-identical (only the package name differs),
so those extends map cleanly. But `eslint-config/index.js` differs: this repo
uses `recommendedTypeChecked` + prettier + `projectService`; trippycards uses
plain `recommended`. Adopting this repo's stricter shared config will likely
surface new type-checked lint errors (floating promises, unsafe-any, etc.) in the
incoming code. Plan for a lint-fix pass, with a fallback of a temporary looser
preset if the fix volume is large.

**Infra to preserve verbatim** (from the two `wrangler.jsonc`):
- Worker names `zerovault-api`, `zeroerrors-api` (never change - these identify
  the live workers and their DO namespaces).
- `vault-api`: KV `APIKEYS` id `7c218b09...`, DOs `OrgDO` + `ProjectVaultDO`,
  migrations v1/v2/v3 (v3 deletes the old `VaultDO`), rate limiter ns `2001`,
  custom domain `zerovault.juanibiapina.dev`, secrets
  `CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY`/`ENVIRONMENT`/`MASTER_KEY`.
- `errors-api`: same KV id, DO `ErrorsDO`, migration v1, rate limiter ns `3001`,
  custom domain `zeroerrors.juanibiapina.dev`, secrets minus `MASTER_KEY`.
- `MASTER_KEY` on `zerovault-api` encrypts every stored secret; it already lives
  on the production worker. Do not touch or rotate it.

**Deploy today:** both workers deploy via trippycards' Cloudflare Workers Builds
git connector (same Cloudflare account as `zero-api`, `4e04b64a...`). Each needs
its own build trigger because each has a distinct deploy command and web-build
dependency.

**No e2e tests to move** - trippycards' `@repo/e2e` doesn't cover these two
products. Unit/DO tests are colocated in each app (`src/**/tests`, `*.test.ts`)
and come with the source.

## What to change

### Naming decision (confirmed)

`@zero/{vault,errors}-{api,web,core}`, shared `@zero/auth` + `@zero/ui`, dirs
`apps/vault-*` / `apps/errors-*` / `packages/{auth,ui,vault-core,errors-core}`,
`zerovault-cli` unchanged. Matches the `@zero/agent-*` convention already
shipped. Worker names stay `zerovault-api` / `zeroerrors-api`.

History strategy: **plain copy** (drop trippycards history for these dirs). If
history matters, use `git filter-repo` subtree export instead (more work).

### Phase 0 - Remove the gobfile (first commit)

Delete `.config/gobfile.toml` and commit it on its own, before any of the move
work. Reconcile the fallout in the same commit:

- Update `AGENTS.md`: the "Dev Server" section describes a gob-auto-started dev
  server ("auto-started via gobfile ... check with `gob list`"). Rewrite it to
  start dev manually (`pnpm turbo dev`) and drop the `gob restart <job_id>`
  guidance. Keep the port-cleanup snippet (extended in Phase 4).
- This removes the auto-started dev job, so nothing else in the plan can lean on
  "the gobfile dev job already covers the new apps" - see the revised Phase 4
  note.

Do this first so the rest of the move lands on a clean, gob-free dev setup.

### Phase 1 - Copy source in

Copy the 9 directories to their new paths.

### Phase 2 - Rewrite identities and internal references

In every moved `package.json`: set the new `name`, and rewrite each
`workspace:*` dep key to its new name (`@repo/zero-auth`->`@zero/auth`,
`@repo/zero-ui`->`@zero/ui`, `@repo/zerovault-core`->`@zero/vault-core`,
`@repo/zeroerrors-core`->`@zero/errors-core`,
`@repo/eslint-config`->`@zero/eslint-config`,
`@repo/typescript-config`->`@zero/typescript-config`).

In source and config files, rewrite import specifiers and extends paths for the
renamed packages: TS/TSX imports of `@repo/zero-auth`/`@repo/zero-ui`/`@repo/*-core`,
`tsconfig.json` extends (`@repo/typescript-config/*` -> `@zero/typescript-config/*`),
`eslint.config.js` imports (`@repo/eslint-config` -> `@zero/eslint-config`). Leave
`zerovault-cli`'s own name alone.

**Do not touch** any `wrangler.jsonc` field except the `assets.directory`
relative path, which **must** change with the web-dir rename:
`../zerovault-web/dist` -> `../vault-web/dist` and `../zeroerrors-web/dist` ->
`../errors-web/dist`. Worker names, KV ids, DO classes, migration tags,
rate-limit ids, routes stay byte-identical. (Both `wrangler.jsonc` share the same
KV id `7c218b09...` on purpose - copy it verbatim, do not "deduplicate" it.)

### Phase 3 - Reconcile workspace, deps, config

- `pnpm-workspace.yaml`: globs already cover `apps/*` and `packages/*` (no
  change). This repo's `onlyBuiltDependencies` is only `@clerk/shared`, `esbuild`,
  `workerd`; trippycards also lists `@sentry/cli`, `better-sqlite3`,
  `core-js-pure`, `sharp`. Pre-add `better-sqlite3` and `sharp` (the incoming
  apps pull them); add `@sentry/cli`/`core-js-pure` only if they surface as
  build-script deps after install.
- **wrangler version + patch**: pick one version across all apps (agent-api,
  vault-api, errors-api). **Primary: pin the new apps down to `^4.103.0`** so the
  existing `patches/wrangler@4.103.0.patch` key stays valid. The patch is
  Docker/container-only and inert here (nothing uses containers), so the fallback
  is to drop it and move all apps to `^4.111.0`. Do not attempt to hand-retarget
  the patch to 4.111.
- Adopt this repo's shared `@zero/eslint-config` and `@zero/typescript-config`;
  drop the trippycards config packages (not copied).
- `pnpm install` to rebuild the lockfile.

### Phase 4 - Wire build/dev/deploy config

- `turbo.json`: copy trippycards' per-app edges - both `@zero/vault-api#test`
  and `#deploy` depend on `@zero/vault-web#build`; same for errors. (Note: this
  repo's `@zero/agent-api` only has a `#deploy` edge, not a `#test` edge, so this
  is copying trippycards' edges, not mirroring the agent app. The `#test` edge is
  needed because the api tests rely on the web `dist` for the assets binding.)
- Dev ports. Baseline in this repo: agent-api `8790` / inspector `9232`,
  agent-web vite `5176`. Incoming: vault-api `8790`/`9231` + vault-web `5176`;
  errors-api `8791`/`9234` + errors-web `5177`. Only **vault** collides
  (`8790` and `5176`); errors ports and all inspectors (`9231`/`9234` vs `9232`)
  are already clear. **Critical coupling:** each web app's vite config has a
  proxy `target` hard-wired to its api's port (`http://localhost:8790` for
  vault-web, `:8791` for errors-web). Moving an api port without moving its
  web's proxy target makes that web dev server silently proxy to the wrong
  worker (vault-web would hit **agent-api** on 8790). Change api port + inspector
  + web `server.port` + web proxy `target` together, as a set.

  Target map (only vault moves; errors stays):

  | app | api port | inspector | web vite port | web proxy target |
  |---|---|---|---|---|
  | agent | 8790 | 9232 | 5176 | (unchanged) |
  | vault | **8792** | **9233** | **5178** | **http://localhost:8792** |
  | errors | 8791 | 9234 | 5177 | http://localhost:8791 |

  Touch points per app: `dev` and `dev:local` in `package.json` (both carry the
  `--port`/`--inspector-port`), and `server.port` + every proxy `target` in
  `vite.config.ts`. Document this table in `AGENTS.md` alongside the existing
  5176/8790.
- `bin/ci` and `bin/deploy`: add `pnpm --filter @zero/vault-api run cf-typegen`
  and `@zero/errors-api` (mirror trippycards).
- `bin/fetch-secrets`: add the ZeroVault downloads for the new apps (projects
  `zerovault`, `zerovault-web`, `zeroerrors`, `zeroerrors-web` - same project
  names trippycards uses) writing to the new dirs' `.dev.vars` / `.env` /
  `.env.production`.
- `bin/sync-secrets-to-cloudflare`: add bulk-secret pushes for `apps/vault-api`
  and `apps/errors-api`.
- Dev startup: the gobfile is gone (Phase 0), so dev is started manually with
  `pnpm turbo dev` (unfiltered), which launches **all six** dev servers (3 apis +
  3 webs). Nothing to wire here; just expect 6 persistent processes.
- `AGENTS.md` local-setup section: the port-cleanup snippet only kills `5176` and
  `8790`. Extend it to the full set so a stuck run can be cleared:
  `for p in 5176 5177 5178 8790 8791 8792; do lsof -ti :$p | xargs -r kill -9; done`.

### Phase 5 - Local verification

`gob run bin/ci` (build, lint, typecheck, test across the enlarged workspace).
Expect and fix lint fallout from the stricter shared eslint config (Phase 2
friction). If the fix volume is unreasonable, fall back to giving the incoming
apps a local looser eslint preset and file a follow-up to converge. Run each
app's `wrangler deploy --dry-run` to confirm configs resolve.

### Phase 6 - Deploy pipeline cutover (highest risk, do carefully)

Goal of this phase: `zerovault-api` and `zeroerrors-api` **auto-deploy on push to
`zero` `main`**, updating the existing production workers in place, from exactly
one place, without a gap or a double-deploy race. This mirrors how `zero-api`
(agent) already auto-deploys from this repo; we are adding two more workers to the
same connector, not changing agent's setup.

1. In this repo's Cloudflare Workers Builds connection (UUID `7930fab5...`, repo
   `zero`), add a build config for **each** of the two existing Workers
   (`zerovault-api`, `zeroerrors-api`) - one per Worker, same as agent-api has its
   own. Branch `main`, build command `pnpm run build`, deploy commands
   `pnpm -F @zero/vault-api run deploy` and `pnpm -F @zero/errors-api run deploy`.
   These target the **already-existing** Workers by name, so a push updates them
   in place (no new Worker, no new namespaces). A push to `main` then fires all
   three workers' builds independently. (Learned on the agent rename: the
   connector's deploy command is dashboard/API config, not in-repo, and a stale
   filter silently no-ops.)
2. **Disable/delete the trippycards triggers for these two workers** so
   trippycards stops deploying them. Do this as part of the same cutover to avoid
   both connectors racing on the same worker.
3. Push to `zero` `main`, watch each build actually upload (check
   `wrangler deployments list` shows a new version and the build log shows
   `Uploaded zerovault-api` / `zeroerrors-api`, not `No projects matched`).
   Because worker names and binding IDs are unchanged, this updates the existing
   workers in place - DO state, KV, and secrets persist.
4. Smoke-test both live domains (`/ping`).

### Phase 7 - Remove from trippycards

Delete the 9 dirs from trippycards; remove their `turbo.json` task edges, `bin/*`
references, and connector triggers. Verify trippycards `bin/ci` still passes for
the remaining (travel/transit/houses) workspace. Commit separately in the
trippycards repo.

## Test strategy

- Colocated unit/DO tests move with the source and run in the turbo `test`
  pipeline; they gate `bin/ci`.
- No new tests required for a relocation. If lint rules change behavior or a
  rename is missed, tests/typecheck catch it.
- Deploy validated by `wrangler deploy --dry-run` locally and by confirming a
  real in-place version bump on both workers post-cutover.

## Documentation strategy

- Update root `AGENTS.md`: add vault/errors to the package list, architecture
  note, and the dev-ports table.
- Add short `docs/` notes if the products need ops context (secrets projects,
  domains, DO layout).
- **Changelog**: these are separate products with their own users; a relocation
  is invisible to end users, so per repo policy **no `CHANGELOG.md` entry** (that
  changelog is the agent product's user-facing feed).

## Skills to use

- `code` - executing the multi-phase move.
- `git-commit` - stage the relocation, config wiring, and pipeline cutover as
  separate focused commits; a separate commit in the trippycards repo for
  removal.
- `testing` - if the stricter eslint/type-checked config forces non-trivial code
  changes in the incoming apps.
- `cloudflare` - for the Workers Builds trigger cutover and verifying in-place
  worker updates.

## Risks, dependencies, mitigations

- **Data loss from a changed worker identity.** Any drift in worker name / KV id
  / DO class name / migration tag creates a new namespace and orphans production
  data. Mitigation: copy wrangler infra verbatim; diff the two `wrangler.jsonc`
  before/after; never edit those fields.
- **Deploy gap or double-deploy during cutover.** Two connectors targeting one
  worker, or neither, mid-migration. Mitigation: create-in-zero and
  remove-in-trippycards in one tight cutover; verify with `deployments list` +
  build logs (watch for the silent `No projects matched` no-op).
- **Bootstrapping coupling.** ZeroVault is the secret store this whole repo (and
  CI) fetches from. A broken `vault-api` deploy can break secret fetching
  repo-wide. Mitigation: `--dry-run` first; deploy vault-api first and smoke-test
  `/ping` before relying on it; keep `MASTER_KEY` untouched.
- **wrangler version/patch conflict** breaking installs or worker builds.
  Mitigation: pin the new apps to `^4.103.0` in Phase 3 (keeps the existing patch
  key valid) before anything else builds; the patch is Docker-only and inert, so
  dropping it and moving to `^4.111.0` is a safe fallback. Do not hand-retarget
  the patch across versions.
- **Lint fallout** from the stricter shared eslint config. Mitigation: budgeted
  fix pass with a documented looser-preset fallback.
- **Dependency:** the `zero-api` rename/deploy work is already shipped, so the
  connector deploy-command pattern is known-good to replicate.
