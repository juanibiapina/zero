# Container Resume — Implementation Design

## Status

| Phase | Description | Status |
|---|---|---|
| **1** | Detection + seq reset | ✅ Shipped |
| **2** | Agent state resume (conversation history, credentials) | ✅ Shipped |
| **2b** | Decoupled architecture (hibernation API + HTTP commands + ephemeral event WS) | ✅ Shipped |
| **3** | R2 workspace snapshots (preserve filesystem across sleep) | 🔜 Next |

## Problem

When a container sleeps (10min idle) and wakes, it starts fresh. Two things are lost:

1. **Agent state** — `SessionWrapper._messages`, `_model`, `_workDir` are null. Any follow-up message throws "Session not initialized".
2. **Filesystem** — The cloned repo, uncommitted edits, installed dependencies, build artifacts are wiped. A fresh clone is required.

Phase 1 solved the seq counter mismatch that silently dropped events from restarted containers. Phases 2 and 3 solve the actual state loss.

## State Inventory

| Component | Location | Lost on sleep? | Restore from |
|---|---|---|---|
| Conversation history (`_messages`) | Agent-server memory | ✅ Yes | SessionDO SQLite (`agent_end` events) |
| Provider/model config | Agent-server memory | ✅ Yes | SessionDO `session_meta` → `/resume` request |
| API key | Agent-server memory | ✅ Yes | UserDO credentials (resolved fresh) |
| User secrets (`process.env`) | Container env | ✅ Yes | UserDO secrets (re-injected on `/resume`) |
| Git credentials | Container filesystem | ✅ Yes | Fresh GitHub installation token |
| Agent events (frontend replay) | SessionDO SQLite | ❌ No | Already durable |
| Workspace (repo, uncommitted changes, node_modules, builds) | Container filesystem | ✅ Yes | **R2 snapshot** (Phase 3) |

---

## Phase 1: Detection + Seq Reset (✅ Shipped)

Implemented in `AgentContainer.ts` and `SessionDO/index.ts`.

**How it works:**
- `AgentContainer.onStop()` notifies SessionDO when container dies → immediate WS cleanup
- `ensureContainerWebSocket()` calls `container.getState()` before connecting
- If `stopped`/`stopped_with_code`/`stopping` → reset `lastContainerSeq = 0`
- Fresh container's EventBuffer starts at seq 0 → events flow correctly

No further work needed.

---

## Phase 2: Agent State Resume

**Goal:** After container wakes from sleep, restore conversation history and credentials so follow-up messages work. Uses fresh clone (not R2) — workspace changes are still lost. Fast to implement, unblocks basic resume.

### Schema changes

Add `userDOId` column to `session_meta` for credential resolution during resume:

```sql
ALTER TABLE session_meta ADD COLUMN userDOId TEXT;
```

Nullable for backward compatibility. Populated at session creation time.

> **Note:** `installationId` is NOT stored in SessionDO. It lives on UserDO as a single installation per user. Resume resolves it via `userDO.getGitHubInstallation()`. This avoids stale installation IDs when users reinstall the GitHub App.

### Session creation changes

**`zero/api/src/services/session.ts`** — pass `userDOId` to `initSession()`:

```typescript
await sessionDO.initSession({
  status: "starting",
  containerName,
  projectOwner: owner,
  projectRepo: repo,
  provider,
  model,
  userDOId,  // NEW — for status sync + credential resolution on resume
});
```

### Agent-server: `POST /resume` endpoint

New endpoint that restores agent state without starting an agent loop. After resume, session is `"idle"` — ready for follow-ups.

**Request type:**
```typescript
interface ResumeRequest {
  provider: string;
  model: string;
  apiKey: string;
  repoUrl: string;
  token: string;
  secrets?: Record<string, string>;
  messages: Message[];  // conversation history from SessionDO
}
```

**`SessionWrapper.resume()`:**
```typescript
async resume(
  provider: string,
  modelId: string,
  apiKey: string,
  messages: Message[],
  repoUrl: string,
  token: string,
): Promise<void> {
  if (this._abortController) await this.stop();

  this._eventBuffer.clear();
  this._messages = [];
  this._error = undefined;
  this._status = "starting";
  this._eventBuffer.addEvent({ type: "status", status: this._status });

  try {
    // Fresh clone (Phase 3 replaces this with R2 restore)
    const workDir = this.cloneRepo(repoUrl, token);

    setApiKey(provider, apiKey);
    const model = getModel(provider, modelId);
    if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);

    process.chdir(workDir);
    this._model = model;
    this._workDir = workDir;
    this._messages = messages;  // ← conversation history restored

    this._status = "idle";
    this._eventBuffer.addEvent({ type: "status", status: this._status });
  } catch (err) {
    this._status = "error";
    this._error = err instanceof Error ? err.message : String(err);
    this._eventBuffer.addEvent({ type: "status", status: this._status, error: this._error });
    throw err;
  }
}
```

Key difference from `start()`: restores `_messages` from provided history, transitions to `"idle"` (not `"ready"`), does NOT run a prompt.

### SessionDO: conversation history extraction

Rebuilds `_messages` by collecting messages from every `agent_end` event — produces the exact same array `SessionWrapper._messages` would contain if the container had never slept.

```typescript
private getConversationHistory(): unknown[] {
  const rows = this.db
    .select()
    .from(sessionEventsTable)
    .where(eq(sessionEventsTable.eventType, "agent_end"))
    .orderBy(sessionEventsTable.seq)
    .all();

  const messages: unknown[] = [];
  for (const row of rows) {
    const event = JSON.parse(row.data) as { messages?: unknown[] };
    if (event.messages) messages.push(...event.messages);
  }
  return messages;
}
```

### SessionDO: resume orchestration

**Updated `ensureContainerWebSocket()`** — after connecting to a woken container, resume before forwarding messages:

```typescript
// After connecting the WS (existing code)...
if (containerWasStopped && this.currentStatus === "idle") {
  await this.resumeContainerSession(session);
}
```

**`resumeContainerSession()`:**

```typescript
private async resumeContainerSession(session: SessionMeta): Promise<void> {
  this.broadcastToWebSockets({ type: "status", status: "resuming" });

  try {
    const messages = this.getConversationHistory();

    // Fresh credentials from UserDO
    const userDO = this.env.USER_DO.get(
      this.env.USER_DO.idFromString(session.userDOId)
    );
    const credentials = await userDO.listProviderCredentials();
    const cred =
      credentials.find(c => c.provider === session.provider && c.apiKey) ??
      credentials.find(c => c.provider === session.provider && c.accessToken);
    if (!cred) throw new Error("No credentials available for resume");
    const apiKey = (cred.apiKey ?? cred.accessToken)!;

    const installation = await userDO.getGitHubInstallation();
    if (!installation) throw new Error("No GitHub installation linked");
    const githubToken = await getInstallationToken(this.env, installation.installationId);
    const secrets = await this.getUserSecrets(userDO);

    const container = getContainer(this.env.AGENT_CONTAINER, session.containerName);
    const repoUrl = `https://github.com/${session.projectOwner}/${session.projectRepo}.git`;

    const resp = await container.fetch(
      switchPort(new Request("http://container/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: session.provider,
          model: session.model,
          apiKey,
          secrets,
          repoUrl,
          token: githubToken,
          messages,
        }),
      }), 8080)
    );

    if (!resp.ok) throw new Error(`Resume failed: ${resp.status} ${await resp.text()}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Resume failed:", msg);
    this.broadcastToWebSockets({ type: "error", message: `Session resume failed: ${msg}` });
    await this.updateStatus("error");
  }
}
```

### File changes (Phase 2)

| File | Changes |
|---|---|
| `zero/api/src/SessionDO/db/schema.ts` | Add `userDOId` column (**✅ Done**) |
| `zero/api/src/SessionDO/db/drizzle/` | New migration (**✅ Done**) |
| `zero/api/src/SessionDO/index.ts` | `getConversationHistory()`, `resumeContainerSession()`, resume detection in `sendCommandToContainer()`, `connectToContainer()`, `onContainerStopped()` (**✅ Done**) |
| `zero/api/src/services/session.ts` | Pass `userDOId` to `initSession()`, call `connectToContainer()` after `/start` (**✅ Done**) |
| `zero/agent-server/src/types.ts` | `ResumeRequest` type (**✅ Done**) |
| `zero/agent-server/src/server.ts` | `POST /resume` route (**✅ Done**) |
| `zero/agent-server/src/session.ts` | `resume()` method (**✅ Done**) |
| `zero/core/src/index.ts` | Add `"resuming"` and `"ready"` to `SessionStatus` (**✅ Done**) |

---

## Phase 3: R2 Workspace Snapshots

**Goal:** Preserve the container's filesystem across sleep/wake cycles. After resume, the workspace is exactly as the agent left it — uncommitted changes, installed dependencies, build artifacts, created branches. Resume drops from ~30-60s (fresh clone) to ~5s (download + decompress).

### What to persist

The entire `/workspace/repo` directory, including:
- Git working tree (tracked files, uncommitted changes, staged files)
- `.git` directory (local branches, commit history from shallow clone)
- `node_modules/` and other installed dependencies
- Build artifacts (`dist/`, `.next/`, etc.)
- Agent-created files (patches, configs, etc.)

**What NOT to persist:**
- Credentials (`.git-credentials`, tokens in remote URLs) — stripped before snapshot, re-injected on restore
- `process.env` secrets — re-injected via `/resume` request

### Where to persist: R2

**Bucket:** `zero-workspace-snapshots`

**Key scheme — per session:**
```
workspace-snapshots/{sessionDOId}/snapshot.tar.zst
workspace-snapshots/{sessionDOId}/metadata.json
```

**Why per-session, not per-project:** Different sessions for the same repo may be on different branches, have different uncommitted changes, or different dependency states. Sharing would clobber session-specific work.

**`metadata.json`:**
```json
{
  "createdAt": "2026-02-21T08:00:00Z",
  "sessionDOId": "abc123...",
  "owner": "juanibiapina",
  "repo": "trippycards",
  "sizeBytes": 52428800
}
```

### Snapshot format

`tar` + `zstd` compression. Zstandard gives 3-5x compression at high speed (faster than gzip for both compress and decompress).

```bash
# Snapshot (compress)
tar -cf - -C /workspace repo | zstd -T0 -3 -o /tmp/snapshot.tar.zst

# Restore (decompress)
zstd -d /tmp/snapshot.tar.zst --stdout | tar -xf - -C /workspace
```

`-T0` = all cores. `-3` = default level (fast, reasonable ratio).

**Typical sizes:**

| Repo type | Uncompressed | Compressed |
|---|---|---|
| Small JS project | ~200MB | ~50MB |
| Medium monorepo | ~800MB | ~200MB |
| Large monorepo + node_modules | ~2GB | ~500MB |

Upload/download at ~100MB/s within Cloudflare's network → 200MB snapshot restores in ~2s.

### When to snapshot

Two trigger points, ordered by reliability:

#### 1. On idle (primary — reliable)

When the agent finishes a turn and transitions to `idle`, SessionDO triggers a workspace snapshot. This is the reliable path — the agent is done, the workspace is in a good state, and there's no time pressure.

```
Agent finishes turn → status="idle" event
  → SessionDO receives status event
  → SessionDO generates pre-signed R2 upload URL
  → SessionDO calls container POST /workspace/snapshot { uploadUrl }
     ↓
Agent-server:
  1. Strip credentials from git remote URL
  2. tar + zstd compress /workspace/repo → /tmp/snapshot.tar.zst
  3. Upload to R2 via pre-signed PUT URL
  4. Return { sizeBytes }
     ↓
SessionDO writes metadata.json to R2
```

**Triggered in SessionDO's container WS message handler**, when it sees a status transition to `idle` after an agent turn:

```typescript
// In the container WS message handler, after updating status:
if (newStatus === "idle" && previousStatus === "running") {
  this.triggerSnapshot(session).catch(err => {
    console.error("Snapshot failed:", err);
    // Non-fatal — session still works, just won't have a snapshot for next wake
  });
}
```

Snapshot is fire-and-forget (non-blocking). Failure is logged but doesn't break the session.

#### 2. On SIGTERM (safety net — best-effort)

Container receives SIGTERM before sleep. Agent-server traps it and snapshots as a safety net for cases where the idle snapshot failed or the agent was interrupted.

```typescript
// agent-server/src/index.ts
process.on("SIGTERM", async () => {
  console.log("SIGTERM — snapshotting workspace...");
  try {
    await snapshotWorkspace();
  } catch (err) {
    console.error("Snapshot on SIGTERM failed:", err);
  }
  process.exit(0);
});
```

**Time budget:** Container has ~30s between SIGTERM and SIGKILL. For a 200MB compressed snapshot at 100MB/s upload, this is tight but feasible for small-to-medium repos. Large repos may not complete — that's OK, the idle snapshot is the reliable path.

**SIGTERM snapshot needs the upload URL.** Two options:

**Option A (recommended): Store the upload URL in the container.** SessionDO generates a long-lived pre-signed URL (24h expiry) at session creation and passes it to the container in the `/start` request. The container stores it and reuses for both idle and SIGTERM snapshots. Simple, no cross-DO call during SIGTERM.

**Option B: Container calls back to SessionDO.** On SIGTERM, agent-server makes an HTTP request to SessionDO asking for an upload URL. Adds latency and may fail if SessionDO is evicted. Not recommended.

### How to restore

On resume (container just woke), SessionDO checks R2 for a snapshot and passes the download URL to `/resume`.

#### Updated `/resume` request

```typescript
interface ResumeRequest {
  provider: string;
  model: string;
  apiKey: string;
  repoUrl: string;
  token: string;
  secrets?: Record<string, string>;
  messages: Message[];
  snapshotUrl?: string;  // NEW — pre-signed R2 GET URL (absent = fresh clone)
}
```

#### Agent-server restore flow

```typescript
async resume(
  provider: string,
  modelId: string,
  apiKey: string,
  messages: Message[],
  repoUrl: string,
  token: string,
  snapshotUrl?: string,
): Promise<void> {
  // ... clear state, emit status: "starting" ...

  try {
    let workDir: string;
    if (snapshotUrl) {
      // Restore from R2 snapshot
      workDir = await this.restoreWorkspace(snapshotUrl);
      // Update git remote with fresh token (snapshot stripped credentials)
      const authedUrl = repoUrl.replace("https://", `https://x-access-token:${token}@`);
      execSync(`git -C ${WORKSPACE_DIR} remote set-url origin ${authedUrl}`);
    } else {
      // No snapshot — fresh clone (fallback)
      workDir = this.cloneRepo(repoUrl, token);
    }

    // ... configure model, restore messages, emit status: "idle" ...
  }
}

private async restoreWorkspace(snapshotUrl: string): Promise<string> {
  // Clean up any existing workspace
  if (existsSync(WORKSPACE_DIR)) {
    execSync(`rm -rf ${WORKSPACE_DIR}`);
  }
  mkdirSync(WORKSPACE_DIR, { recursive: true });

  // Download and extract
  const tmpFile = "/tmp/snapshot.tar.zst";
  const resp = await fetch(snapshotUrl);
  if (!resp.ok) throw new Error(`Snapshot download failed: ${resp.status}`);

  const buffer = Buffer.from(await resp.arrayBuffer());
  writeFileSync(tmpFile, buffer);

  execSync(`zstd -d ${tmpFile} --stdout | tar -xf - -C /workspace`, {
    timeout: 120_000,
  });

  unlinkSync(tmpFile);
  return WORKSPACE_DIR;
}
```

#### SessionDO resume flow (updated for Phase 3)

```typescript
private async resumeContainerSession(session: SessionMeta): Promise<void> {
  // ... credential resolution (same as Phase 2) ...

  // Check for R2 snapshot
  let snapshotUrl: string | undefined;
  const snapshotKey = `workspace-snapshots/${this.ctx.id.toString()}/snapshot.tar.zst`;
  const snapshot = await this.env.R2.head(snapshotKey);
  if (snapshot) {
    // Generate pre-signed GET URL (1h expiry)
    snapshotUrl = await generatePresignedGetUrl(this.env, snapshotKey);
  }

  const resp = await container.fetch(
    switchPort(new Request("http://container/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: session.provider,
        model: session.model,
        apiKey,
        secrets,
        repoUrl,
        token: githubToken,
        messages,
        snapshotUrl,  // undefined if no snapshot → agent-server does fresh clone
      }),
    }), 8080)
  );
}
```

**Fallback:** If snapshot download or extraction fails inside agent-server, `restoreWorkspace()` throws. The `resume()` method catches it, and SessionDO falls back to a restart with fresh clone. The user's follow-up still works — just slower.

### Agent-server: `POST /workspace/snapshot`

New endpoint called by SessionDO to trigger workspace snapshotting.

```typescript
interface SnapshotRequest {
  uploadUrl: string;  // pre-signed R2 PUT URL
}

// POST /workspace/snapshot
async function handleSnapshot(req: SnapshotRequest): Promise<{ sizeBytes: number }> {
  // 1. Strip credentials from git remote
  execSync(`git -C ${WORKSPACE_DIR} remote set-url origin https://github.com/placeholder/repo.git`);

  // 2. Compress workspace
  const tmpFile = "/tmp/snapshot.tar.zst";
  execSync(`tar -cf - -C /workspace repo | zstd -T0 -3 -o ${tmpFile}`, {
    timeout: 300_000,  // 5min for large repos
  });

  // 3. Upload to R2
  const stat = statSync(tmpFile);
  const body = readFileSync(tmpFile);
  const resp = await fetch(req.uploadUrl, {
    method: "PUT",
    body,
    headers: { "Content-Length": stat.size.toString() },
  });
  if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);

  unlinkSync(tmpFile);
  return { sizeBytes: stat.size };
}
```

### Pre-signed URLs

R2 pre-signed URLs require the S3 API with `aws4fetch` or the `@aws-sdk/s3-request-presigner`. Since the container can't access R2 bindings directly (it's a separate process), pre-signed URLs are the bridge.

```typescript
// In SessionDO or a utility module
import { AwsClient } from "aws4fetch";

function getR2Client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
}

async function generatePresignedPutUrl(env: Env, key: string, expiresIn = 86400): Promise<string> {
  const client = getR2Client(env);
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`);
  url.searchParams.set("X-Amz-Expires", expiresIn.toString());
  const signed = await client.sign(new Request(url, { method: "PUT" }), { aws: { signQuery: true } });
  return signed.url;
}

async function generatePresignedGetUrl(env: Env, key: string, expiresIn = 3600): Promise<string> {
  // Same pattern, method: "GET"
}
```

**Alternative:** Use R2 binding directly from SessionDO (put/get bytes) and stream to/from container via the container WS or HTTP. More complex, but avoids pre-signed URL setup. Pre-signed URLs are simpler and let the container do direct I/O with R2.

### Cleanup

#### On session deletion

When a session is deleted, delete its R2 snapshot:

```typescript
// In SessionDO.deleteSession() or the delete route
async deleteSession(): Promise<void> {
  // Delete R2 snapshot
  const prefix = `workspace-snapshots/${this.ctx.id.toString()}/`;
  const listed = await this.env.R2.list({ prefix });
  for (const obj of listed.objects) {
    await this.env.R2.delete(obj.key);
  }

  // Delete DO storage
  await this.ctx.storage.deleteAll();
}
```

#### R2 lifecycle rule (safety net)

For orphaned snapshots (session deleted but R2 cleanup failed), configure an R2 lifecycle rule:

```
Prefix: workspace-snapshots/
Expiration: 30 days
```

This catches leaked snapshots without requiring a separate cleanup job.

#### One snapshot per session

Each idle transition overwrites the previous snapshot (same R2 key). No accumulation.

### Infrastructure changes

**`wrangler.jsonc`:**
```jsonc
"r2_buckets": [
  {
    "binding": "R2",
    "bucket_name": "zero-workspace-snapshots"
  }
]
```

**`Env` type:**
```typescript
R2: R2Bucket;
R2_ACCESS_KEY_ID: string;      // for pre-signed URLs
R2_SECRET_ACCESS_KEY: string;  // for pre-signed URLs
R2_ACCOUNT_ID: string;
R2_BUCKET_NAME: string;
```

**Dockerfile** — add `zstd`:
```dockerfile
RUN apt-get update && apt-get install -y git zstd && rm -rf /var/lib/apt/lists/*
```

**Doppler** — add R2 API token secrets for pre-signed URL generation.

### Edge cases

#### Container killed before onStop/SIGTERM completes

If the container is killed (SIGKILL, OOM, infrastructure failure) before SIGTERM handler finishes:
- The idle snapshot (taken after the last completed turn) is still in R2
- Only work done between the last idle snapshot and the kill is lost
- This is acceptable — the idle snapshot is the reliable path, SIGTERM is a safety net

**Mitigation:** The idle snapshot happens after every turn. The window of data loss is at most one agent turn's worth of filesystem changes (the conversation history is never lost — it's in SessionDO SQLite).

#### Large repos

Repos over ~1GB compressed may:
- Exceed SIGTERM time budget (30s) — OK, idle snapshot covers this
- Take several seconds to upload/download — acceptable, user sees "Setting up..."
- Exceed R2 single-object size limit (5GB via single PUT) — for very large snapshots, use multipart upload

**Size guard:** Before snapshotting, check uncompressed size. If over a threshold (e.g., 2GB uncompressed), log a warning. Consider excluding `node_modules` and relying on `npm install` during restore for very large repos — but this adds restore latency.

**Practical ceiling:** The `basic` container instance type has limited disk. Large monorepos with full node_modules are unlikely to exceed 1-2GB compressed.

#### Concurrent snapshot and user message

User sends a message while a snapshot upload is in progress:
- Snapshot is fire-and-forget (non-blocking in SessionDO)
- Agent-server can handle `/message` while upload runs (snapshot reads the filesystem, agent writes to it)
- Worst case: snapshot captures a mid-write state. This is fine — the next idle snapshot will capture the clean state

#### Snapshot during agent run

Agent is running (modifying files) when idle snapshot triggers — this shouldn't happen because snapshots only trigger on `idle` transition. But if it did:
- The tar command reads files while agent writes them — may capture inconsistent state
- Not a correctness issue: the next idle snapshot (after the turn) overwrites with clean state

#### Container wakes but R2 is unavailable

If R2 is down during resume:
- `R2.head()` fails → `snapshotUrl` is undefined → fresh clone fallback
- User gets a working session, just slower
- Next idle transition will retry the snapshot

#### Multiple containers for same session

Shouldn't happen (one container per session by design). If it did:
- Both would write to the same R2 key
- Last write wins — acceptable since only one should be active

### Performance expectations

| Scenario | Current | With Phase 2 | With Phase 3 |
|---|---|---|---|
| First session | Clone 30-60s | Same | Same (no snapshot yet) |
| Follow-up, container warm | 0s | 0s | 0s |
| Follow-up, container slept | ❌ Broken | Clone 30-60s + resume ~1s | Restore ~5s + resume ~1s |

### File changes (Phase 3, incremental on Phase 2)

| File | Changes |
|---|---|
| `zero/api/wrangler.jsonc` | R2 bucket binding |
| `zero/api/src/types.ts` | `R2: R2Bucket` + R2 credential env vars |
| `zero/api/src/SessionDO/index.ts` | `triggerSnapshot()`, snapshot URL in `resumeContainerSession()`, R2 cleanup in `deleteSession()` |
| `zero/api/src/services/session.ts` | Generate + pass pre-signed upload URL to container at creation |
| `zero/api/src/lib/r2.ts` | Pre-signed URL generation helpers |
| `zero/agent-server/src/types.ts` | `SnapshotRequest`, update `ResumeRequest` with `snapshotUrl` |
| `zero/agent-server/src/server.ts` | `POST /workspace/snapshot` route |
| `zero/agent-server/src/session.ts` | `restoreWorkspace()` helper, update `resume()` |
| `zero/agent-server/src/index.ts` | SIGTERM snapshot handler |
| `zero/agent-server/Dockerfile` | Add `zstd` |

### Estimate

- Phase 2 (agent state resume): ✅ Complete
- Phase 3 (R2 snapshots): ~8-12 hours
