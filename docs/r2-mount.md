# R2 Mount Setup

This document covers the one-time setup needed for **per-user persistent
sessions** in the agent container. Once these steps are done, every
container mounts its user's R2 prefix at `/mnt/agent-state` via
[tigrisfs](https://github.com/tigrisdata/tigrisfs) and pi writes its
JSONL session files there.

The runtime mechanics are described in [`design.md`](design.md) under
**Persistence**.

## Step 1 — Create the bucket

In the [Cloudflare R2 dashboard](https://dash.cloudflare.com/?to=/:account/r2/overview):

1. Click **Create bucket**.
2. Name: **`zero-agent-state`**.
3. Location: leave **Automatic** (lands close to the worker).
4. Storage class: **Standard**.

Done. No public access, no lifecycle rules. The bucket holds one prefix
per Clerk user (`<clerkUserId>/`) and pi's JSONL session files inside
each.

## Step 2 — Create the parent R2 API token

The worker mints short-lived, prefix-scoped credentials for each container
boot using **local JWT signing** against a long-lived parent token.

In the R2 dashboard, **Manage R2 API tokens \u2192 Create API token**:

| Field | Value |
|---|---|
| Token name | `zero-agent-state-parent` |
| Permissions | **Object Read & Write** |
| Specify bucket(s) | **Apply to specific buckets only** \u2192 `zero-agent-state` |
| TTL | **Never expire** |
| Client IP filter | none |

Click **Create API Token**. Copy the displayed values:

- **Access Key ID** \u2192 used as `R2_PARENT_ACCESS_KEY_ID`
- **Secret Access Key** \u2192 used as `R2_PARENT_SECRET_ACCESS_KEY`
- The token's **Account ID** is your existing Cloudflare account id (find
  it in the dashboard sidebar) \u2192 `R2_ACCOUNT_ID`

The token is shown only once; if you lose it, rotate via this same page.

## Step 3 \u2014 Push secrets to Doppler

Set the four secrets in both `dev` and `prd` configs of the `zero-api`
project:

```bash
for cfg in dev prd; do
  doppler secrets set --project zero-api --config "$cfg" \
    R2_ACCOUNT_ID="<account-id>" \
    R2_BUCKET_NAME="zero-agent-state" \
    R2_PARENT_ACCESS_KEY_ID="<access-key-id>" \
    R2_PARENT_SECRET_ACCESS_KEY="<secret-access-key>" \
    --no-interactive
done
```

Then sync local + Cloudflare:

```bash
bin/fetch-secrets                    # refreshes apps/api/.dev.vars
bin/sync-secrets-to-cloudflare       # uploads prd to Worker
```

## Step 4 \u2014 Verify

Local:

```bash
pnpm --filter @zero/api run cf-typegen
gob run bin/ci
```

`bin/ci` should pass with the new secrets baked into the type definitions.

Production:

```bash
gob run bin/deploy
```

After deploy, send a Telegram topic message and watch the container logs
in the dashboard (Containers \u2192 `zero-api-agentcontainer` \u2192 **Logs**).
Logs are structured JSON \u2014 filter on `service = "agent-server"`.
Look for these on first contact for a user:

```
{"msg":"mounting_r2","bucket":"zero-agent-state","prefix":"<clerkUserId>",...}
{"msg":"mounted_r2","mount_point":"/mnt/agent-state"}
{"msg":"listening","port":8080,...}
{"msg":"create_session","session_id":"<uuid>","dir":"/mnt/agent-state/<uuid>"}
```

A second message in the same topic after the container has been idle long
enough to sleep (5+ min) should produce:

```
{"msg":"resume_session","session_id":"<uuid>","dir":"/mnt/agent-state/<uuid>"}
```

instead of `create_session`, confirming pi reopened the previous JSONL.

On deploy or scale-down, the supervisor entrypoint drains in-flight pi
turns before unmounting tigrisfs. The full shutdown sequence (in order,
every time) is:

```
{"msg":"shutdown_signal","signal":"SIGTERM"}
{"msg":"drain_started","timeout_ms":780000}
{"msg":"drain_complete","inflight":0,"waited_ms":<n>,"timed_out":false}
{"msg":"shutdown_begin"}
{"msg":"node_exited"}
{"msg":"tigrisfs_unmount_requested"}
{"msg":"tigrisfs_exited"}
```

No `container_rejected_message` lines should appear in `wrangler tail`
during a deploy roll, and the JSONL on R2 should contain assistant
entries for any turn that was in flight when the signal arrived.

## Rotating the parent token

1. Create a new token in the R2 dashboard (same scope as Step 2).
2. Update Doppler in both configs (Step 3).
3. `bin/sync-secrets-to-cloudflare`.
4. Existing live containers keep using the old creds in their env until
   their next cold boot. Optional: restart all containers to force a
   refresh (`wrangler deploy` triggers a rolling restart of containers).
5. Delete the old token in the R2 dashboard.

In-flight temp credentials (already minted, TTL 1h) remain valid until
expiry even if the parent token is deleted \u2014 they are signed material,
not server-side state.

## Backup / restore

R2 has no built-in versioning yet, but the `zero-agent-state` bucket is
small (JSONL session files only). For a one-shot snapshot:

```bash
# Sync to a local directory
rclone sync r2:zero-agent-state ./backup-$(date +%Y%m%d)/
```

Restore by syncing in the other direction. Pi reads sessions on demand
via `SessionManager.continueRecent`; no service restart needed after a
restore, the next message in a topic will pick up the restored state.
