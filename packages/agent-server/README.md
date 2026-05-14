# @zero/agent-server

Standalone HTTP server for agentic sessions. Runtime-agnostic — has no
Cloudflare or Telegram coupling. Today it's packaged as the process running
inside the `AgentContainer` Cloudflare Container, but the same binary will
run on any Node.js host that can reach the configured `REPLY_URL`.

The current implementation is a placeholder: it stores session ids in
memory and replies with a hard-coded "Replying to: ..." string. Real agent
behaviour will replace `sendReply` later.

## HTTP contract

### `POST /sessions`

Creates a new session.

```
→ 200 { "sessionId": "<uuid>" }
```

### `POST /sessions/:sessionId/messages`

Posts a message to an existing session. Server acknowledges immediately and
sends the reply out of band (see [Reply callback](#reply-callback)).

```
body: { "text": "<string>" }

→ 202   (no body)
→ 404   if sessionId is unknown
→ 400   if body is invalid or `text` is missing
```

## Reply callback

When a message is accepted the server POSTs to `REPLY_URL`:

```
POST $REPLY_URL
Content-Type: application/json

{ "sessionId": "<uuid>", "text": "Replying to: \"<original>\"" }
```

The call is fire-and-forget — errors are logged, not retried. The caller is
expected to be reachable from the server's environment.

## Environment variables

| Var         | Required | Default | Notes                                              |
|-------------|----------|---------|----------------------------------------------------|
| `PORT`      | no       | `8080`  | Port to listen on.                                 |
| `REPLY_URL` | yes      | —       | Full URL the server POSTs replies to. Exits if unset. |

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
