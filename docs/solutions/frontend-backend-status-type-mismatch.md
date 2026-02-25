---
title: Frontend/Backend Status Type Mismatch
category: frontend
tags: [websocket, types, status, zero]
date: 2026-02-25
---

# Frontend/Backend Status Type Mismatch

## Problem

The backend `SessionStatus` type (in `@zero/core`) had a `"resuming"` variant, but the frontend's local `SessionStatus` type (in `session-types.ts`) did not. The WebSocket message handler in `SessionPage.tsx` also had an explicit allowlist filter:

```typescript
if (["ready", "running", "idle", "error", "starting", ...].includes(s))
```

When the backend broadcast `{ type: "status", status: "resuming" }`, the frontend silently dropped it — resulting in zero feedback during container resume (10-30s of limbo).

## Root Cause

Two separate `SessionStatus` types exist:
- **Backend** (`@zero/core`): The authoritative list including `pending`, `resuming`, `completed`, `failed`
- **Frontend** (`session-types.ts`): A subset with frontend-specific statuses like `creating`, `connecting`

The frontend maps some backend statuses to frontend equivalents (`pending` → `starting`, `failed` → `error`) but completely missed `resuming`.

## Solution

1. Added `"resuming"` to the frontend `SessionStatus` union type
2. Added `"resuming"` to the WS message handler's allowlist
3. Added `StatusBadge` config for the `resuming` state
4. Added UI feedback for the resuming state (empty state, waiting indicators)

## Lesson

When backend and frontend maintain separate type definitions for the same concept, new variants added to one side will be silently dropped by the other. **Always grep for the allowlist filter** when adding new status values to the backend — the frontend filter is a second gate beyond the type system.
