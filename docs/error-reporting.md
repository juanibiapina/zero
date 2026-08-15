# Agent error reporting

The agent Worker reports its own failures to ZeroErrors, project `zero-agent`.
Read them at `https://dash.zeroapps.dev/errors`. One function does the reporting:
`apps/agent-api/src/reporting/zero-errors.ts`.

## What gets reported

Report a failure when **the user experienced it** (they got a fallback, a notice,
or no reply at all) or when **work was permanently lost**. Everything else is a
log line, not an issue.

Not reported, on purpose:

- Rejected user input: sign-in required, oversize file, invalid PDF, full file
  quota, a rejected Telegram link. The system worked; the input did not qualify.
- A failed attempt that will be retried. Nothing is lost yet. Only the give-up
  reports.
- Durable Object resets (see below).

## Sites

`context.site` names the failure. Ids (`clerk_user_id`, `chat_id`, `topic_id`)
ride in context; no message content, tool results or request bodies are ever
sent.

| `site` | Level | Meaning |
|---|---|---|
| `http` | error | An HTTP route threw. |
| `alarm_turn` | error | UserDO's alarm loop threw around turn draining. |
| `turn` | error | The agent path threw; the user got the fallback message. |
| `turn_rate_limited` | warning | A 429/529 turn failure; the user got the rate-limit notice. Upstream capacity, not our defect. |
| `schedule_gave_up` | error | A deadline failed its 6 dispatch attempts. The work is gone. |
| `onboarding` | error | Google onboarding failed; status is `failed`. |
| `admin_task` | error | An admin task failed; status is `failed`. |
| `file_download` | warning | Telegram refused a file the user sent; they got a notice instead of their attachment. |
| `learning` | error | A LearningDO alarm slice threw. |

An issue's **level is stamped when the issue is created** and never changes. A
message that first arrives as a `warning` stays a warning even if a later report
of the same fingerprint says `error`.

A LearningDO failure rethrows after reporting, so Cloudflare's alarm retry still
runs. Those retries fingerprint to the same issue: one bad job is one issue with
up to six events, not six issues.

## Durable Object resets are never reported

Every deploy tears down in-flight Durable Objects with `Durable Object reset
because its code was updated`. That is deploy noise, and it reaches the reporter
through several doors (turns, learning slices, schedule RPCs), so the filter
lives in the reporter itself (`isDurableObjectReset`, `src/do/retry.ts`) rather
than at any one call site. Skipped reports log `error_report_skipped`.

## The `ENVIRONMENT` gate

Nothing is sent unless `env.ENVIRONMENT === "production"`, so local runs, unit
tests and `bin/e2e-test` cannot write into the production issue list.

- Local: the `dev` script mounts `ENVIRONMENT=development` from ZeroVault
  `zero-api/development` at `apps/agent-api/.dev.vars`, for as long as
  `wrangler dev` runs.
- Production: `ENVIRONMENT=production` lives in ZeroVault `zero-api/production`
  and reaches the Worker through `bin/sync-secrets-to-cloudflare`. It is listed
  in `secrets.required` in `apps/agent-api/wrangler.jsonc`, so a deploy without
  it fails instead of silently going quiet. **Run the sync before deploying** a
  change that adds it.

## When a report does not land

Ingest rejections (400, 401, 429) log `error_report_failed` with the status in
Workers Logs. The reporter never reports its own failure — that is how a loop
starts — and its returned promise never rejects, so it cannot disturb the path it
was called from. ZeroErrors ingest is rate limited to 100 requests/min per org,
shared with every other project.
