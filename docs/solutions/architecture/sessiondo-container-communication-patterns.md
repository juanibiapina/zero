---
title: "SessionDO ↔ Container Communication Patterns"
category: architecture
tags: [durable-objects, containers, websocket, cloudflare, session-management]
module: zero/api/SessionDO
severity: medium
date: 2026-02-25
---

# SessionDO ↔ Container Communication Patterns

## Problem

The SessionDO ↔ Container communication layer grew to 1000+ lines with 56 try/catch blocks, nested retry loops, inline resume logic, and recovery paths. The main `sendCommandToContainer()` method was ~100 lines with state detection, resume-and-retry, and 120-iteration readiness polling.

## Root Cause

Concerns were not separated. Command dispatch, container state detection, resume orchestration, event stream management, and error handling were all interleaved in one method. Recovery logic (for browser reconnect) was also inline in `fetch()`.

## Solution

### Key Insight: Separate command dispatch from lifecycle management

**Before**: One giant method handles everything:
```
sendCommandToContainer(type, payload)
  → detect state → resume → connect events → poll ready → send command → handle errors → retry
```

**After**: Each concern is its own method:
```
handleUserMessage(text)
  → persist → broadcast → ensureContainerRunning() → waitForReady() → postToContainer()
```

### Pattern: Extract lifecycle methods

| Method | Responsibility | Lines |
|---|---|---|
| `ensureContainerRunning()` | Check state, resume if needed, connect event stream | ~20 |
| `waitForReady()` | Simple timeout loop | ~12 |
| `resumeContainer()` | Linear resume flow: credentials → history → POST /resume → R2 | ~30 |
| `connectEventStream()` | Open WS with startup retry | ~20 |
| `postToContainer()` | Single HTTP POST helper | ~15 |
| `postToContainerWithRetry()` | POST with 404/503 retry for startup | ~20 |
| `resolveCredentials()` | Fetch API key + GitHub token + secrets | ~20 |

### Pattern: Remove recovery-on-connect

The old code ran `recoverActiveSession()` on every browser WebSocket connect if the status looked active. This was complex (40 lines) and fragile. Instead, recovery happens naturally when the user sends their next message via `ensureContainerRunning()`. Until then, the session shows its last known state. This is correct — if no one is sending messages, there's nothing to recover.

### Pattern: Remove unused SSE infrastructure

The agent-server had SSE streaming (`GET /events`), polling (`GET /events/poll`), and status (`GET /status`) endpoints that SessionDO never used — it only uses the WebSocket endpoint. Removing these eliminated ~90 lines and the `subscribe()` + `createSSEStream()` from EventBuffer.

## Key Constraint

**Container can't call SessionDO.** The agent-server process inside the container cannot initiate outbound calls to Cloudflare Workers/DOs. Only the DO can call the container via `getContainer().fetch()`. This means the ephemeral WS pattern (SessionDO connects to container) is required — you can't invert it to have the container call back.

## Results

| Metric | Before | After |
|---|---|---|
| SessionDO lines | 1002 | 704 |
| try/catch/loops | 56 | 31 |
| agent-server/server.ts | 444 | 254 |
| agent-server/events.ts | 165 | 93 |
| Total | 1984 | 1431 |

## Prevention

When adding new container communication features:
1. Keep each method focused on one concern (<30 lines)
2. Use the `ensureContainerRunning()` → `waitForReady()` → `postToContainer()` pattern
3. Don't inline retry/recovery logic — extract it
4. Don't add endpoints to agent-server unless SessionDO actually uses them
