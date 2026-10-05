# MCP server (todo workspace for local agents)

`zero-api` serves a remote MCP server at `https://zero.juanibiapina.dev/mcp`. An
MCP client such as pi signs in as a Zero user, reads and changes that user's
Tasks, Projects, Waiting conditions, and Afters, and reads their Medicines.
Writes land in the user's `TaskDO`, so they reach mobile and web through the
normal sync.

## Connect pi

Add the server to `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "zero": {
      "url": "https://zero.juanibiapina.dev/mcp",
      "oauth": { "clientRegistration": "cimd" },
      "description": "Zero todo workspace: Tasks, Projects, Waiting conditions, Afters, Medicines"
    }
  }
}
```

Then run `pi mcp login zero`, sign in to Zero in the browser, and check the
connection with `pi mcp list`. Tools appear as `mcp__zero__<tool>`.

For the local Worker (`pnpm run dev` in `apps/agent-api`), point a second entry
at `http://localhost:8790/mcp`. Start the Worker with
`pnpm run dev --local-upstream localhost:8790` so the advertised resource URL is
`localhost` instead of the production route host; pi rejects a mismatch.

## Authentication

The server is an OAuth protected resource backed by the agent Clerk instance's
OAuth server.

- `POST /mcp` without a valid token returns 401 with
  `WWW-Authenticate: Bearer resource_metadata=…/.well-known/oauth-protected-resource/mcp`.
  The metadata names the Clerk instance as the authorization server.
- Clerk verifies the bearer as an `oauth_token`. Its user ID keys `TaskDO`, the
  same key the web and mobile apps use.
- Clients identify with a Client ID Metadata Document (CIMD); pi's is
  `https://pi.dev/oauth/client.json`. Clerk issues refresh tokens
  (`offline_access` is always granted), so pi signs in once.
- Under `ENVIRONMENT=test` the bearer token is trusted as the user ID, matching
  the `/api/*` test bypass.

Clerk settings (Dashboard → Configure → OAuth applications → Settings), on both
the production and development instances:

| Setting | Value |
|---|---|
| Publish CIMD support | on |
| Client admission | Any compatible CIMD client |
| Publish DCR support | off |
| Require PKCE | on |
| Access token format | JWT |

Open admission lets any CIMD client start a sign-in; the user's Clerk sign-in
and consent remain the gate. Switch to "Pre-registered and previously connected
clients" to require each client to be added in the dashboard first.

The server is stateless: each `POST` builds a fresh MCP server. `GET` and
`DELETE` on `/mcp` return 405. `wrangler.jsonc` lists `/mcp` and
`/.well-known/*` in `run_worker_first` so the web app's SPA fallback does not
answer them.

## Operation catalog

Tools are generated from `todoOperations` in `@zero/agent-core/operations`
(`packages/agent-core/src/operations/`). Each operation declares its name,
description, kind (`read`, `write`, `destructive`), and zod input schema, and
runs against the TinyBase store through `TodoModel` and `MedicineModel`. The MCP
route has no per-tool code; adding an operation to the catalog adds a tool.

- `runTodoOperation` validates input, mints IDs that the caller omits, and
  returns `{ ok: true, changed, value }` or `{ ok: false, error }`. Model
  conflicts such as `missing-project` or `cycle` come back by name and reach the
  client as tool errors.
- `TaskDO.runOperation` rejects writes on an erased account and saves only when
  an operation changed the store.
- `kind` sets the MCP annotations: `read` is read-only, `destructive` sets
  `destructiveHint`.
- The route resolves the user's today from the `UserDO` timezone (UTC when
  unset). `tasks_complete` defaults `completedOn` to it.

### Left out on purpose

- **Reorder** needs fractional sort keys that only list UIs produce.
- **Undo** carries UI snapshots taken before a change.
- **Recovery repair** is a user decision on Home; `recoveries_list` reports the
  rows.
- **Medicine writes** (create, edit, delete). Android sets medicine alarms only
  when the app's JavaScript sees a change: on a sync while the app is open, on
  foreground, or after an in-app edit. A write while the app is in the
  background or closed leaves the old alarms in place, and a dose time that
  passes before the app opens is skipped. Writes return once a server push can
  wake the app.
- **Dose confirmation** belongs to the Android receipt flow
  (see [`storage.md`](storage.md), Medicine and Dose storage).
- **Project icon suggestion** is a UI helper.
