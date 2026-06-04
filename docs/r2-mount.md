# R2 State Setup

This document covers the one-time setup needed for **per-user persistent
state** in the agent container. All mutable state — pi sessions, the
notes vault, and any files pi writes — is stored as a single compressed
archive of the container's `/workspace` tree at
`<clerkUserId>/state.tar.gz` in the `zero-agent-state` bucket.

The container never talks to R2 directly. It restores and saves the
archive through the worker (`GET`/`PUT http://zero.worker/state`), which
mediates R2 via its `AGENT_STATE_BUCKET` binding. The runtime mechanics
are described in [`design.md`](design.md) under **Persistence**.

## Step 1 — Create the bucket

In the [Cloudflare R2 dashboard](https://dash.cloudflare.com/?to=/:account/r2/overview):

1. Click **Create bucket**.
2. Name: **`zero-agent-state`**.
3. Location: leave **Automatic** (lands close to the worker).
4. Storage class: **Standard**.

Done. No public access, no lifecycle rules. The bucket holds one object
per Clerk user:

- `<clerkUserId>/state.tar.gz` — the full `/workspace` snapshot

No R2 API token is needed: the worker reaches the bucket through its
`AGENT_STATE_BUCKET` binding (declared in `apps/api/wrangler.jsonc`), so
there are no R2 credentials to mint, store, or rotate.

## Step 2 — Verify

Local (`wrangler dev` runs the full container path, including the
state restore/save round-trip):

```bash
gob run bin/ci
```

Production:

```bash
gob run bin/deploy
```

After deploy, send a Telegram topic message and watch the container logs
in the dashboard (Containers → `zero-api-agentcontainer` → **Logs**).
Logs are structured JSON — filter on `service = "agent-server"`.
Look for these on first contact for a user:

```
{"msg":"state_restore"}
{"msg":"listening","port":8080,...}
{"msg":"create_session","session_id":"<uuid>","dir":"/workspace/sessions/<uuid>"}
```

After the first `agent_end`, the worker writes the archive:

```
{"msg":"save_state_ok","size":...}
{"msg":"state_saved","clerk_user_id":"<clerkUserId>","size":...}
```

A second message in the same topic after the container has been idle long
enough to sleep (5+ min) should produce:

```
{"msg":"resume_session","session_id":"<uuid>","dir":"/workspace/sessions/<uuid>"}
```

instead of `create_session`, confirming pi reopened the previous JSONL
from the restored archive.

On deploy or scale-down the container saves the archive on SIGTERM
before node exits; there is no drain. Durability is per-turn: every
turn that reached `agent_end` is already on R2. In-flight prompts that
hadn't yet produced a reply are dropped (Telegram won't see a reply for
those turns).

## Backup / restore

R2 has no built-in versioning yet, but the `zero-agent-state` bucket is
small (one `state.tar.gz` per user). For a one-shot snapshot:

```bash
# Sync to a local directory
rclone sync r2:zero-agent-state ./backup-$(date +%Y%m%d)/
```

Restore by syncing in the other direction. The next container boot
restores the archive into `/workspace`; no service restart is needed.
