# Zero — Tech Debt

Document known technical debt here: shortcuts, workarounds, temporary solutions, missing production hardening, or deferred improvements that should be addressed later.

---

### Unused `sessionIndexTable` in ProjectDO

The `session_index` table in `apps/api/src/ProjectDO/db/schema.ts` is defined and has migrations, but is never referenced from any code outside the schema file. Session listing was moved to UserDO's `sessions` table. The table and its schema definition should be removed in a future migration cleanup.

### Steer not implemented

`SessionWrapper.steer()` in `packages/agent-server/src/session.ts` throws `"Steer not yet supported"`. The WebSocket protocol and route wiring exist end-to-end, but the agent-server doesn't implement the actual steer behavior.

### Frontend-only status values not in `@zero/core` SessionStatus

The frontend uses `"creating"` and `"connecting"` as local status values (in `apps/web/src/pages/SessionPage.tsx`) that don't exist in `@zero/core`'s `SessionStatus` type. These are purely frontend states for session creation and WebSocket connection, but the type inconsistency means `StatusBadge` accepts `string` instead of `SessionStatus`.
