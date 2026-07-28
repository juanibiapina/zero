# Plan: fix the failing zero-docs branch builds

## Goal

Make the `zero-docs` Workers Builds "Deploy non-production branches" trigger
succeed on branch pushes (dependabot and human branches alike), and remove the
same class of misconfiguration from the other Worker connectors.

## Summary of the finding

The dependency bump is innocent. `pnpm -F @zero/docs run build` succeeds on the
dependabot commit; the build fails in the **deploy** step of the `zero-docs`
preview trigger, whose deploy command is `npx wrangler versions upload` run from
the repo root, where no `wrangler.jsonc` exists. Every non-`main` `zero-docs`
build that actually executed has failed this way since the connector was
attached on 2026-07-27: of the 12 non-production build records, 9 ran and all 9
failed with the same missing-entry-point error after a green Astro build, and 3
were `skipped` by watch-path matching and never ran a deploy step.
Every `main` build is green because the `main` trigger uses a different deploy
command (`pnpm -F @zero/docs run deploy`), which runs inside `apps/docs`.

## Evidence

Account `4e04b64af4013414441c59014392bea0`. Script tags: `zero-docs`
`d3e9e3885feb4f30a36f70872dd77455`, `zero-api`
`8cbffe866be144fea3c6fff9aaa03527`, `zero-landing`
`5a35f798b34a4ffa9ad8273dbba5ce60`, `zerovault-api`
`fd0d43af779344199e62ba9f6483791a`.

### Working Workers Builds API endpoints

`docs/plans/workers-builds-investigation.md` records that
`GET /accounts/{id}/builds/repos` and `/builds/triggers` return `12000 Not
found`. They do, but the reason recorded there (missing token scope) is wrong,
and so is the blunt reading that the paths do not exist. Precisely: **neither of
those two GET operations exists.** `/accounts/{account_id}/builds/triggers` is a
real path with a `POST` (`createTrigger`) and no `GET`. There is no
`/builds/repos` collection at all; the repo-connection path is
`/accounts/{account_id}/builds/repos/connections`, which has `PUT`
(`upsertRepoConnection`) and `DELETE .../{repo_connection_uuid}`, again no
`GET`. The operations this work needs (Cloudflare OpenAPI schema,
`cloudflare/api-schemas` commit `c92b9b0`) are:

```
GET   /accounts/{account_id}/workers/services/{worker_name}
GET   /accounts/{account_id}/builds/workers/{external_script_id}/triggers
GET   /accounts/{account_id}/builds/workers/{external_script_id}/builds?per_page=N
GET   /accounts/{account_id}/builds/builds/{build_uuid}/logs
PATCH /accounts/{account_id}/builds/triggers/{trigger_uuid}
POST  /accounts/{account_id}/builds/triggers/{trigger_uuid}/builds
GET   /accounts/{account_id}/workers/scripts/{script_name}/deployments
GET   /accounts/{account_id}/workers/scripts/{script_name}/versions?per_page=N
```

Get the script tag from
`GET /accounts/{account_id}/workers/services/{worker_name}` at
`result.default_environment.script_tag`; it is the value the schema calls
`external_script_id`, and it matches `external_script_id` in every trigger
response.

### `createManualBuild` requires a request body

`POST /accounts/{account_id}/builds/triggers/{trigger_uuid}/builds`
(`operationId: createManualBuild`) declares `requestBody.required: true` with
schema `builds_CreateBuildRequest`. Quoted from
`cloudflare/api-schemas` commit `c92b9b0`, `openapi.json`:

```json
"builds_CreateBuildRequest": {
  "type": "object",
  "properties": {
    "branch":      { "description": "Git branch name (required if commit_hash not provided)", ... },
    "commit_hash": { "description": "Git commit hash (required if branch not provided)", ... },
    "seed_repo":   { "$ref": "#/components/schemas/builds_BuildSeedRepoInput" }
  },
  "anyOf": [ { "required": ["commit_hash"] }, { "required": ["branch"] } ]
}
```

So the body must carry `branch` or `commit_hash` (either satisfies the `anyOf`;
`seed_repo` is for seeding a fresh repo and is not used here). A bodyless POST
cannot start a build. On success the response is
`{"result": {"build_uuid": "...", "created_on": "..."}, "success": true}`;
`build_uuid` is what the log endpoint takes.

`build_outcome` is one of `success`, `fail`, `skipped`, `cancelled`,
`terminated`; `status` is one of `queued`, `initializing`, `running`, `stopped`.
Poll until `status: "stopped"`, then read `build_outcome`.

### Token scope is a precondition, not a proven fact

Both `updateTrigger` (PATCH) and `createManualBuild` (POST) are tagged
`x-api-token-group: ["Workers CI Write"]`. The read endpoints accept
`["Workers CI Write", "Workers CI Read"]`. The `CLOUDFLARE_API_TOKEN` in the
environment resolves the account and every required GET succeeds, which proves
only **Workers CI Read**. Cloudflare will not disclose a token's own policies
(fetching the token record returns `9109 Unauthorized`), so write scope is
unproven until the first PATCH runs. Treat it as a precondition: if step 2
returns an authorization error rather than the updated trigger, mint a token
with **Workers CI Write** (Account → Workers CI) and re-run from step 2. Do not
work around it by editing the trigger in the dashboard, or the change goes
unrecorded.

### Failing build

Build `7fed1fab-8755-4f50-8da5-73738cebbfa5`, trigger "Deploy non-production
branches", branch `dependabot/npm_and_yarn/minor-and-patch-7b5d1c96b7`
(PR #38, 31 minor/patch bumps), commit `19da99da`, `build_outcome: "fail"`.

Tail of the real build log:

```
14:39:28 [build] 12 page(s) built in 3.35s
14:39:28 [build] Complete!
Success: Build command completed
Executing user deploy command: npx wrangler versions upload
npm warn exec The following package was not found and will be installed: wrangler@4.114.0

 ⛅️ wrangler 4.114.0
────────────────────

✘ [ERROR] Missing entry-point to Worker script or to assets directory

  If there is code to deploy, you can either:
  - Specify an entry-point to your Worker script via the command line (ex: `npx wrangler versions upload src/index.ts`)
  - Or create a "wrangler.jsonc" file containing:
  ...
Failed: error occurred while running deploy command
```

The astro build reached `[build] Complete!` before the deploy step ran, so the
bump did not break the docs build.

### The failure is not dependabot-specific

Last 20 `zero-docs` builds: every `Deploy non-production branches` build is
`fail` (or `skipped` when watch paths do not match), every `Deploy default
branch` build is `success`. Branches affected so far include
`minor-and-patch-7b5d1c96b7`, `minor-and-patch-3f156198eb`,
`minor-and-patch-598a995a85`, `eslint-10.8.0`,
`cloudflare/workers-types-5.20260727.1`, `typescript-7.0.2`, `jest-30.4.2`.
Any human branch touching `apps/docs/*` or the shared build roots will fail the
same way.

### Why landing is green on the same commit

Trigger deploy commands, read from the API:

| Worker | default-branch deploy | non-production deploy |
|---|---|---|
| zero-docs | `pnpm -F @zero/docs run deploy` | `npx wrangler versions upload` (broken) |
| zero-landing | `pnpm -F @zero/landing run deploy` | `pnpm -F @zero/landing exec wrangler versions upload` |
| zero-api | `pnpm -F @zero/agent-api run deploy` | `pnpm -F @zero/api run deploy` (no-op, see below) |
| zerovault-api | `pnpm -F @zero/dashboard-api run deploy` | no non-production trigger |

`zero-landing` build `75a309d1` on the same dependabot commit is `success`; its
deploy step ran inside `apps/landing`, found `apps/landing/wrangler.jsonc`, and
logged `Uploaded zero-landing (2.07 sec)` / `Worker Version ID: d032b6d4-...`.

### Second defect: zero-api preview trigger silently does nothing

`zero-api` preview build `1fc57e47-8d63-49e3-9073-33bb90d8cc14` is green, but its
deploy step logged:

```
Executing user deploy command: pnpm -F @zero/api run deploy
No projects matched the filters in "/opt/buildhome/repo"
Success: Deploy command completed
```

No workspace package is named `@zero/api` (the agent Worker package is
`@zero/agent-api`). `pnpm -F` exits 0 on an empty filter match, so the trigger
reports success while uploading nothing. Note the naive repair is dangerous:
`pnpm -F @zero/agent-api run deploy` maps to `wrangler deploy`, which would push
a branch build to **production** traffic on every non-`main` push. The preview
trigger must use `wrangler versions upload`, not `deploy`.

### Why a preview upload cannot serve production traffic

Cloudflare's documented contract settles the direction of the zero-api risk, so
the empirical checks in steps 1 and 6 are corroboration, not the sole proof:

- "A **deployment** determines which version(s) are actively serving traffic."
  Traffic routing is a property of deployments only; a version that is in no
  deployment serves no production traffic
  ([versions and deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/),
  last updated 2026-07-03).
- `wrangler versions upload` is documented as "Upload a new **version** of your
  Worker that is **not deployed immediately**"
  ([wrangler Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/#versions-upload)).
- The paths that do create a version *and* immediately route 100% of traffic to
  it are enumerated as exactly three: `wrangler deploy`, Workers Builds (i.e. a
  trigger whose deploy command is `wrangler deploy`), and the Script Upload API.
  `versions upload` is documented under "Upload a version **without**
  deploying"
  ([deployment management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/),
  last updated 2026-07-15).
- The one documented exception is the **first** upload of a brand-new Worker:
  `versions upload` *fails* there rather than deploying. `zero-api` already
  exists with 10 deployments of history, so this does not apply, and the failure
  mode is loud either way.

So the only way the preview trigger could shift traffic is if it ran a different
command than the one step 3 installs. That is what step 6 tests, and it tests it
by looking for **deployment records**, which is the only mechanism that can move
traffic.

### The deployments endpoint returns a 10-record window

`GET $CF/workers/scripts/zero-api/deployments` returns the **10 most recent**
deployments, newest first, in `.result.deployments`. It ignores paging: `?page=2`,
`?per_page=3`, and `?per_page=100` all return the identical 10 records, and
`result_info` is `null` (verified live at planning time). `wrangler deployments
list` documents the same 10-record window. This matters for step 6: the window is
append-at-the-head, so **any** deployment created during the test window appears
in it, including one that a later `main` deployment immediately supersedes.

The **versions** endpoint behaves differently and does paginate:
`GET $CF/workers/scripts/zero-api/versions?per_page=20` returns
`.result.items[]` plus a real `result_info` with `total_count` (502 at planning
time, newest version `1489ac2c` = number 502). That counter is a second cheap
tripwire: across the test window it must increase by exactly 1, the preview
upload. A concurrent `wrangler deploy` would add a version of its own and push
it to 2.

### Per-version request counts are queryable

The GraphQL Analytics API answers "did this exact version ever serve a request"
directly, independently of deployment history. `workersInvocationsAdaptive`
accepts `scriptVersion` as both a filter and a dimension; the environment token
can read it. Verified live at planning time:

```
$ POST https://api.cloudflare.com/client/v4/graphql
  workersInvocationsAdaptive(limit: 100, filter: {
    datetime_geq: "...", datetime_leq: "...",
    scriptName: "zero-api", scriptVersion: "42985281-f66a-4090-8575-c650cedff4ac"
  }) { sum { requests } dimensions { scriptName scriptVersion } }
→ [{"dimensions":{"scriptName":"zero-api","scriptVersion":"42985281-..."},
    "sum":{"requests":2}}]
```

The same query with a version id that never existed returns `errors: null` and
`[]`, and an unknown dimension name is rejected outright (`unknown field
"bogusFieldXyz"`). Both controls were run at planning time, so a successful
query with an empty result set is a real "no rows", not a silently ignored
filter. Worker metrics are retained for up to three months
([metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/#metrics-retention)),
so the query can be re-run later.

**But the negative direction is not trustworthy here.** The current production
version, fully routed at 100%, also returns `errors: null` and `[]` over both the
last 24 hours and the last 28 days. `zero-api` traffic is low enough that a live
version can register no rows at all, so "empty result" does not distinguish
"served nothing" from "served something but no row came back". That is why step
6c is optional corroboration rather than a proof: a non-empty row for the preview
version would be damning, an empty one says nothing.

### Local reproduction

`pnpm -F @zero/docs run build` at `main` (`3030817`) exits 0 and emits
`12 page(s) built`.

Running the preview trigger's deploy command from the repo root reproduces the
Cloudflare error exactly:

```
$ node apps/docs/node_modules/wrangler/bin/wrangler.js versions upload
 ⛅️ wrangler 4.103.0 (update available 4.114.0)
✘ [ERROR] Missing entry-point to Worker script or to assets directory
```

The same wrangler resolves the config correctly from `apps/docs`, and so does the
exact command this plan installs, with the exact verb the trigger runs:

```
$ cd apps/docs && ./node_modules/.bin/wrangler deploy --dry-run
✨ Read 81 files from the assets directory .../apps/docs/dist
Total Upload: 0.45 KiB / gzip: 0.32 KiB
--dry-run: exiting now.

$ pnpm -F @zero/docs exec wrangler versions upload --dry-run
 ⛅️ wrangler 4.103.0
Total Upload: 0.45 KiB / gzip: 0.32 KiB
--dry-run: exiting now.
```

There is no `wrangler.jsonc` at the repo root; the only ones are
`apps/agent-api`, `apps/docs`, `apps/landing`, `apps/vault-api`, and
`ops/zeroerrors-retirement`.

### Named cause

Cloudflare Workers Builds trigger `2eec7eac-dcf9-442d-9fa8-a3f3a0bed31b`
(`zero-docs`, "Deploy non-production branches"), field `deploy_command`, value
`npx wrangler versions upload`, with `root_directory: "/"`. The cause is
connector configuration held in Cloudflare, not in any repo file.

## Options considered

1. **Point the deploy command at the package (chosen).** Set the docs preview
   `deploy_command` to `pnpm -F @zero/docs exec wrangler versions upload`. This
   is byte-for-byte the pattern `zero-landing` already uses and proves green on
   the same commit. It also runs the repo-pinned wrangler `4.103.0` instead of
   letting `npx` fetch whatever is latest (`4.114.0` in the failing log), so the
   preview path stops drifting from the `main` path.
2. **Set `root_directory` to `apps/docs`.** Wrangler would find its config, but
   Workers Builds runs dependency install from the root directory, and this is a
   pnpm workspace whose install must happen at the repo root. Rejected.
3. **Pass paths explicitly:** `npx wrangler versions upload --config
   apps/docs/wrangler.jsonc --assets apps/docs/dist`. Works, but duplicates
   config that already lives in `wrangler.jsonc`, keeps the unpinned `npx`
   wrangler, and diverges from landing. Rejected.
4. **Delete the docs preview trigger.** Ends the red builds but loses preview
   versions and the branch-level signal that a docs change compiles. Rejected.
5. **Pin, group, or ignore the dependency in `.github/dependabot.yml`.**
   Rejected: no dependency is at fault. The astro build succeeded on every
   failing commit. Changing dependabot config would hide a deploy-step bug and
   leave human branches failing.

## Chosen approach

Repair the Cloudflare trigger configuration through the Workers Builds API, then
record the per-trigger deploy commands in the repo so the next connector edit
does not reintroduce the drift.

Target state for the non-production triggers:

| Worker | trigger uuid | new `deploy_command` |
|---|---|---|
| zero-docs | `2eec7eac-dcf9-442d-9fa8-a3f3a0bed31b` | `pnpm -F @zero/docs exec wrangler versions upload` |
| zero-api | `6c21787a-3bdd-4a85-9b47-8108ef67e871` | `pnpm -F @zero/agent-api exec wrangler versions upload` |
| zero-landing | `e63c7289-fa16-43e6-95d6-0efb8b5982e9` | unchanged (already correct) |

`zerovault-api` has no non-production trigger. Leave it that way in this change:
its build command is the whole-repo `pnpm run build`, which needs the
`VITE_CLERK_PUBLISHABLE_KEY` build variable set per trigger, so adding a preview
trigger is a separate decision with its own configuration. Note it as a known
asymmetry in the docs instead.

## Steps

Shell setup used by every command below (the token is already in the
environment; `jq` is available):

```bash
ACC=4e04b64af4013414441c59014392bea0
CF="https://api.cloudflare.com/client/v4/accounts/$ACC"
AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")
DOCS_TAG=d3e9e3885feb4f30a36f70872dd77455
API_TAG=8cbffe866be144fea3c6fff9aaa03527
DOCS_PREVIEW=2eec7eac-dcf9-442d-9fa8-a3f3a0bed31b
API_PREVIEW=6c21787a-3bdd-4a85-9b47-8108ef67e871
BRANCH=dependabot/npm_and_yarn/minor-and-patch-7b5d1c96b7   # head 19da99da, still on origin
```

1. **Establish quiescence, then record the pre-change baseline.** Everything is
   saved to files so the after-comparison is a diff and not a memory.

   a) **Quiescence gate.** The zero-api safety proof in step 6 is only readable
   if nothing else deploys `zero-api` between the baseline and the post-check.
   Establish and record that:

   ```bash
   mkdir -p /tmp/zero-docs-fix
   git ls-remote origin refs/heads/main | cut -f1 > /tmp/zero-docs-fix/main-sha.before
   curl -sS "${AUTH[@]}" "$CF/builds/workers/$API_TAG/builds?per_page=10" \
     > /tmp/zero-docs-fix/api-builds.before.json
   jq -r '.result[] | "\(.build_uuid) \(.trigger.trigger_name) \(.status) \(.build_outcome) \(.created_on)"' \
     /tmp/zero-docs-fix/api-builds.before.json
   ```

   Required before proceeding: **every** zero-api build record has
   `status: "stopped"` (no `queued`, `initializing`, or `running` build in
   flight, which could deploy `main` mid-window), and the `main` sha is
   recorded. Do not run `bin/deploy`, do not merge anything to `main`, and do
   not promote a version in the dashboard until step 6 finishes. If another
   person can push, say so before starting; the window is a few minutes.

   b) **Current trigger config, for rollback:**

   ```bash
   for tag in $DOCS_TAG $API_TAG; do
     curl -sS "${AUTH[@]}" "$CF/builds/workers/$tag/triggers" \
       > /tmp/zero-docs-fix/triggers-$tag.before.json
   done
   jq -r '.result[] | "\(.trigger_uuid) \(.trigger_name): \(.deploy_command)"' \
     /tmp/zero-docs-fix/triggers-*.before.json
   ```

   c) **The whole zero-api deployment window**, not just the active deployment:

   ```bash
   curl -sS "${AUTH[@]}" "$CF/workers/scripts/zero-api/deployments" \
     > /tmp/zero-docs-fix/zero-api-deployments.before.json
   curl -sS "${AUTH[@]}" "$CF/workers/scripts/zero-api/versions?per_page=20" \
     > /tmp/zero-docs-fix/zero-api-versions.before.json
   jq -S '[.result.deployments[] | {id, created_on, source, versions}]' \
     /tmp/zero-docs-fix/zero-api-deployments.before.json \
     > /tmp/zero-docs-fix/deployment-window.before.json
   jq -r '.[] | "\(.id) \(.created_on) \([.versions[]|"\(.version_id):\(.percentage)"]|join(","))"' \
     /tmp/zero-docs-fix/deployment-window.before.json
   ```

   The list is newest-first and capped at 10 records (see the evidence section:
   the endpoint ignores `page`/`per_page`), so `.result.deployments[0]` is the
   **active** deployment and the saved array is the full visible history.
   Comparing the whole array is the point: a transient deployment that a later
   `main` deployment supersedes still leaves its record in this window, which is
   exactly the case a `[0]`-only diff would miss.

   Write the active deployment's `id` and its `versions[].version_id` /
   `percentage` pair into the commit message; that pair is the thing that must
   not move. At planning time the window's head was
   `cad3efa1-67ee-48c1-8333-0126333bc720` → version
   `1489ac2c-6bd2-4bb7-b689-c80566247a82` at 100%, created 2026-07-28T01:37:27Z
   from the `main` build of `2047e90b`, and its tail was
   `ae2b2071-f4f5-45e9-9b93-6a3157286811` (2026-07-27T13:55:13Z). Re-read rather
   than trusting those values; a `main` push between planning and execution
   moves them legitimately.

   Also record the wall-clock UTC time the window opens
   (`date -u +%FT%TZ > /tmp/zero-docs-fix/window-start`); step 6's traffic query
   needs it.

   Note that version annotations do **not** distinguish a preview upload from a
   production deploy: the live zero-api version `1489ac2c` carries
   `annotations."workers/triggered_by": "version_upload"` because `wrangler
   deploy` uploads a version and then creates a deployment. Only the
   **deployments** list says what serves traffic. That is why the check is a
   deployments diff, not an annotation check.

2. `PATCH $CF/builds/triggers/$DOCS_PREVIEW` with
   `{"deploy_command": "pnpm -F @zero/docs exec wrangler versions upload"}`.
   A partial body containing only `deploy_command` is valid per
   `builds_UpdateTriggerRequest`. Read the trigger back and confirm the new
   value:

   ```bash
   curl -sS -X PATCH "${AUTH[@]}" "$CF/builds/triggers/$DOCS_PREVIEW" \
     -d '{"deploy_command":"pnpm -F @zero/docs exec wrangler versions upload"}' | jq '.success, .errors'
   curl -sS "${AUTH[@]}" "$CF/builds/workers/$DOCS_TAG/triggers" \
     | jq -r '.result[] | "\(.trigger_uuid) \(.trigger_name): \(.deploy_command)"'
   ```

   If this call fails on authorization, the token lacks **Workers CI Write**;
   see the precondition above.

3. `PATCH $CF/builds/triggers/$API_PREVIEW` with
   `{"deploy_command": "pnpm -F @zero/agent-api exec wrangler versions upload"}`.
   Read back and confirm. Do **not** use `run deploy` here; that is `wrangler
   deploy` and would push a branch to production traffic. Check the UUID twice:
   the `zero-api` **default-branch** trigger is `e040ba2a-11db-4734-80cd-ad4c5eb2b7be`
   and must keep `pnpm -F @zero/agent-api run deploy`. Confirm in the read-back
   that the default-branch trigger's `deploy_command` is unchanged.

4. **Re-run the docs build that failed.** The body is required (see
   `createManualBuild` above):

   ```bash
   curl -sS -X POST "${AUTH[@]}" "$CF/builds/triggers/$DOCS_PREVIEW/builds" \
     -d "{\"branch\":\"$BRANCH\"}" | jq '.success, .errors, .result'
   ```

   Keep the returned `result.build_uuid`. Poll until it stops, then read the log:

   ```bash
   curl -sS "${AUTH[@]}" "$CF/builds/builds/$BUILD_UUID" | jq '.result | {status, build_outcome}'
   curl -sS "${AUTH[@]}" "$CF/builds/builds/$BUILD_UUID/logs" | jq -r '.result.lines[][1]' | tail -40
   ```

   Pinning the exact commit instead of the branch head is equally valid and is
   the better choice if the branch may move:
   `-d '{"commit_hash":"19da99da3c04b50dcc03ebfa28fdce3d1835f706"}'`. Send one
   or the other, not neither; the schema's `anyOf` rejects an empty body.

   If `build_outcome` comes back `skipped`, watch-path matching excluded the
   build rather than the deploy command failing; pick a branch whose diff
   touches `apps/docs/*` or a shared build root (`pnpm-lock.yaml`,
   `package.json`, `turbo.json`, `pnpm-workspace.yaml`,
   `packages/typescript-config/*`, `patches/*`) and re-run. The dependabot
   branch above touches `pnpm-lock.yaml` and `package.json`, so it matches both
   the docs and the zero-api preview triggers.

5. **Exercise the zero-api preview trigger the same way**, on the same branch:

   ```bash
   curl -sS -X POST "${AUTH[@]}" "$CF/builds/triggers/$API_PREVIEW/builds" \
     -d "{\"branch\":\"$BRANCH\"}" | jq '.result'
   ```

   Poll to `status: "stopped"` and read the log. Required: `build_outcome:
   "success"`, the log contains `Executing user deploy command: pnpm -F
   @zero/agent-api exec wrangler versions upload`, an `Uploaded zero-api` line
   and a `Worker Version ID:` line, and it does **not** contain `No projects
   matched the filters`. Record the uploaded version id from that log line.

   This step is the whole point of the zero-api half of the change: the current
   trigger is a false green (`pnpm -F @zero/api run deploy` matches no package,
   `pnpm -F` exits 0 on an empty match), so without running a build the repair
   is unverified.

6. **Prove the preview build shifted no traffic.** Two required checks: 6a says
   the window is readable, and 6b is a whole-window control-plane comparison
   that replaces the old `[0]`-only diff. 6c is **optional** corroboration only
   and is not an acceptance criterion (see its caveat below). Let
   `PREVIEW_VERSION` be the version id from step 5's `Worker Version ID:` line.

   **6a. Quiescence held.** Re-check the two gates from step 1a:

   ```bash
   git ls-remote origin refs/heads/main | cut -f1
   diff <(cat /tmp/zero-docs-fix/main-sha.before) <(git ls-remote origin refs/heads/main | cut -f1)
   curl -sS "${AUTH[@]}" "$CF/builds/workers/$API_TAG/builds?per_page=10" \
     > /tmp/zero-docs-fix/api-builds.after.json
   diff <(jq -S '[.result[] | {build_uuid, trigger: .trigger.trigger_name, created_on}]' \
            /tmp/zero-docs-fix/api-builds.before.json) \
        <(jq -S '[.result[] | {build_uuid, trigger: .trigger.trigger_name, created_on}]' \
            /tmp/zero-docs-fix/api-builds.after.json)
   ```

   Required: the `main` sha is unchanged, and the only new build record is
   step 5's own manual build on `$BRANCH` from trigger
   `Deploy non-production branches`. If a `Deploy default branch` build appeared,
   quiescence broke: 6b will report a change, and the escalation at the end of
   this step decides the outcome.

   **6b. No deployment was created at all.** This is the control-plane proof:

   ```bash
   curl -sS "${AUTH[@]}" "$CF/workers/scripts/zero-api/deployments" \
     > /tmp/zero-docs-fix/zero-api-deployments.after.json
   curl -sS "${AUTH[@]}" "$CF/workers/scripts/zero-api/versions?per_page=20" \
     > /tmp/zero-docs-fix/zero-api-versions.after.json
   jq -S '[.result.deployments[] | {id, created_on, source, versions}]' \
     /tmp/zero-docs-fix/zero-api-deployments.after.json \
     > /tmp/zero-docs-fix/deployment-window.after.json
   diff /tmp/zero-docs-fix/deployment-window.before.json \
        /tmp/zero-docs-fix/deployment-window.after.json
   ```

   Required: the `diff` of the **entire 10-record window** is empty, with every
   deployment `id`, `created_on`, `source`, routed `version_id`, and
   `percentage` identical, in the same order. Because traffic can only be routed
   by a deployment (see the documented contract in the evidence section) and
   every new deployment is prepended to this window, an unchanged window means
   **zero deployments were created during the test window**, so no version,
   preview or otherwise, could have taken traffic, not even briefly. This is
   what the earlier `[0]`-only diff could not show: a preview deployment
   superseded by a legitimate `main` deployment before the after-snapshot would
   still be sitting in this array.

   Then confirm the upload happened and is unrouted:

   ```bash
   jq -r '.result.items[0:3][] | "\(.id) \(.number) \(.metadata.created_on)"' \
        /tmp/zero-docs-fix/zero-api-versions.after.json
   jq -r '.result_info.total_count' /tmp/zero-docs-fix/zero-api-versions.before.json \
                                    /tmp/zero-docs-fix/zero-api-versions.after.json
   rg -q "$PREVIEW_VERSION" /tmp/zero-docs-fix/zero-api-versions.before.json && echo LEAK
   rg -q "$PREVIEW_VERSION" /tmp/zero-docs-fix/deployment-window.after.json && echo ROUTED
   ```

   Required: `PREVIEW_VERSION` is at the top of the after-versions list, absent
   from the before-versions list (no `LEAK`), and absent from **every** record
   of the after deployment window (no `ROUTED`). `total_count` must rise by
   exactly 1; two new versions would mean something else uploaded during the
   window. A new-but-unrouted version is exactly what `versions upload` is
   supposed to produce.

   **Why 6a plus 6b is enough on its own.** Traffic can move only through a
   deployment record: a deployment is the only object that assigns traffic
   percentages to versions, and every deployment created, including one
   superseded seconds later, is prepended to this 10-record window. The check
   diffs the **whole** window, not just its head, so zero new deployment records
   means zero traffic movement. Combined with the documented contract that
   `versions upload` produces a version that is not deployed, the two layers
   settle the question without any data-plane query.

   **6c (OPTIONAL). Per-version request counts.** Corroboration only, not an
   acceptance criterion. Its positive control does **not** hold: the current
   production version returns `errors: null` and `[]` over both 24 hours and 28
   days, because `zero-api` versions carry so little traffic that a live,
   fully-routed version can register no rows. So a **non-empty** result here
   would be evidence of a traffic shift and must trigger the rollback, but an
   **empty** result proves nothing. Run it only as a cheap extra signal:

   ```bash
   read -r WINDOW_START < /tmp/zero-docs-fix/window-start
   NOW=$(date -u +%FT%TZ)
   curl -sS -X POST https://api.cloudflare.com/client/v4/graphql "${AUTH[@]}" -d "$(jq -n \
     --arg acc "$ACC" --arg from "$WINDOW_START" --arg to "$NOW" --arg v "$PREVIEW_VERSION" '{
       query: "query($acc:String!,$from:Time!,$to:Time!,$v:String!){viewer{accounts(filter:{accountTag:$acc}){workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$from,datetime_leq:$to,scriptName:\"zero-api\",scriptVersion:$v}){sum{requests} dimensions{scriptName scriptVersion}}}}}",
       variables: {acc:$acc, from:$from, to:$to, v:$v}}')" \
     | jq '.errors, .data.viewer.accounts[0].workersInvocationsAdaptive'
   ```

   Interpretation: a non-empty array means the preview version served requests,
   which is a hard failure and triggers the rollback below. An empty array is
   **not** evidence of safety, because the same query returns empty for the
   live, fully-routed production version. Analytics lags a few minutes, so run
   this at least five minutes after step 5's build stopped; the three-month
   retention means it can also be re-run later.

   **Escalation if 6b's diff is non-empty.** Do not fall back to "look at the
   active deployment". Enumerate instead:

   ```bash
   comm -13 <(jq -r '.[].id' /tmp/zero-docs-fix/deployment-window.before.json | sort) \
            <(jq -r '.[].id' /tmp/zero-docs-fix/deployment-window.after.json | sort)
   ```

   For **every** id in that set, read its `versions[]` from the after window and
   require `PREVIEW_VERSION` to appear in none of them, and attribute each new
   deployment to a `Deploy default branch` build (match `created_on` and the
   deployed version id against
   `GET $CF/builds/workers/$API_TAG/builds?per_page=5`). If more than 10
   deployments landed, the window has fully rotated and the record is
   unrecoverable: treat the control-plane proof as failed. The run is then
   inconclusive, not passing; roll back step 3's `deploy_command` and re-run
   steps 5 and 6 in a fresh quiet window.

   **If any check fails**, meaning `PREVIEW_VERSION` appears in any deployment
   record, or optional 6c returns requests, the preview trigger deployed instead
   of uploading.
   Immediately restore step 3's previous `deploy_command` from
   `/tmp/zero-docs-fix/triggers-$API_TAG.before.json`, confirm the currently
   active version is the one the last `main` build produced, and treat it as a
   production incident before continuing with anything else.

7. Update `AGENTS.md`: add a short subsection under Deployment listing, per
   connector, the default-branch deploy command and the non-production deploy
   command, with the rule that preview triggers use `pnpm -F <pkg> exec wrangler
   versions upload` (never `run deploy`, which is `wrangler deploy` and targets
   production) and that a `pnpm -F` typo exits 0 rather than failing. Mention
   that `zerovault-api` has no preview trigger and why.
8. Correct `docs/plans/workers-builds-investigation.md:92`, which claims the
   builds API returns `12000 Not found` because the token lacks the Workers CI
   scope. Both halves are wrong: the token has Workers CI Read, and those two
   GET operations do not exist. Replace the bullet with the endpoint list above,
   including the note that `/builds/triggers` is POST-only and that repo
   connections live at `/builds/repos/connections`, so the next investigation
   does not re-derive it.
9. Commit with `git-commit`. The commit must cover **four** files, because both
   plan files are currently untracked and the clean-tree check in verification
   item 5 is otherwise unachievable:
   - `AGENTS.md` (step 7)
   - `docs/plans/workers-builds-investigation.md` (step 8)
   - `docs/plans/zero-docs-dependabot-build.md` (this plan)
   - `docs/plans/zero-docs-dependabot-build-verify.md` (the verification report
     that reviewed this plan; keep it, it is the record of what was checked and
     how the zero-api safety proof was hardened)

   No code changes are needed; nothing in `apps/docs` is at fault. Put the
   step 1 rollback values (both previous `deploy_command` strings and the
   pre-change active zero-api deployment id and version id) in the commit
   message, since they are the only record of the prior Cloudflare state.
10. Leave PR #38 and the other dependabot PRs alone. They can be merged on their
    own merits once their builds are green; that is a separate decision. Note
    that PR #38's two GitHub Actions jobs never started, because of an account
    billing/spending-limit error unrelated to this defect, so its CI still needs
    a rerun before anyone judges the 31 bumps.

## Changelog

**No changelog entry.** Per `AGENTS.md`, only user-observable changes get one.
This is CI/deploy configuration: `docs.zeroapps.dev` is served from the `main`
trigger, which was already green, so nothing a user sees changes. The root
`CHANGELOG.md` and `apps/agent-api/CHANGELOG.md` both stay untouched.

## Verification

1. Local build stays green: `pnpm -F @zero/docs run build` exits 0 and reports
   `12 page(s) built`. Already true today; re-run after the change to confirm no
   regression.
2. Local config resolution with the exact command the trigger will run:
   `pnpm -F @zero/docs exec wrangler versions upload --dry-run` prints
   `Total Upload: 0.45 KiB` and `--dry-run: exiting now` with no positional
   asset path, which proves wrangler loaded `apps/docs/wrangler.jsonc`.
   `--dry-run` makes no network write. Run the same for `@zero/agent-api`; it
   must load the entry point, assets, and the Durable Object, KV, R2, Analytics
   Engine, and AI bindings.
3. The decisive docs check is the Cloudflare build from step 4. It must have
   `status: "stopped"` and `build_outcome: "success"`, and its log must contain
   `Executing user deploy command: pnpm -F @zero/docs exec wrangler versions
   upload`, `Uploaded zero-docs`, a `Worker Version ID:` line, and
   `Success: Deploy command completed`. The string
   `Missing entry-point to Worker script or to assets directory` must be absent,
   and so must `npx` fetching a wrangler newer than the repo-pinned `4.103.0`.
4. The decisive zero-api check is steps 5 and 6, run in this work, not deferred
   to "the next non-`main` build":
   - **the fix works:** step 5's build has `build_outcome: "success"`, its log
     has no `No projects matched the filters`, and it has an `Uploaded zero-api`
     line and a `Worker Version ID:` line;
   - **the window is readable:** step 6a shows the `main` sha unchanged and no
     `Deploy default branch` build record added, so nothing but the preview
     build touched `zero-api`;
   - **no traffic moved (control plane):** step 6b's `diff` of the **full
     10-record** deployment window before versus after is empty, so no
     deployment at all was created, neither a lasting one nor a transient one
     that a later `main` deployment would have hidden;
   - **the upload is unrouted:** step 5's version id is at the top of the
     after-versions list, absent from the before-versions list, and absent from
     every record of the after deployment window, and the versions
     `result_info.total_count` rose by exactly 1.

   Those four together are what "uploaded a version, deployed nothing" means,
   and they rest on two layers only: the documented contract that `versions
   upload` does not deploy, and the whole-window deployment diff plus the
   exact `+1` version-count tripwire. That is sufficient because traffic can
   move only through a deployment record, and the entire 10-record window is
   diffed, so zero new deployment records means zero traffic movement, including
   a transient deployment that a later `main` deployment would have superseded.
   No single criterion suffices alone: a green build with no upload is the false
   green being fixed, and an unchanged window with no new version would mean the
   deploy command silently did nothing again.

   Step 6c is **not** an acceptance criterion. Its positive control fails (the
   live production version also returns an empty result), so an empty result
   there adds nothing; only a non-empty result would matter, as a failure
   signal.
5. `git status --short` prints nothing after step 9's commit: the doc edits and
   **both** plan files (this plan and the verification report) are committed, and
   the working tree and index are empty. Nothing in `apps/` changes, so
   `git show --stat HEAD` must list only files under `docs/` and `AGENTS.md`.

## Risks

- **Fixing zero-api's preview trigger could deploy a branch to production** if
  `run deploy` is used instead of `exec wrangler versions upload`. `zero-api` is
  the agent Worker; a bad deploy resets `UserDO` instances mid-turn (see
  `AGENTS.md`). Mitigation: use `versions upload` only, and prove it with the
  step 1 / step 6 evidence rather than trusting the command string. Cloudflare's
  documented contract backs this up: `wrangler deploy` creates a version and
  immediately routes 100% of traffic to it, while `wrangler versions upload`
  creates a version that is "not deployed immediately", and Workers Builds' own
  default non-production deploy command is `npx wrangler versions upload`
  ([versions and deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/),
  [deployment management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/),
  [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)).
  The empirical checks are quiescence (6a) and an unchanged full 10-record
  deployment window (6b); 6c's analytics query is optional corroboration whose
  positive control does not hold. Rollback if a required check
  fails: restore the previous `deploy_command` from
  `/tmp/zero-docs-fix/triggers-*.before.json` and re-check the served version.
- **The safety window can be disturbed by someone else deploying.** A `main`
  merge, a manual `bin/deploy`, or a dashboard promotion during the test window
  adds a legitimate deployment and makes the control-plane comparison ambiguous.
  Mitigation: step 1a gates on no in-flight zero-api build and records the `main`
  sha, and step 6a re-checks both. If the window is disturbed anyway, step 6's
  escalation enumerates every deployment added during the window; if it rotated
  fully, the run is inconclusive and must be repeated in a fresh quiet window.
  Cost of the mitigation is a few minutes of not merging to `main`.
- **Version clutter and build cost.** Preview branches now create Worker
  versions for `zero-docs`, and the zero-api preview trigger starts producing
  real uploads instead of no-ops. Landing already behaves this way, so the
  volume is known and small. Versions are not routed to traffic; the cost is
  Workers Builds minutes plus stored versions. A version upload can also mint a
  preview URL where previews are enabled: docs and landing have them on,
  zero-api's deployed version currently reports `has_preview: false`. The upload
  itself causes no request traffic and runs no Worker code.
- **Config lives outside the repo.** These triggers are Cloudflare state; a
  future dashboard edit can silently break them again, exactly as happened here.
  Step 7 (documenting them in `AGENTS.md`) is the only mitigation short of
  managing the connectors with Terraform, which is out of scope here.
- **Assumption to check while implementing:** that `pnpm -F @zero/docs exec` is
  available in the Workers Builds image with the same pnpm version landing uses.
  The landing trigger proves the form works on this repo and image, so the risk
  is low, but the first re-run in step 4 is what confirms it.
- **Token write scope is unproven** until the first PATCH. See the precondition
  in the evidence section; the failure mode is a loud authorization error at
  step 2, not a silent wrong result.

## Review findings addressed

Three verification passes (`docs/plans/zero-docs-dependabot-build-verify.md`)
raised two blockers and five nits against the first draft, one blocker and one
partly-closed nit against the second, and one blocker against the third. All are
closed here; none is declined.

### Round 3 findings

- **Blocker: 6c's positive control fails, so an empty analytics result proves
  nothing.** Closed by demoting the check rather than repairing it. The current
  production version returns `errors: null` and `[]` for the same query, so the
  negative direction carries no information at this traffic volume. Step 6c is
  now labelled OPTIONAL corroboration with that caveat stated inline, and
  verification item 4 rests on two layers: the documented contract that
  `versions upload` does not deploy, and the whole-window deployment diff plus
  the exact `+1` version-count tripwire. Those suffice because traffic can move
  only through a deployment record and the entire 10-record window is diffed,
  so zero new deployment records means zero traffic movement. Round 3 confirmed
  both layers independently.

### Round 2 findings

- **Blocker: the zero-api traffic-safety comparison was not decisive under its
  own concurrent-`main` exception.** Closed by replacing the comparison, not by
  patching the exception. Three changes:
  1. Step 6b now diffs the **entire** deployment window, not
     `.result.deployments[0]`. The endpoint returns the 10 most recent
     deployments and ignores paging (verified: `page=2`, `per_page=3`, and
     `per_page=100` all return the same 10 records, `result_info: null`). A
     deployment created and then superseded inside the window still has its
     record in that array, so an empty diff proves **no deployment was created
     at all**, which is strictly stronger than "the active deployment did not
     move". Since a deployment is the only thing that routes traffic, that rules
     out even a brief shift.
  2. Step 1a establishes quiescence and step 6a re-checks it: no zero-api build
     in a non-`stopped` state at the start, the `origin/main` sha unchanged
     across the window, and no new `Deploy default branch` build record. The
     concurrent-`main` scenario is now prevented and detected rather than
     excused.
  3. Step 6c adds a data-plane check that is independent of deployment history:
     `workersInvocationsAdaptive` filtered by `scriptName: "zero-api"` and
     `scriptVersion: <preview version id>`. Round 3 showed this cannot be
     load-bearing (its positive control fails), so it is now optional
     corroboration; see the Round 3 findings above.
  The old "if a `main` push lands mid-run, re-read the baseline" escape hatch is
  gone; its replacement enumerates every deployment id added during the window
  and requires the preview version id to appear in none of them.
  Cloudflare's docs also settle the direction a priori (`versions upload`
  uploads a version "that is not deployed immediately"; only `wrangler deploy`,
  the Script Upload API, and a Workers Builds trigger running `wrangler deploy`
  route traffic on upload), so the empirical checks are corroboration rather
  than the sole proof. See "Why a preview upload cannot serve production
  traffic" in the evidence section.
- **Nit 5, partly closed: the commit scope omitted the verification report.**
  Closed. Step 9 now names all four files, including
  `docs/plans/zero-docs-dependabot-build-verify.md`, so the empty
  `git status --short` in verification item 5 is achievable; both untracked plan
  files land in the same commit.

### Round 1 findings

- **Blocker: manual build POST had no body.** Closed. The evidence section now
  quotes `builds_CreateBuildRequest` from `cloudflare/api-schemas` commit
  `c92b9b0`, and step 4 sends `{"branch":"..."}` (with the `commit_hash`
  alternative spelled out).
- **Blocker: the zero-api patch was never exercised or compared.** Closed. Step 1
  snapshots the deployment window and version list, step 5 runs the zero-api
  preview trigger on a real branch, and step 6 compares before versus after and
  requires a new non-live version. Verification item 4 makes those conditions
  acceptance criteria instead of deferring to "the next non-`main` build". Round
  2 then found the comparison itself too weak; see above for the replacement.
- **Nit 1: "every non-`main` build failed" was overstated.** Fixed: 9 executed
  and failed, 3 were `skipped` by watch paths.
- **Nit 2: `/builds/triggers` does exist.** Fixed: the correction now says the
  two *GET operations* do not exist, that `/builds/triggers` is POST-only, and
  that repo connections live at `/builds/repos/connections` (PUT/DELETE, no
  GET).
- **Nit 3: local check used the wrong verb.** Fixed: `pnpm -F @zero/docs exec
  wrangler versions upload --dry-run` is now both the quoted evidence and
  verification item 2; the older `deploy --dry-run` output is kept only as
  corroboration that assets resolve.
- **Nit 4: token write scope was asserted, not proved.** Fixed: it is now a
  named precondition with the schema's `Workers CI Write` requirement and a
  recovery path.
- **Nit 5: git-status criterion mixed tree state with history.** Fixed:
  verification item 5 requires empty `git status --short` after the commit, plus
  a `git show --stat HEAD` file-scope check.

## Skills to use

- `cloudflare` — Workers Builds API calls and trigger semantics.
- `reproducible-locally` — for the verification section; the local astro build
  and `versions upload --dry-run` cover the build side, the two re-triggered
  Cloudflare builds plus the step 6 whole-window deployment diff and version
  count tripwire cover the deploy side.
- `git-commit` — when committing the doc updates and both plan files.
