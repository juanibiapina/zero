# ZeroErrors design

ZeroErrors is lightweight error tracking for the Zero dashboard. It receives
exceptions over HTTP, groups repeats into issues, and records the most recent
occurrences. It shares Vault API keys and Clerk organization tenancy.

## Runtime

Errors runs inside the surviving `zerovault-api` Worker (`apps/vault-api`,
package `@zero/dashboard-api`), alongside Vault. The dashboard SPA is
`apps/dashboard-web` and exposes Errors at `/errors/*`.

- Public ingest: `POST https://api.zeroapps.dev/errors/v1/errors`
- Public issue list: `GET https://api.zeroapps.dev/errors/v1/issues`
- Dashboard list/detail/status: `/api/errors/issues/*` on `dash.zeroapps.dev`
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
