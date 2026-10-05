# Workers deploy ops

Deploy-time Cloudflare Workers operational facts for this repo: behaviors
that are easy to get wrong.

## API Workers build with Vite, Wrangler deploys

`zeroapps-api` builds with Vite and the Cloudflare Vite plugin
(`@cloudflare/vite-plugin`); its `vite.config.ts` reads `wrangler.jsonc`, which
stays the only Worker config. `vite build` writes the bundle and an output
config to `dist/<worker>/` (for example `dist/zeroapps_api/wrangler.json`) and a
redirect at `.wrangler/deploy/config.json`. A plain `wrangler deploy`,
`wrangler versions upload` or `wrangler deploy --dry-run` follows the redirect and
ships the Vite output.

- **Missing redirect means a silent source build.** Without
  `.wrangler/deploy/config.json`, Wrangler bundles `src/index.ts` itself and
  reports success. Turbo lists `.wrangler/deploy/**` as a build output next to
  `dist/**` so a cache hit restores it. Commands that must read the source
  config pass `--config wrangler.jsonc` (`cf-typegen` does).
- **No secrets in `dist/`.** For `vite preview` the plugin copies local secrets
  into `dist/<worker>/.dev.vars`, from `.dev.vars` or, when that is absent, from
  the process environment. `vite.config.ts` deletes that file from the build
  output. To preview the build with secrets, mount them there instead:
  `zero vault run -p <project> -e development --mount dist/<worker>/.dev.vars -- vite preview`.
- **Vite ignores Wrangler `rules`.** `.sql` imports still work because the
  plugin follows Wrangler's default module rules, which treat `**/*.sql` as text.
- **`dev` runs `vite dev`.** Port and inspector port live in `vite.config.ts`
  (`server.port`, `cloudflare({ inspectorPort })`); `.dev.vars` is read through
  Wrangler's own reader, so the `zero vault run --mount .dev.vars` pipe works
  unchanged (see `docs/secrets.md`).

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

The teardown only applies to a domain the Worker still owns. To move a custom
domain to another Worker, reassign it first with
`PUT /accounts/{account_id}/workers/domains` and
`"override_existing_origin": true`; the switch drops no requests. After that, a
deploy of the old Worker without the entry leaves the domain on the new Worker.

## A route beats a custom domain on the same hostname

A zone route (`"pattern": "host/path*", "zone_name": ...`) takes precedence over
a custom domain on the same hostname, and the most specific route wins. That is
how one hostname is split between Workers by path: the custom domain catches
every path, and routes claim the paths that belong to another Worker. A route
pattern matches the whole URL, query string included, so end it with `*`.

## Rename a Worker in place, never through `name` alone

Changing `name` in `wrangler.jsonc` and deploying creates a second Worker; the
old one keeps its Durable Object data, secrets, custom domains and build
connector. Rename the Worker first with
`PATCH /accounts/{account_id}/workers/workers/{worker_id}` and `{"name": "<new>"}`,
then land the `name` change before anything else deploys. The Worker keeps its
id, Durable Object namespaces and data, secrets, custom domains, routes and
build connector. Durable Object namespace names keep the old prefix (for
example `zerovault-api_OrgDO` under `zeroapps-api`); only the label is stale.

Evidence for this section and the previous two: scratch Workers on 2026-10-05,
deleted afterwards.

## A branch that adds a Durable Object migration always fails its preview build

`wrangler versions upload` refuses a version whose `wrangler.jsonc` contains a
new `migrations[]` tag:

```
Version upload failed. You attempted to upload a version of a Worker that
includes a Durable Object migration, but migrations must be fully applied via a
non-versioned deployment. [code: 10211]
```

The non-production triggers for `zero-api`, `zeroapps-landing` and `zeroapps-docs` all
run `versions upload` on purpose (a branch push must not route production
traffic — see AGENTS.md). So a branch that introduces a new DO class, or any
other migration tag, gets a red **Workers Builds** check on its PR that no code
change can fix. The same commit deploys fine on `main`, where the default-branch
trigger runs `wrangler deploy` and applies the migration.

Observed 2026-07-30 on PR #40 (`v7`, `new_sqlite_classes: ["ScheduleDO",
"LearningDO"]`). Do not "fix" it by switching the preview trigger to `deploy`:
that is exactly the mistake that would land a branch on production. Read the red
check, confirm from the build log that 10211 is the only failure, and merge.
