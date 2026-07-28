# Workers Builds auto-deploy investigation

> **Status (2026-07-26): resolved.** A Workers Builds git connector was attached to
> `zero-landing` (repo `juanibiapina/zero`, branch `main`, root dir `/`, deploy
> `pnpm -F @zero/landing run deploy`), mirroring the `zero-api` and `zerovault-api`
> connectors. The build command is scoped to the landing package
> (`pnpm -F @zero/landing run build`) rather than the whole-repo `pnpm run build` the
> other two use: whole-repo build pulls in `@zero/dashboard-web`, which fails without
> `VITE_CLERK_PUBLISHABLE_KEY` (a build var the API connectors set but landing has no
> reason to). Pushing a landing change to `main` now auto-deploys `zero-landing`.
> AGENTS.md updated accordingly. This file is kept as the evidence record for why the
> connector was missing.

Date: 2026-07-26
Question: why did pushing landing-only commit `e9f27fb` to `main` not auto-deploy
the `zero-landing` Worker?

## Root cause

**`zero-landing` has no Cloudflare Workers Builds git connector attached.** It was
bootstrapped on 2026-07-24 with a manual `wrangler deploy` (deployment annotation
`workers/triggered_by: upload`, "Automatic deployment on upload") and every deploy
since has been a manual CLI upload. No push to `main` has ever deployed it. The
Workers Builds git connector is attached to `zero-api` and `zerovault-api` only;
those two rebuild and deploy on **every** push to `main` (no path filtering), which
is why they kept deploying while `zero-landing` never did.

## Deployable Workers in this repo

Only three apps ship a `wrangler.jsonc` (i.e. are real deployable Workers):

- `apps/agent-api` -> Worker `zero-api` (bundles `agent-web` assets)
- `apps/vault-api` -> Worker `zerovault-api` (serves Vault + Errors + `dashboard-web` assets)
- `apps/landing` -> Worker `zero-landing` (asset-only, `dist/`)

`apps/errors-api`, `apps/errors-web`, `apps/vault-web`, `apps/agent-web`,
`apps/dashboard-web`, `apps/agent-mobile` have no `wrangler.jsonc`; the frontends are
bundled into `zero-api`/`zerovault-api`, and `errors-*` are empty legacy dirs.

## Evidence

### Two independent pushes on 2026-07-26 (times in UTC)

`git log` for main (author time `+0200`, so subtract 2h for UTC):

| commit | UTC push time | files touched |
|---|---|---|
| `70d0f1f` + `e9f27fb` | ~14:00 | docs only + **apps/landing only** |
| `3dc535e` | ~14:43 | `docs/landing.md` only |

Worker deploy timestamps (from `wrangler deployments list` and the CF API
`/workers/scripts/{name}/deployments`):

| event | UTC time |
|---|---|
| push of `e9f27fb` (landing-only) | 14:00:59 |
| `zero-api` deploy | 14:01:56 |
| `zerovault-api` deploy | 14:02:01 |
| **manual** `wrangler deploy` of `zero-landing` (subagent, `eb5098a1`) | 14:33:05 |
| push of `3dc535e` (docs-only) | 14:43:29 |
| `zerovault-api` deploy | 14:44:34 |
| `zero-api` deploy | 14:44:52 |

Two separate pushes, **neither touching `zero-api` or `zerovault-api` source**,
each triggered a fresh deploy of both those Workers within ~60s. `zero-landing`
was never deployed by either push; its only 2026-07-26 deploy was the manual
subagent upload at 14:33. This is deterministic proof: the connector is wired to
`zero-api` and `zerovault-api` (rebuild-on-every-push, no build-watch path filter)
and not to `zero-landing`.

### Ruling out `bin/deploy` as the source of the 14:44 deploys

`bin/deploy` runs `turbo run deploy`, and `agent-api`, `vault-api`, **and
`landing`** all define a `deploy` script (`wrangler deploy`). If the 14:44 deploys
had come from a manual `bin/deploy`, `zero-landing` would also have deployed at
14:44. It did not (its last deploy is 14:33), so the 14:44 `zero-api` /
`zerovault-api` deploys came from the git push of `3dc535e`, i.e. the Workers
Builds connector.

### Worker creation / deployment metadata (CF API)

- `zero-landing`: `default_environment.created_on = 2026-07-24T13:22:40Z`;
  first deployment annotation `workers/triggered_by: upload`,
  `workers/message: "Automatic deployment on upload."` -> created by a manual
  `wrangler deploy`, not by a connector. Last modified 2026-07-26T14:33:08Z
  (the manual subagent deploy).
- `zero-api`: created 2026-02-20; `zerovault-api`: created 2026-05-26. Both long
  predate landing and both received the two push-triggered 2026-07-26 deploys.

### API limitations

- `GET /accounts/{id}/builds/repos` and `GET /accounts/{id}/builds/triggers`
  return `12000 Not found`, but not for the reason recorded here originally
  (a missing token scope) — the token has Workers CI Read. **Those two GET
  operations do not exist.** `/accounts/{account_id}/builds/triggers` is a real
  path with a `POST` (`createTrigger`) and no `GET`; there is no
  `/builds/repos` collection at all, repo connections live at
  `/accounts/{account_id}/builds/repos/connections` with `PUT`
  (`upsertRepoConnection`) and `DELETE .../{repo_connection_uuid}`, again no
  `GET`. Corrected 2026-07-28 against the Cloudflare OpenAPI schema
  (`cloudflare/api-schemas` commit `c92b9b0`). The operations that do exist and
  cover connector inspection and repair:

  ```
  GET   /accounts/{account_id}/workers/services/{worker_name}
  GET   /accounts/{account_id}/builds/workers/{external_script_id}/triggers
  GET   /accounts/{account_id}/builds/workers/{external_script_id}/builds?per_page=N
  GET   /accounts/{account_id}/builds/builds/{build_uuid}
  GET   /accounts/{account_id}/builds/builds/{build_uuid}/logs
  PATCH /accounts/{account_id}/builds/triggers/{trigger_uuid}
  POST  /accounts/{account_id}/builds/triggers/{trigger_uuid}/builds
  GET   /accounts/{account_id}/workers/scripts/{script_name}/deployments
  GET   /accounts/{account_id}/workers/scripts/{script_name}/versions?per_page=N
  ```

  `external_script_id` is the script tag, read from
  `GET /workers/services/{worker_name}` at
  `result.default_environment.script_tag`. The reads need **Workers CI Read**;
  `PATCH` and the manual-build `POST` need **Workers CI Write**. The manual-build
  `POST` requires a body carrying `branch` or `commit_hash`.
- Worker version annotations show `workers/triggered_by: version_upload` for all
  three Workers, because Workers Builds deploys via `wrangler` under the hood; this
  field does **not** distinguish connector deploys from manual ones.
- The Cloudflare dashboard (`Workers -> zero-landing -> Settings -> Builds`) requires
  an interactive login (redirects to `/login`); not accessible with the available
  API token, so connector attachment was confirmed behaviorally rather than by
  reading the Builds settings page.

## Per-worker summary

| Worker | Git connector attached? | Last deploy (UTC) | Source of last deploy |
|---|---|---|---|
| `zero-landing` | **No** | 2026-07-26T14:33:05Z (`eb5098a1`) | Manual `wrangler deploy` (subagent) |
| `zero-api` | Yes | 2026-07-26T14:44:52Z | Connector (Workers Builds, push of `3dc535e`) |
| `zerovault-api` | Yes | 2026-07-26T14:44:35Z | Connector (Workers Builds, push of `3dc535e`) |

## Verdict on AGENTS.md's auto-deploy claim

**Partially true.**

- True for `zero-api` (agent) and `zerovault-api` (vault + errors): both auto-deploy
  on every push to `main` via the Workers Builds connector.
- False for `zero-landing`: it has no connector and only deploys via manual
  `wrangler deploy`. Pushing a landing-only change to `main` does nothing.

Note the AGENTS.md wording enumerates the auto-deploying products as agent / vault /
errors (and elsewhere "both products", agent + dashboard) and **never lists
`landing`**. `apps/landing` (and `apps/dashboard-web`) are newer apps; `landing` was
added as a Worker but never wired into Workers Builds. The blanket claim "Pushing to
`main` auto-deploys to production" is therefore misleading for landing.

## Suggested follow-up (not done here)

- Attach a Workers Builds git connector to `zero-landing` (root dir `apps/landing`,
  build `pnpm --filter @zero/landing build`, deploy `wrangler deploy`, branch `main`),
  or
- Document that landing must be deployed manually (`pnpm --filter @zero/landing run deploy`)
  and correct the AGENTS.md auto-deploy claim to exclude it.
