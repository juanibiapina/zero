# @zero/agent-server

Standalone HTTP server for agentic sessions. Runtime-agnostic — has no
Cloudflare or Telegram coupling. Today it's packaged as the process running
inside the `AgentContainer` Cloudflare Container, but the same binary will
run on any Node.js host that can reach the configured `CALLBACK_URL`.

Under the hood it drives
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
Each `POST /sessions` builds a fresh `AgentSession` using pi-ai's
built-in `cloudflare-ai-gateway` provider (`claude-opus-4-8`,
`thinkingLevel: "high"`). The provider builds the gateway URL from
`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` and authenticates with
`cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>`, read from
`process.env`. No Anthropic key is sent; Cloudflare authenticates
upstream and settles the bill (unified billing). For e2e, the server
reads an optional `LLM_BASE_URL_OVERRIDE` and repoints the model's
`baseUrl` at the mock Anthropic server; it is empty in prod.

All mutable state lives under the fixed `/workspace` tree (pi's `cwd`):

```
/workspace/
├── sessions/<sessionId>/   pi session JSONL files
└── notes/                  the notes vault (long-term memory)
```

Restart-resume is automatic: a `POST /sessions/:id/messages` for an id
whose process state has been lost, but whose `/workspace/sessions/:id`
directory still exists, transparently reopens the last session via
`SessionManager.continueRecent`.

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
  on accept, 404 if the sessionId is unknown. Replies arrive out of band
  (see [Message callbacks](#message-callbacks)).

## Message callbacks

As pi produces each assistant message (`message_end`), the server posts
the text to `$CALLBACK_URL/message-end`:

```
POST $CALLBACK_URL/message-end
Content-Type: application/json

{ "sessionId": "<uuid>", "text": "<assistant message>", "clerkUserId": "<id>" }
```

When the turn finishes (`agent_end`), it posts to `$CALLBACK_URL/agent-end`:

```
POST $CALLBACK_URL/agent-end
Content-Type: application/json

{ "sessionId": "<uuid>", "clerkUserId": "<id>", "willRetry": false }
```

The call is fire-and-forget — errors are logged, not retried. The caller is
expected to be reachable from the server's environment.

## Environment variables

| Var                 | Required | Default       | Notes                                              |
|---------------------|----------|---------------|----------------------------------------------------|
| `PORT`              | no       | `8080`        | Port to listen on.                                 |
| `CALLBACK_URL`    | yes      | —             | Base URL the server uses for callbacks (`$CALLBACK_URL/message-end`, `/agent-end`, `/state`). Exits if unset. |
| `CLOUDFLARE_API_KEY` | yes      | —             | Cloudflare AI Gateway token, sent as `cf-aig-authorization`. Resolved by pi-ai's `cloudflare-ai-gateway` provider from `process.env`. |
| `CLOUDFLARE_ACCOUNT_ID` | yes   | —             | Cloudflare account id; substituted into the gateway base URL. |
| `CLOUDFLARE_GATEWAY_ID` | yes   | —             | AI Gateway slug; substituted into the gateway base URL. |
| `MODEL_ID`          | yes      | —             | Gateway model id, e.g. `claude-opus-4-8`. |
| `LLM_BASE_URL_OVERRIDE` | no   | (empty)       | Test-only override of the model's base URL (points at the mock Anthropic server in e2e). Empty/unset in prod. |
| `CLERK_USER_ID`     | yes      | —             | Clerk user id, included in callback payloads and the `X-Clerk-User-Id` header on `/state` requests. Server exits if unset. |

## Persistence

The server keeps no R2/S3 wiring of its own. Durability is delegated to
the host via two HTTP calls against `CALLBACK_URL`:

- **Restore** — the entrypoint runs
  `curl -sf $CALLBACK_URL/state | tar xz -C /workspace` on boot. A 404
  (no prior snapshot) starts with an empty tree.
- **Save** — on every `agent_end` and on `SIGTERM`, the server runs
  `tar cz -C /workspace .` and PUTs the archive to `$CALLBACK_URL/state`
  with an `X-Clerk-User-Id` header (`src/save-state.ts`).

Durability is therefore **per-turn**: state is local until the next
save. The host is expected to store the archive keyed by the user (the
`AgentContainer` worker stores it at `<clerkUserId>/state.tar.gz` in R2).

## Bash timeout

pi's bash tool has no default command timeout, so a hung command would
block an agent turn indefinitely. The session bridge wraps the bash
backend (`createTimeoutBashOperations` in `src/session-bridge.ts`) to
enforce a **default 5-minute timeout**, capped at **30 minutes**. The
agent can still pass an explicit `timeout` (seconds) up to the cap for
legitimately long commands. A timed-out command is reported to the agent
as `Command timed out after N seconds` and emits an anonymous
`bash_timeout` log (session id only — no command text).

## Running

```bash
pnpm --filter @zero/agent-server build
CALLBACK_URL=http://localhost:5000 CLERK_USER_ID=user_local \
  node packages/agent-server/dist/index.js
```

## In production (Cloudflare Container)

`apps/api` packages this server into a Cloudflare Container. The wrapping
`AgentContainer` Durable Object sets `CALLBACK_URL=http://zero.worker`
and intercepts calls via an outbound handler that runs inside the
Workers runtime — so replies never leave the Cloudflare network. See
`docs/design.md`.
