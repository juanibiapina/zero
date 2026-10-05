# ZeroErrors design

ZeroErrors is lightweight error tracking for the Zero dashboard. It receives
exceptions over HTTP, groups repeats into issues, and records the most recent
occurrences. It shares Vault API keys and Clerk organization tenancy.

## Runtime

Errors runs inside the surviving `zerovault-api` Worker (`apps/zeroapps-api`,
package `@zeroapps/api`), alongside Vault. The dashboard SPA is
`apps/zeroapps-dashboard-web` and exposes Errors at `/errors/*`.

- Public ingest: `POST https://api.zeroapps.dev/errors/v1/errors`
- Public issue list: `GET https://api.zeroapps.dev/errors/v1/issues`
- Public issue delete: `DELETE https://api.zeroapps.dev/errors/v1/issues/{id}`
- Public issue status: `PATCH https://api.zeroapps.dev/errors/v1/issues/{id}`
- Dashboard list/detail/status/delete: `/api/errors/issues/*` on `dash.zeroapps.dev`
- Shared types and fingerprinting: `packages/errors-core`

The Worker uses the shared `APIKEYS` KV namespace to validate `zv_` keys and its
own `ERRORS_RATE_LIMITER` namespace. Browser routes use the current Clerk
session. Both resolve the active `orgId` and route to
`ERRORSDO.idFromName(orgId)`.

## Data model

One `ErrorsDO` exists per organization. `issues` stores a fingerprint, project,
title, level, status, counts, and first/last-seen timestamps. `events` stores
individual messages, stack traces, JSON context, user ID, and timestamp. Only
the newest 50 events for an issue are retained.

`ErrorsService` validates the report, computes the fingerprint, writes through
the Durable Object, and uses `waitUntil` to notify on a new issue or a
regression. `LogNotifier` is the shipped notifier.

## Error report

```json
{
  "project": "my-app",
  "message": "Cannot read record",
  "stack": "Error: ...",
  "level": "error",
  "context": { "route": "/records/1" }
}
```

Ingest returns `202` with `{ "issueId", "isNew" }`. A new event for a resolved
issue automatically reopens it.

## Deleting an issue

`DELETE /errors/v1/issues/{id}` (API key) and `DELETE /api/errors/issues/{id}`
(Clerk session) share one handler and return `204` with an empty body, or
`404 {"error":"Issue not found"}` when the id is unknown in the caller's org.
Both surfaces reach only `ERRORSDO.idFromName(orgId)`, so an id from another org
resolves to a different store and 404s.

The delete is hard: `ErrorsDO.deleteIssue` removes the event rows and then the
issue row inside one `db.transaction`, so the store can never hold an issue whose
event tail was dropped, and the result does not depend on whether DO SQLite
enforces the declared `ON DELETE CASCADE`. There is no tombstone: the
fingerprint is freed, so the next report of the same error takes the insert
branch in `record()` and produces a new issue id with `count` 1 and a fresh "new
issue" notification. Deleting the last issue carrying a project label also
removes that project from the console, since `project` is only a column value.

Retention caveat, which the product copy and docs must not overstate: the delete
clears the active tables, not every trace of the issue. `LogNotifier` writes the
issue id, project, title, level, and count to Workers Logs on a new or regressed
issue (retained up to 7 days), and the Durable Object's point-in-time recovery
can restore the store to any moment in the past 30 days.

## Resolving an issue

`PATCH /errors/v1/issues/{id}` (API key) and `PATCH /api/errors/issues/{id}`
(Clerk session) share one handler. The body is `{"status":"open"|"resolved"}`;
anything else is `400 {"error":"Invalid status"}`. The response is
`200 {"issue": ...}` with the updated issue, or `404 {"error":"Issue not found"}`
when the id is unknown in the caller's org — including an id belonging to another
org, since both surfaces reach only `ERRORSDO.idFromName(orgId)`.

Resolving is not a tombstone: a new event for a resolved issue reopens it and
counts as a regression for notification purposes.
