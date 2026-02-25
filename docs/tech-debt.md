# Zero — Tech Debt

## ~~Bug: Follow-up messages silently lost after container sleeps~~ ✅ RESOLVED

**Status: Fixed** — Implemented in design.md Phase 2 Slice 7 (decoupled architecture + container resume).

**What was fixed:** SessionDO now detects when a container has stopped (via `container.getState()`), calls `resumeContainerSession()` to restore conversation history and credentials via `POST /resume`, then sends the follow-up message. The full flow: detect stopped container → broadcast "resuming" status → rebuild conversation history from SQLite → resolve fresh credentials from UserDO → POST /resume (with retry for container startup) → open event WS → wait for ready → POST /message.

**Verified:** E2E tested locally — create session → send message → wait for container sleep (1min) → send follow-up → container resumes → agent responds with full conversation context.

**Remaining limitation:** Workspace filesystem is still lost on container sleep (Phase 3 — R2 workspace snapshots). Resume does a fresh `git clone`, so uncommitted changes and installed dependencies are gone. Conversation history is fully preserved.

---

## Doppler: `zero-web/prd` uses test Clerk key

The `VITE_CLERK_PUBLISHABLE_KEY` in `zero-web/prd` is currently a copy of the dev/test key. When deploying to production, create a Clerk production instance and update this secret:

```bash
doppler secrets set VITE_CLERK_PUBLISHABLE_KEY="pk_live_..." --project zero-web --config prd
```

Same applies to `zero-api/prd` — `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` will need production values.
