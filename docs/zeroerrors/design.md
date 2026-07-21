# ZeroErrors — Design

Minimal error tracking for personal apps: a stripped-down Sentry replacement.
Receive exceptions over HTTP, group repeats into issues, notify on the first
occurrence of a new issue. No SDKs, no source maps, no performance tracing.

Part of the "Zero" product suite. It shares authentication with ZeroVault: the
same `zv_` API key that unlocks the vault also authorizes error ingest, and
errors are scoped to the same Clerk **org** as the key.

- **API worker:** `apps/errors-api` (`@zero/errors-api`)
- **Dashboard:** `apps/errors-web` (`@zero/errors-web`), served as static
  assets by the api worker
- **Shared types + fingerprint:** `packages/errors-core` (`@zero/errors-core`)
- **Custom domain:** `zeroerrors.juanibiapina.dev`
- **Dev ports:** 5177 (web) / 8791 (api), inspector 9234

## Suite substrate

ZeroErrors was the forcing function for extracting the suite's shared packages,
consumed by both ZeroVault and ZeroErrors:

- **`@zero/auth`** — shared `zv_` key validation. `validateApiKey(apikeys,
  authHeader)` takes the `APIKEYS` KV binding directly (not a whole `Env`) and
  returns `{ orgId, userId }` for a valid v2 key, else `null` (legacy v1 keys
  rejected). Key lifecycle (create/revoke) stays in ZeroVault; every other
  product only reads, so revocation propagates for free.
- **`@zero/ui`** — the web shell: Clerk `AuthProvider`, shadcn `ui/*`
  primitives, the `fetchApi` client, sign-in/up pages, and a parameterized
  `AppLayout` (brand + nav as props). Both dashboards are one visual family.
  Import the theme with `import "@zero/ui/styles.css"` and add
  `@source "../../../packages/ui/src"` so Tailwind emits the shell's classes.

## Authentication

The ZeroErrors worker binds the **same** `APIKEYS` KV namespace as ZeroVault
(id `7c218b0980404d559204b24f9e0f1a47`). It reads keys, never writes them.

- `/v1/*` (public API): `zv_` key auth via `@zero/auth`, plus a per-org rate
  limit (`RATE_LIMITER`, `namespace_id: 3001` — a distinct account-global slot so
  products do not share a budget).
- `/api/*` (dashboard): Clerk JWT; org comes from the active session, 403 if none.

The `orgId` from the validated key is the tenant. Errors route to
`ERRORSDO.idFromName(orgId)`. `userId` is kept for attribution only.

## Data model

One `ErrorsDO` **per org**. No project registry — `project` is a freeform label
on each event, so no registration step and no cross-DO orchestration. Uses
`do-orm` (`createDb`/`migrate`, SQL migration files). Two tables:

- `issues` — one row per distinct fingerprint (the grouped bug): `id`,
  `fingerprint` (unique), `project`, `title`, `level`, `status` (`open` |
  `resolved`), `count`, `first_seen_at`, `last_seen_at`.
- `events` — individual occurrences, capped at the newest 50 per issue (older
  ones pruned): `id`, `issue_id`, `message`, `stack`, `context_json`, `user_id`,
  `created_at`.

### Fingerprinting

`fingerprint()` (in `@zero/errors-core`) is a pure function:
`sha256(project + normalize(message) + firstStackFrame(stack))`. Normalization
strips per-occurrence noise (uuids, long hex, bare numbers) so the same bug with
varying ids collapses to one fingerprint, while different project/message/frame
do not. Lives in core so it is unit-testable in isolation.

## Ingest

`POST /v1/errors` (API-key auth + per-org rate limit). Body:

```jsonc
{
  "project": "trippycards",      // required, freeform label
  "message": "Cannot read ...",  // required
  "stack": "Error: ...",         // optional
  "level": "error",              // optional, default "error"
  "context": { "route": "/x" }   // optional JSON
}
```

Flow in `ErrorsService`:

1. Validate with Zod (`errorReportSchema`).
2. Compute the fingerprint.
3. `ErrorsDO.record(...)` upserts the issue (insert new, or bump `count` +
   `last_seen_at`), inserts the event, prunes old events, and returns
   `{ issue, isNew, isRegression }`. A new occurrence on a resolved issue
   auto-reopens it (`isRegression`).
4. On `isNew || isRegression`, fire a notification via `waitUntil` (never blocks
   the response, never fails the request).

Response: `202 Accepted` with `{ issueId, isNew }`.

### DO RPC note

`ErrorsDO.getIssue` returns `StoredEvent` rows (primitive fields, raw
`contextJson` string). Cloudflare's RPC types reject recursive JSON types, so
parsing to `EventSummary` (with a `JsonObject` context) happens at the HTTP layer
via `toEventSummary`.

## Notifications

The channel is deferred behind a `Notifier` **port**:

```ts
interface Notifier {
  notify(issue: IssueSummary, kind: "new" | "regression"): Promise<void>;
}
```

`LogNotifier` (the only adapter shipped) `console.log`s the issue, visible via
`wrangler tail` / `bin/cflogs`. The service decides *when* to notify; the adapter
decides *how*. Future `TelegramNotifier` / `EmailNotifier` are one file each.

## Read + resolve API

- `GET /v1/issues`, `GET /api/issues` — list an org's issues (filter by
  `project`, sorted by last seen).
- `GET /api/issues/:id` — issue detail with recent events (parsed context).
- `PATCH /api/issues/:id` — resolve/reopen (`{ "status": "open" | "resolved" }`).

## Dashboard

`apps/errors-web`, built on `@zero/ui`: an issues list (project filter,
sorted by last seen) and an issue detail view (recent events with message, stack,
context, time) plus a resolve/reopen toggle.

## Reporting from this monorepo

The TrippyCards worker reports exceptions to ZeroErrors from its `.onError()`
handler, alongside Sentry (side-by-side). The reporter
(`apps/worker/src/reporting/zeroErrors.ts`) fires a fire-and-forget
`POST /v1/errors` via `waitUntil`, guarded on the `ZEROERRORS_KEY` secret so it
is a no-op when unset. See [Sentry](../guides/sentry.md).

## Secrets

Managed through ZeroVault like every other secret (see
[Secrets](../guides/secrets.md)).

- `zeroerrors` project → api worker (`CLERK_PUBLISHABLE_KEY`,
  `CLERK_SECRET_KEY`, `ENVIRONMENT`).
- `zeroerrors-web` project → dashboard build (`VITE_CLERK_PUBLISHABLE_KEY`).
- `ZEROERRORS_KEY` in `trippycards-worker` (production) → the worker's reporting
  key.

`bin/fetch-secrets` pulls dev/build values locally; `bin/sync-secrets-to-cloudflare`
pushes the api worker's production secrets to Cloudflare.

## Open decisions

- **Notification channel** (Telegram vs email vs both) — deferred behind the
  `Notifier` port; `LogNotifier` until chosen.
- **Sentry retirement** — currently side-by-side on the TrippyCards worker only;
  other workers remain Sentry-only. Retire once ZeroErrors is proven.
- **Event retention** — cap per issue (default 50) vs time-based prune.
