# Workers deploy ops

Deploy-time Cloudflare Workers operational facts for this repo. Two behaviors
that are easy to get wrong.

## Force a deploy to fail on a missing secret (`secrets.required`)

Add the secret name to `secrets: { required: [...] }` in the worker's
`wrangler.jsonc`. The deploy then aborts if that secret is unset (wrangler runs
`validateSecrets`), and `wrangler dev` warns "The following required secrets have
not been set: ...". Without this entry a missing secret ships and the Worker
degrades silently with `env.X` undefined.

**Trap:** the `secrets` field is absent from wrangler's bundled
`config-schema.json` (the `$schema` the `wrangler.jsonc` files point at) and does
not appear in `wrangler deploy --dry-run`. Schema and dry-run inspection falsely
imply the field is unsupported. It is enforced at real deploy. Trust the runtime
deploy, not the schema.

Live examples in this repo:

- `apps/zeroapps-api/wrangler.jsonc` lists `secrets.required` including
  `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `ENVIRONMENT`, `MASTER_KEY`, and
  `ZERO_API_KEY`.
- `apps/zero-api/wrangler.jsonc` lists `secrets.required` including
  `ENVIRONMENT` and `ZERO_API_KEY`.

## Removing a `custom_domain` route tears down the domain + DNS on deploy

Removing a `custom_domain` entry from `routes[]` and deploying auto-deletes that
Worker custom domain and its auto-created proxied DNS record. The host goes
NXDOMAIN; other hosts attached to the same worker are unaffected. No manual
Cloudflare delete is needed.

Evidence: the `retire-zerovault-domain` task removed
`zerovault.juanibiapina.dev` and deployed (version `05a896d0`, 2026-07-23,
commit `34716c4`). The old host went NXDOMAIN, `vault.apps.juanibiapina.dev`
stayed healthy, and no manual delete was issued.

The config edit is still the source of truth: it stops a future Workers Build
deploy from re-provisioning the domain.

This corrects the earlier "additive / manual delete" claim in
`docs/plans/drop-old-console-hosts.md`.

## A branch that adds a Durable Object migration always fails its preview build

`wrangler versions upload` refuses a version whose `wrangler.jsonc` contains a
new `migrations[]` tag:

```
Version upload failed. You attempted to upload a version of a Worker that
includes a Durable Object migration, but migrations must be fully applied via a
non-versioned deployment. [code: 10211]
```

The non-production triggers for `zero-api`, `zero-landing` and `zero-docs` all
run `versions upload` on purpose (a branch push must not route production
traffic — see AGENTS.md). So a branch that introduces a new DO class, or any
other migration tag, gets a red **Workers Builds** check on its PR that no code
change can fix. The same commit deploys fine on `main`, where the default-branch
trigger runs `wrangler deploy` and applies the migration.

Observed 2026-07-30 on PR #40 (`v7`, `new_sqlite_classes: ["ScheduleDO",
"LearningDO"]`). Do not "fix" it by switching the preview trigger to `deploy`:
that is exactly the mistake that would land a branch on production. Read the red
check, confirm from the build log that 10211 is the only failure, and merge.
