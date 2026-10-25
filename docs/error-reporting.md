# Error reporting

The `zero-api` Worker reports its own failures to ZeroErrors, project
`zero-agent` (named for the retired Telegram agent).
Read them at `https://dash.zeroapps.dev/errors`. One function does the reporting:
`apps/zero-api/src/reporting/zero-errors.ts`.

## What gets reported

Report a failure when **the user experienced it** or when **work was permanently
lost**. Everything else is a log line, not an issue.

Not reported, on purpose:

- Rejected user input, such as an invalid timezone. The system worked; the input
  did not qualify.
- A failed attempt that will be retried. Nothing is lost yet. Only the give-up
  reports.
- Durable Object resets (see below).

## Sites

`context.site` names the failure. Ids (`clerk_user_id`) ride in context; no task
content or request bodies are ever sent.

| `site` | Level | Meaning |
|---|---|---|
| `http` | error | An HTTP route threw. |

An issue's **level is stamped when the issue is created** and never changes. A
message that first arrives as a `warning` stays a warning even if a later report
of the same fingerprint says `error`.

## Durable Object resets are never reported

Every deploy tears down in-flight Durable Objects with `Durable Object reset
because its code was updated`. That is deploy noise, so the filter lives in the
reporter itself (`isDurableObjectReset`, `src/do/retry.ts`) rather
than at any one call site. Skipped reports log `error_report_skipped`.

## The `ENVIRONMENT` gate

Nothing is sent unless `env.ENVIRONMENT === "production"`, so local runs, unit
tests and the mobile e2e harness cannot write into the production issue list.

- Local: the `dev` script mounts `ENVIRONMENT=development` from ZeroVault
  `zero-api/development` at `apps/zero-api/.dev.vars`, for as long as
  the dev server runs.
- Production: `ENVIRONMENT=production` lives in ZeroVault `zero-api/production`
  and reaches the Worker through `bin/sync-secrets-to-cloudflare`. It is listed
  in `secrets.required` in `apps/zero-api/wrangler.jsonc`, so a deploy without
  it fails instead of silently going quiet. **Run the sync before deploying** a
  change that adds it.

## When a report does not land

Ingest rejections (400, 401, 429) log `error_report_failed` with the status in
Workers Logs. The reporter never reports its own failure — that is how a loop
starts — and its returned promise never rejects, so it cannot disturb the path it
was called from. ZeroErrors ingest is rate limited to 100 requests/min per org,
shared with every other project.
