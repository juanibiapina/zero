# Verification: zero-docs Dependabot build plan

Date: 2026-07-28
Plan reviewed: `docs/plans/zero-docs-dependabot-build.md`

## Verdict

The diagnosis and chosen deploy commands are correct. The plan has two blockers:
the manual-build request is missing its required body, and the zero-api trigger
change is not verified during this work. Five nits cover overstatements and test
hygiene.

No Cloudflare trigger was patched. No build was started and no Worker version was
uploaded. Cloudflare checks below used GET requests. Local Wrangler checks used
`--dry-run`.

## Findings

### BLOCKER 1: the manual zero-docs build request is incomplete

Step 4 names
`POST /accounts/{account_id}/builds/triggers/{trigger_uuid}/builds` and says it
is "for branch" `dependabot/npm_and_yarn/minor-and-patch-7b5d1c96b7`, but it
does not provide a request body (`docs/plans/zero-docs-dependabot-build.md:207`).
The current Cloudflare OpenAPI schema marks the body as required. The body must
contain either `branch` or `commit_hash`:

```json
{
  "anyOf": [
    { "required": ["commit_hash"] },
    { "required": ["branch"] }
  ]
}
```

A POST without that body cannot perform step 4. The plan needs an explicit JSON
body before it is executable.

Evidence: Cloudflare `api-schemas` commit
[`c92b9b0`](https://github.com/cloudflare/api-schemas/commit/c92b9b0fde23ae00fece2025662f96dc8e2d6283),
operation `createManualBuild`, schema `builds_CreateBuildRequest`.

### BLOCKER 2: the zero-api patch has no in-plan remote verification

The plan patches zero-api in step 3, but only starts a zero-docs build in step 4.
Its zero-api acceptance criterion waits for "the next non-`main` build"
(`docs/plans/zero-docs-dependabot-build.md:248`). That leaves the second remote
change and its production-safety claim unproved when the work ends.

The plan needs to snapshot zero-api's active deployment, manually run the
non-production trigger on a known branch after the PATCH, require a successful
`Worker Version ID`, then compare the active deployment ID and traffic
percentages before and after. The current GET endpoint for this check is
`/accounts/{account_id}/workers/scripts/zero-api/deployments`.

This matters because the current trigger is a false green. Build
`1fc57e47-8d63-49e3-9073-33bb90d8cc14` says:

```text
Executing user deploy command: pnpm -F @zero/api run deploy
No projects matched the filters in "/opt/buildhome/repo"
Success: Deploy command completed
```

The matching local command also returned exit status 0.

### NIT 1: "every non-main build failed" is overstated

The summary says every non-`main` zero-docs build failed the same way
(`docs/plans/zero-docs-dependabot-build.md:14`). The API has 12 non-production
build records since the connector was attached: 9 failed after completing the
Astro build, and 3 were skipped by watch-path matching. All 9 executed builds
failed with the same missing-entry-point error. The later evidence section has
the correct "fail (or skipped)" qualification.

### NIT 2: `/builds/triggers` exists, but it has no GET operation

The plan says `/builds/repos` and `/builds/triggers` "do not exist"
(`docs/plans/zero-docs-dependabot-build.md:28`). The exact old GET requests do
return `12000 Not found`, but `/accounts/{account_id}/builds/triggers` is a real
collection path with a POST operation. The precise correction is that those GET
operations do not exist. The OpenAPI schema also exposes the repository
collection as `/builds/repos/connections`, not `/builds/repos`.

### NIT 3: the local Wrangler check should use the exact target verb

The plan uses `wrangler deploy --dry-run` as a stand-in for `versions upload`
(`docs/plans/zero-docs-dependabot-build.md:237`). Wrangler 4.103.0 supports
`wrangler versions upload --dry-run`, and the exact proposed command succeeds:

```text
$ pnpm -F @zero/docs exec wrangler versions upload --dry-run
Wrangler 4.103.0
Total Upload: 0.45 KiB / gzip: 0.32 KiB
--dry-run: exiting now.
```

The existing stand-in also succeeds and reports 81 asset files, so this is test
precision rather than a strategy error.

### NIT 4: the token's write scope is asserted but not independently proved

The environment token is active, `wrangler whoami` resolves account
`4e04b64af4013414441c59014392bea0`, and every required GET request succeeds.
Cloudflare does not expose this token's policies to the token itself; fetching
its token record returned `9109 Unauthorized`. PATCH and POST operations exist
in the OpenAPI schema, but their authorization could not be tested without the
mutations prohibited for this review. The plan should treat write scope as a
precondition checked when the first PATCH runs, not as a fact already proved.

### NIT 5: the final git-status criterion is imprecise

After step 7 commits the files, `git status --short` should be empty. "Clean
apart from the intended commits" (`docs/plans/zero-docs-dependabot-build.md:252`)
mixes working-tree state with commit history.

## Cloudflare source evidence

### Trigger configurations

These values came from
`GET /accounts/4e04b64af4013414441c59014392bea0/builds/workers/{script_tag}/triggers`.
All seven triggers use repository `juanibiapina/zero`, root directory `/`, and
an empty `path_excludes` list.

#### zero-api, script tag `8cbffe866be144fea3c6fff9aaa03527`

- Non-production, UUID `6c21787a-3bdd-4a85-9b47-8108ef67e871`
  - branches: include `*`, exclude `main`
  - build: `pnpm run build`
  - deploy: `pnpm -F @zero/api run deploy`
  - paths: `apps/agent-api/*`, `apps/agent-web/*`,
    `packages/typescript-config/*`, `patches/*`, `turbo.json`,
    `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json`
  - build cache: disabled
  - build variables: `VITE_CLERK_PUBLISHABLE_KEY` (secret),
    `VITE_TELEGRAM_BOT_USERNAME` (plain)
- Default branch, UUID `e040ba2a-11db-4734-80cd-ad4c5eb2b7be`
  - branches: include `main`, exclude none
  - build: `pnpm run build`
  - deploy: `pnpm -F @zero/agent-api run deploy`
  - paths, cache, and build-variable names match the non-production trigger

#### zerovault-api, script tag `fd0d43af779344199e62ba9f6483791a`

- Default branch only, UUID `63a91d0c-20f9-4f80-bd25-db19dc6f9aae`
  - branches: include `main`, exclude none
  - build: `pnpm run build`
  - deploy: `pnpm -F @zero/dashboard-api run deploy`
  - paths: `apps/vault-api/*`, `apps/dashboard-web/*`, `packages/auth/*`,
    `packages/vault-core/*`, `packages/errors-core/*`, `packages/ui/*`,
    `packages/typescript-config/*`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
    `turbo.json`, `package.json`, `patches/*`
  - build cache: disabled
  - build variables: `VITE_CLERK_PUBLISHABLE_KEY` (plain)
- There is no non-production trigger.

#### zero-landing, script tag `5a35f798b34a4ffa9ad8273dbba5ce60`

- Non-production, UUID `e63c7289-fa16-43e6-95d6-0efb8b5982e9`
  - branches: include `*`, exclude `main`
  - build: `pnpm -F @zero/landing run build`
  - deploy: `pnpm -F @zero/landing exec wrangler versions upload`
  - paths: `apps/landing/*`, `packages/typescript-config/*`,
    `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `package.json`,
    `patches/*`
  - build cache: disabled; no build variables
- Default branch, UUID `d739a272-947d-4cf2-96bc-4aafae368367`
  - branches: include `main`, exclude none
  - build: `pnpm -F @zero/landing run build`
  - deploy: `pnpm -F @zero/landing run deploy`
  - paths, cache, and build variables match the non-production trigger

#### zero-docs, script tag `d3e9e3885feb4f30a36f70872dd77455`

- Non-production, UUID `2eec7eac-dcf9-442d-9fa8-a3f3a0bed31b`
  - branches: include `*`, exclude `main`
  - build: `pnpm -F @zero/docs run build`
  - deploy: `npx wrangler versions upload`
  - paths: `apps/docs/*`, `packages/typescript-config/*`, `pnpm-lock.yaml`,
    `pnpm-workspace.yaml`, `turbo.json`, `package.json`, `patches/*`
  - build cache: enabled; no build variables
- Default branch, UUID `683b948e-b58b-4f55-b3c9-2da053c86f93`
  - branches: include `main`, exclude none
  - build: `pnpm -F @zero/docs run build`
  - deploy: `pnpm -F @zero/docs run deploy`
  - paths, cache, and build variables match the non-production trigger

The production and non-production UUIDs are distinct. Patching the two UUIDs in
the plan cannot alter either production trigger unless the wrong UUID is sent.
A partial PATCH body containing only `deploy_command` is valid according to
`builds_UpdateTriggerRequest`.

### Failing zero-docs build

Build `7fed1fab-8755-4f50-8da5-73738cebbfa5` is a stopped failure from trigger
`2eec7eac-dcf9-442d-9fa8-a3f3a0bed31b`, branch
`dependabot/npm_and_yarn/minor-and-patch-7b5d1c96b7`, commit
`19da99da3c04b50dcc03ebfa28fdce3d1835f706`:

```text
14:39:28 [build] 12 page(s) built in 3.35s
14:39:28 [build] Complete!
Success: Build command completed
Executing user deploy command: npx wrangler versions upload
npm warn exec The following package was not found and will be installed: wrangler@4.114.0

 ⛅️ wrangler 4.114.0
────────────────────

✘ [ERROR] Missing entry-point to Worker script or to assets directory

Failed: error occurred while running deploy command
```

All 9 executed non-production builds contain `[build] Complete!`, the same
deploy command, and the same missing-entry-point error. This confirms that the
Dependabot bump did not break the Astro build and that the trigger command is
the cause.

### Landing comparison

On the same commit, zero-landing build
`75a309d1-eed1-42a1-8c7f-3592cb3bfd32` succeeded:

```text
Success: Build command completed
Executing user deploy command: pnpm -F @zero/landing exec wrangler versions upload
 ⛅️ wrangler 4.103.0
Uploaded zero-landing (2.07 sec)
Worker Version ID: d032b6d4-4440-4fec-bff4-d5d931cbee12
Success: Deploy command completed
```

The uploaded branch version has `has_preview: true` and annotation
`workers/triggered_by: version_upload`. It is not in zero-landing's active
deployment. The active deployment still routes 100% to version
`18441418-f68d-4ac7-8fb4-64235869e624`.

## Command and package checks

The package names match:

- `apps/agent-api/package.json:2`: `@zero/agent-api`
- `apps/docs/package.json:2`: `@zero/docs`
- `apps/landing/package.json:2`: `@zero/landing`
- `apps/vault-api/package.json:2`: `@zero/dashboard-api`
- No workspace package is named `@zero/api`.

`pnpm -F` runs `exec` in the selected package directory and resolves its local
binary:

```text
$ pnpm -F @zero/docs exec pwd
/home/juan/workspace/juanibiapina/zero/apps/docs
$ pnpm -F @zero/docs exec which wrangler
/home/juan/workspace/juanibiapina/zero/apps/docs/node_modules/.bin/wrangler
$ pnpm -F @zero/docs exec wrangler --version
4.103.0
```

`apps/docs/wrangler.jsonc:3-9` names `zero-docs` and configures
`assets.directory` as `./dist`. The exact filtered `versions upload --dry-run`
completed without a positional asset path, proving that Wrangler loaded that
configuration. The same dry run also succeeded for `@zero/agent-api`, loading
its entry point, assets, Durable Object, KV, R2, Analytics Engine, and AI
bindings.

## `versions upload` safety and cost

Cloudflare's current documentation says:

- A version captures code, static assets, bindings, and compatibility settings.
- A deployment chooses the version or versions that receive traffic.
- `wrangler deploy` creates a version and immediately sends 100% of traffic to
  it.
- `wrangler versions upload` creates a version that is not automatically
  deployed.
- Workers Builds uses `npx wrangler versions upload` as the default
  non-production deploy command and describes it as creating a preview version
  "without promoting it to production."

Sources:

- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Versions and deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/)
- [Wrangler Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [Workers Builds limits and pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)

The proposed zero-api command therefore cannot reassign production traffic. It
will consume Workers Builds minutes and create a stored Worker version containing
the uploaded code/configuration and assets. A version upload can create a preview
URL when previews are enabled. Current zero-api deployed-version metadata has
`has_preview: false`; docs and landing have previews enabled. No request traffic
or Worker execution is caused by the upload itself.

The main zero-api trigger is UUID `e040ba2a-...`; the plan targets preview UUID
`6c21787a-...`. The main command remains
`pnpm -F @zero/agent-api run deploy`. Production safety still needs the
before/after deployment check in BLOCKER 2.

## Builds API endpoint check

The current API and Cloudflare OpenAPI schema agree:

| Method and path | Result |
|---|---|
| `GET /workers/services/{worker_name}` | Worked; returned each `script_tag`. |
| `GET /builds/workers/{external_script_id}/triggers` | Worked for all four Workers. |
| `GET /builds/workers/{external_script_id}/builds?per_page=N` | Worked for docs, landing, and zero-api history. |
| `GET /builds/builds/{build_uuid}/logs` | Worked for the quoted logs. |
| `POST /builds/triggers/{trigger_uuid}/builds` | OpenAPI operation `createManualBuild`; required body noted in BLOCKER 1. Not called. |
| `PATCH /builds/triggers/{trigger_uuid}` | OpenAPI operation `updateTrigger`; `deploy_command` is an allowed optional field. Not called. |

The plan's endpoint correction is operationally sound after the wording nit.
The OpenAPI parameter is named `external_script_id`; the service's `script_tag`
works as that value and matches `external_script_id` in every trigger response.

## Plan hygiene and PR #38

- The diagnosis, target UUIDs, proposed commands, patch/readback order, docs
  updates, and rollback data are consistent.
- The docs build acceptance criteria are decisive and falsifiable.
- The zero-api criterion is not completed by the steps, as covered by BLOCKER 2.
- No changelog entry is correct. `AGENTS.md:13-21` excludes internal CI and
  infrastructure changes, and the production docs trigger is already green.
- PR #38 is independent of this trigger repair. It remains open with no review
  decision. Its two GitHub Actions jobs did not start because of an account
  billing/spending-limit error, while the zero-docs Cloudflare check failed for
  the trigger defect. The dependency PR still needs its normal review and a
  successful CI rerun before merge. Fixing the Cloudflare triggers should not
  merge it automatically and does not establish that all 31 dependency updates
  are acceptable.

## Round 2

Date: 2026-07-28

### Verdict

One blocker remains. The manual-build request blocker is closed. The zero-api
verification now exercises the real trigger and checks production state, but its
concurrent-`main` fallback does not prove that the preview version never served
traffic. No new wrong endpoint, jq path, package name, or directly
production-routed command was introduced.

No Cloudflare trigger was patched and no build was started. The Cloudflare checks
in this round were GET requests. Local Wrangler checks used `--dry-run`.

### CLOSED: manual build POST body

The quoted schema is real and current. At `cloudflare/api-schemas` commit
`c92b9b0fde23ae00fece2025662f96dc8e2d6283`, which remains the latest commit for
`openapi.json`, operation `createManualBuild` is exactly:

- `POST /accounts/{account_id}/builds/triggers/{trigger_uuid}/builds`
- `requestBody.required: true`
- content type `application/json`
- schema `builds_CreateBuildRequest`
- `anyOf` requiring `commit_hash` or `branch`

The command in step 4 is correct: `AUTH` supplies `Content-Type:
application/json`, `-d "{\"branch\":\"$BRANCH\"}"` satisfies the schema, and
the branch still exists on `origin` at the stated full commit
`19da99da3c04b50dcc03ebfa28fdce3d1835f706`. The response path
`.result.build_uuid`, polling path `.result | {status, build_outcome}`, and log
path `.result.lines[][1]` match the same OpenAPI schema. This closes previous
BLOCKER 1.

### BLOCKER: the zero-api traffic-safety comparison is not decisive under its own concurrent-main exception

Steps 1, 5, and 6 close the original false-green gap when no other deployment
runs: the preview build must produce a version, and an accidental `wrangler
deploy` would replace `.result.deployments[0]`, so the active-deployment diff
would fail. Cloudflare documents this first array entry as the latest deployment
actively serving traffic, and the live GET response has the exact path and
shape used by the plan.

The remaining hole is the exception at
`docs/plans/zero-docs-dependabot-build.md:411`. Consider this ordering:

1. The baseline deployment is recorded.
2. A wrong preview command deploys the preview version at 100%.
3. A legitimate `main` deployment supersedes it before the after snapshot.

The after snapshot then shows the legitimate `main` deployment as active. The
plan's fallback checks that current active version and that the preview version
is absent only from the current active deployment. It never checks whether the
preview version appears in any deployment created during the interval. The
preview version could therefore have served production traffic briefly and no
longer appear in `.result.deployments[0]`.

The array-length instruction does not close this hole. A legitimate `main`
deployment also grows history, and the current endpoint response already
contains 10 entries, so length alone neither attributes a new deployment nor
identifies its routed version. The proof needs either a deployment-free window
or a comparison of all deployment IDs and routed version IDs created after the
baseline, requiring the preview version ID to appear in none of them. Until
then, previous BLOCKER 2 is improved but not genuinely closed.

### Five prior nit resolutions

1. **Closed, count wording:** the live build-history GET still returns 12 docs
   non-production records, exactly 9 `fail` and 3 `skipped`. The revised summary
   is accurate.
2. **Closed, endpoint wording:** the cited OpenAPI schema has POST only on
   `/builds/triggers`, PUT on `/builds/repos/connections`, DELETE on
   `/builds/repos/connections/{repo_connection_uuid}`, and no GET on either
   collection. The correction is accurate.
3. **Closed, exact local verb:** both exact target commands succeed locally with
   Wrangler 4.103.0 and `--dry-run`. Docs reports `Total Upload: 0.45 KiB`; agent
   reports its entry point, assets, Durable Object, KV, R2, Analytics Engine,
   and AI bindings. Neither command made a network write.
4. **Closed, token scope:** Workers CI Read is proved by the GETs, while Workers
   CI Write remains an explicit precondition for PATCH and POST. The schema tags
   both write operations `Workers CI Write`.
5. **Partly closed, final tree check:** `git status --short` and `git show --stat
   HEAD` now test the right concepts, but step 9 names `AGENTS.md`, the
   investigation doc, and the plan while omitting this verification report.
   Both plan files are currently untracked, so following the stated commit scope
   literally leaves this report behind and makes the required empty status fail.
   This is a nit, not a trigger-repair blocker.

### New-blocker scan

No additional blocker was introduced. The PATCH UUIDs still identify only the
two non-production triggers; their default-branch UUIDs are distinct. The
proposed package names exist (`@zero/docs` and `@zero/agent-api`), both filtered
`versions upload --dry-run` commands resolve their package-local Wrangler
configuration, the GET and POST paths exist, and the jq paths match live
responses or the cited schema. `wrangler versions upload` creates an unrouted
version and does not apply Durable Object lifecycle migrations; the only
traffic-safety defect is the unresolved historical-deployment proof above.

## Round 3

Date: 2026-07-28

### Verdict

One blocker remains. The contract citations and control-plane checks are sound,
and NIT 5 is closed. The new GraphQL positive-control requirement cannot pass
against the current production version, so the data-plane layer is not yet an
executable acceptance check. No other new blocker was found.

### BLOCKER: the GraphQL positive control is empty for the current production version

The exact `workersInvocationsAdaptive` query and jq path work live, but the
current production version `1489ac2c-6bd2-4bb7-b689-c80566247a82` returns
`errors: null` and `[]` over the last 24 hours and the last 28 days. Step 6c
requires that version to return a non-empty row and says an empty control makes
6c prove nothing. A known historical version,
`42985281-f66a-4090-8575-c650cedff4ac`, returns two requests through the same
query, so `scriptVersion` is valid; the defect is the choice of a low-traffic
current version as the required positive control. Use a known-positive version
and interval, or deliberately invoke the production version and wait for
analytics ingestion, before treating 6c as decisive.

### Closed checks

- Cloudflare's cited pages state that deployments route traffic, `versions
  upload` does not deploy immediately, and version upload without deployment is
  a supported path. The live deployments GET still returns 10 records with
  `result_info: null`, ignores `page=2&per_page=3`, and the versions GET returns
  `result_info.total_count: 502`. The whole-window diff plus the exact `+1`
  version-count tripwire is sound within the plan's stated rotation fallback.
- NIT 5 is closed. Both plan files are untracked, and step 9 now lists both of
  them in the four-file commit, so the post-commit clean-tree check is
  achievable.
