# @zero/agent-server

Standalone HTTP server for agentic sessions. Runtime-agnostic — has no
Cloudflare or Telegram coupling. Today it's packaged as the process running
inside the `AgentContainer` Cloudflare Container, but the same binary will
run on any Node.js host that can reach the configured `REPLY_URL`.

Under the hood it drives
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
Each `POST /sessions` builds a fresh `AgentSession` using pi-ai's
built-in `anthropic` provider (`claude-sonnet-4-5-20250929`,
`thinkingLevel: "high"`). Pi reads `ANTHROPIC_API_KEY` from
`process.env` and talks directly to `api.anthropic.com`.

Sessions are persisted on disk under `AGENT_STATE_DIR` (one
subdirectory per sessionId). Restart-resume is automatic: a
`POST /sessions/:id/messages` for an id whose process state has been
lost, but whose directory still exists on disk, transparently reopens
the last session via `SessionManager.continueRecent`.

## HTTP contract

The routes are defined as Zod schemas + `createRoute()` declarations in
[`src/contract.ts`](./src/contract.ts) and mounted on an `OpenAPIHono`
app in [`src/app.ts`](./src/app.ts). Consumers running on Hono can
import the typed app and derive a fully-typed client via
[`hc<AppType>(baseUrl, { fetch })`](https://hono.dev/docs/guides/rpc):

```ts
import type { AppType } from "@zero/agent-server/app";
import { hc } from "hono/client";

const client = hc<AppType>(baseUrl, { fetch });
const { sessionId } = await (await client.sessions.$post()).json();
await client.sessions[":sessionId"].messages.$post({
  param: { sessionId },
  json: { text: "hello" },
});
```

Endpoints today:

- `POST /sessions` — returns `{ sessionId }` (200) or `{ error }` (500).
- `POST /sessions/{sessionId}/messages` — body `{ text }`; returns 202
  on accept, 404 if the sessionId is unknown. Reply arrives out of band
  (see [Reply callback](#reply-callback)).

## Reply callback

When pi emits `agent_end` for a session, the server posts the
accumulated assistant text to `REPLY_URL`:

```
POST $REPLY_URL
Content-Type: application/json

{ "sessionId": "<uuid>", "text": "<assistant message>" }
```

The call is fire-and-forget — errors are logged, not retried. The caller is
expected to be reachable from the server's environment.

## Environment variables

| Var                 | Required | Default       | Notes                                              |
|---------------------|----------|---------------|----------------------------------------------------|
| `PORT`              | no       | `8080`        | Port to listen on.                                 |
| `REPLY_URL`         | yes      | —             | Full URL the server POSTs replies to. Exits if unset. |
| `ANTHROPIC_API_KEY` | yes      | —             | Anthropic API key, used by pi-ai's built-in `anthropic` provider. |
| `CWD`               | no       | `/workspace`  | Working directory pi exposes to its `read`/`write`/`bash`/`edit` tools. Must be writable. |
| `AGENT_STATE_DIR`   | yes      | —             | Directory to persist sessions in. One subdir per sessionId; pi writes a JSONL file inside. Must be writable. Server exits if unset. |
| `MOUNT_NOTES_ENDPOINT` | yes (container) | — | S3-compatible endpoint URL the entrypoint mounts at `/mnt/notes` as the user's long-term notes vault. Consumed by `entrypoint.sh`, not by the Node server. |
| `MOUNT_NOTES_BUCKET` | yes (container) | — | Bucket name for the notes mount. |
| `MOUNT_NOTES_PREFIX` | yes (container) | — | Prefix inside the bucket; becomes the FUSE root for the notes mount. |
| `MOUNT_NOTES_ACCESS_KEY_ID` | yes (container) | — | Access key id used by `tigrisfs` for the notes mount (scrubbed before `exec node`). |
| `MOUNT_NOTES_SECRET_ACCESS_KEY` | yes (container) | — | Secret access key, scrubbed before `exec node`. |
| `MOUNT_NOTES_SESSION_TOKEN` | yes (container) | — | Session token, scrubbed before `exec node`. |

## Running

```bash
pnpm --filter @zero/agent-server build
REPLY_URL=http://localhost:5000/reply node packages/agent-server/dist/index.js
```

## In production (Cloudflare Container)

`apps/api` packages this server into a Cloudflare Container. The wrapping
`AgentContainer` Durable Object sets `REPLY_URL=http://zero.worker/reply`
and intercepts the call via an outbound handler that runs inside the
Workers runtime — so replies never leave the Cloudflare network. See
`docs/design.md`.
