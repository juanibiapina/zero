# Zero — Tech Debt

Document known technical debt here: shortcuts, workarounds, temporary solutions, missing production hardening, or deferred improvements that should be addressed later.

---

### Steer not implemented

`SessionWrapper.steer()` in `packages/agent-server/src/session.ts` throws `"Steer not yet supported"`. The WebSocket protocol and route wiring exist end-to-end, but the agent-server doesn't implement the actual steer behavior.


